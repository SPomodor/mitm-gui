"""Opaque connection logging; protocol selection is isolated from recording."""
import asyncio
import time

from aioquic.buffer import Buffer
from aioquic.quic.packet import pull_quic_header, QuicPacketType

from mitmproxy import ctx, tcp, udp, flow as mitmflow
from mitmproxy.addons.next_layer import NextLayer
from mitmproxy.proxy.layers import TCPLayer, UDPLayer
from mitmproxy.proxy.layers.tls import parse_client_hello, dtls_parse_client_hello
from mitmproxy.proxy.layers.quic import quic_parse_client_hello_from_datagrams

from .hosts import choose_host
from .records import begin_recording, can_record
from .ssl_policy import should_decrypt
from mitmproxy.proxy.events import DataReceived

HELLO_LIMIT = 65536


class OpaqueNextLayer(NextLayer):
    """Choose a raw relay before native TLS layers are constructed."""
    name = 'nextlayer'

    def __init__(self, engine):
        self.engine = engine

    def load(self, loader):
        self.configure(set(ctx.options.keys()))

    def next_layer(self, nextlayer):
        context = nextlayer.context
        if nextlayer.layer:
            return
        if not context.client.tls_established and context.server.address and not (self.engine.config.ssl_proxying and getattr(self.engine.config, 'ssl_scope', 'all') == 'all'):
            data = nextlayer.data_client()
            udp = context.client.transport_protocol == 'udp'
            protocol = None
            version = b'\xfe' if udp else b'\x03'
            if udp and context.server.address[1] in (53, 5353):
                return super().next_layer(nextlayer)
            if data.startswith(b'\x16') and (len(data) == 1 or data[1:2] == version):
                protocol = 'DTLS' if udp else 'TLS'
            elif udp and data and data[0] & 0xc0 == 0xc0:
                try:
                    header = pull_quic_header(Buffer(data=data), host_cid_length=8)
                    if header.version in (0x00000001, 0x6b3343cf) and header.packet_type == QuicPacketType.INITIAL:
                        protocol = 'QUIC'
                except ValueError:
                    pass
            if protocol:
                destination, port = context.server.address
                decrypt = should_decrypt(self.engine.config, None, port, destination)
                if self.engine.config.ssl_proxying and not decrypt and getattr(self.engine.config, 'ssl_hosts', []):
                    hello = None
                    if len(data) <= HELLO_LIMIT and sum(isinstance(event, DataReceived) for event in nextlayer.events) <= 128:
                        try:
                            if protocol == 'QUIC':
                                parts = [event.data for event in nextlayer.events
                                         if isinstance(event, DataReceived) and event.connection == context.client]
                                hello = quic_parse_client_hello_from_datagrams(parts)
                            else:
                                hello = (dtls_parse_client_hello if udp else parse_client_hello)(data)
                            if hello is None:
                                self.engine.tunnels.watch_handshake(context, protocol, len(data))
                                return
                        except ValueError:
                            pass
                    if hello:
                        context.client.sni = hello.sni
                        decrypt = should_decrypt(self.engine.config, hello.sni, port, destination)
                pending = self.engine.tunnels.take_handshake(context) if hasattr(self.engine, 'tunnels') else None
                if decrypt:
                    if hasattr(self.engine, 'tunnels'):
                        self.engine.tunnels.decisions[context.client.id] = True
                    return super().next_layer(nextlayer)
                relay = UDPLayer(context) if udp else TCPLayer(context)
                if pending:
                    relay.flow.metadata.update(pending.metadata)
                relay.flow.metadata.update(connection_protocol=protocol,
                                           ssl_reason='disabled' if not self.engine.config.ssl_proxying else 'not_selected')
                nextlayer.layer = relay
                return
        super().next_layer(nextlayer)


class TunnelCapture:
    def __init__(self, engine):
        self.engine = engine
        self.dirty = {}
        self.timer = None
        self.handshakes = {}
        self.decisions = {}

    def watch_handshake(self, context, protocol, size):
        pending = self.handshakes.get(context.client.id)
        if pending is None:
            flow_type = udp.UDPFlow if context.client.transport_protocol == 'udp' else tcp.TCPFlow
            pending = flow_type(context.client, context.server)
            pending.metadata['connection_protocol'] = protocol
            self.prepare(pending)
            self.handshakes[context.client.id] = pending
        pending.metadata['pending_size'] = size

    def take_handshake(self, context):
        return self.handshakes.pop(context.client.id, None)

    def client_disconnected(self, client):
        self.decisions.pop(client.id, None)
        pending = self.handshakes.pop(client.id, None)
        if pending:
            pending.metadata['bytes_sent'] = pending.metadata.pop('pending_size', 0)
            pending.metadata['ssl_reason'] = 'not_selected'
            pending.error = mitmflow.Error('TLS handshake incomplete: host selection was not resolved')
            self.record(pending, ended=True)

    def prepare(self, flow):
        if 'connection_started' not in flow.metadata:
            begin_recording(self.engine, flow)
            flow.metadata.update(connection_started=time.time(), connection_clock=time.monotonic(),
                                 bytes_sent=0, bytes_received=0, hello_parts=[], hello_size=0)

    def tcp_start(self, flow):
        if 'connection_protocol' not in flow.metadata:
            return
        self.prepare(flow)
        self.record(flow)

    udp_start = tcp_start

    def observe_hello(self, flow, data):
        metadata = flow.metadata
        if metadata.get('hello_done'):
            return
        metadata['hello_size'] += len(data)
        if metadata['hello_size'] > HELLO_LIMIT or len(metadata['hello_parts']) >= 128:
            metadata.update(hello_done=True, hello_parts=[])
            return
        metadata['hello_parts'].append(data)
        protocol = metadata['connection_protocol']
        try:
            if protocol == 'QUIC':
                hello = quic_parse_client_hello_from_datagrams(metadata['hello_parts'])
            else:
                parser = dtls_parse_client_hello if protocol == 'DTLS' else parse_client_hello
                hello = parser(b''.join(metadata['hello_parts']))
        except ValueError:
            metadata.update(hello_done=True, hello_parts=[])
            return
        if hello:
            flow.client_conn.sni = hello.sni
            metadata.update(hello_done=True, hello_parts=[])

    def tcp_message(self, flow):
        if 'connection_started' not in flow.metadata:
            return
        for message in flow.messages:
            key = 'bytes_sent' if message.from_client else 'bytes_received'
            flow.metadata[key] += len(message.content)
            if message.from_client:
                self.observe_hello(flow, message.content)
        # The relay keeps its current message until SendData. No payload log.
        flow.messages.clear()
        self.record(flow)

    udp_message = tcp_message

    def tcp_end(self, flow):
        self.record(flow, ended=True)
        flow.metadata.pop('hello_parts', None)

    udp_end = tcp_end
    tcp_error = tcp_end
    udp_error = tcp_end

    def record(self, flow, ended=False):
        if ('connection_started' not in flow.metadata or not flow.metadata.get('recording')
                or flow.metadata.get('generation') != self.engine.generations.get(flow.metadata['session'], 0)):
            return
        metadata = flow.metadata
        destination, port = flow.server_conn.address
        host = choose_host(flow.client_conn.sni, destination)
        authority = f'[{host}]' if ':' in host else host
        error = str(flow.error) if flow.error else None
        summary = dict(kind='connection', id=flow.id, session=metadata['session'],
                       started=metadata['connection_started'], protocol=metadata['connection_protocol'],
                       endpoint=f'{authority}:{port}', host=host, destination_host=destination, port=port,
                       duration=round((time.monotonic()-metadata['connection_clock'])*1000) if ended else None,
                       size=metadata['bytes_sent']+metadata['bytes_received'],
                       bytes_sent=metadata['bytes_sent'], bytes_received=metadata['bytes_received'],
                       client=str(flow.client_conn.peername[0]) if flow.client_conn.peername else '',
                       error=error, state='error' if error else 'closed' if ended else 'open',
                       transport=flow.client_conn.transport_protocol,
                       experimental=flow.client_conn.transport_protocol == 'udp',
                       ssl_reason=metadata.get('ssl_reason', 'disabled'))
        self.dirty[flow.id] = (flow, summary)
        if self.timer is None:
            self.timer = asyncio.get_running_loop().call_later(.25, self.flush)

    def flush(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None
        records = [summary for flow, summary in self.dirty.values() if can_record(self.engine, flow)]
        self.dirty.clear()
        if records:
            self.engine.store.save_many([(item, item) for item in records])
            for item in records:
                self.engine.publish({'type': 'flow', **item})

    def done(self):
        for pending in list(self.handshakes.values()):
            self.client_disconnected(pending.client_conn)
        self.flush()
