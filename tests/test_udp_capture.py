"""Real UDP relay checks; QUIC completes a handshake and echoes a stream."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import socket
import ssl
from types import SimpleNamespace

from aioquic.asyncio import connect, serve, QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import StreamDataReceived
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from mitmproxy.options import Options
from mitmproxy.tools.dump import DumpMaster

from backend.store import Store
from backend.tunnels import OpaqueNextLayer, TunnelCapture


@asynccontextmanager
async def udp_proxy(root, upstream_port):
    with socket.socket(type=socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    engine = SimpleNamespace(store=Store(root), config=SimpleNamespace(ssl_proxying=False),
                             generations={}, recording=True, publish=lambda message: None)
    recorder = TunnelCapture(engine)
    master = DumpMaster(Options(mode=[f'reverse:udp://127.0.0.1:{upstream_port}@127.0.0.1:{port}'],
                                confdir=str(root/'certificates')), with_termlog=False, with_dumper=False)
    master.addons.remove(master.addons.get('nextlayer'))
    master.addons.add(recorder, OpaqueNextLayer(engine))
    task = asyncio.create_task(master.run())
    try:
        for _ in range(200):
            if task.done():
                task.result()
            if any(server.is_running for server in master.addons.get('proxyserver').servers):
                break
            await asyncio.sleep(.01)
        else:
            raise AssertionError('UDP proxy did not start')
        yield port, engine, recorder
    finally:
        master.shutdown()
        await task
        recorder.flush()
        engine.store.db.close()


class QuicEcho(QuicConnectionProtocol):
    def quic_event_received(self, event):
        if isinstance(event, StreamDataReceived):
            self._quic.send_stream_data(event.stream_id, event.data, end_stream=event.end_stream)
            self.transmit()


def test_real_quic_handshake_and_stream_pass_through_without_decryption(tmp_path):
    async def run():
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'quic.example.test')])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1))
                .sign(key, hashes.SHA256()))
        config = QuicConfiguration(is_client=False, alpn_protocols=['chls-test'])
        config.certificate, config.private_key = cert, key
        upstream = await serve('127.0.0.1', 0, configuration=config, create_protocol=QuicEcho)
        upstream_port = upstream._transport.get_extra_info('sockname')[1]
        try:
            async with udp_proxy(tmp_path, upstream_port) as (port, engine, recorder):
                client_config = QuicConfiguration(is_client=True, alpn_protocols=['chls-test'],
                                                  server_name='quic.example.test', verify_mode=ssl.CERT_NONE)
                async with connect('127.0.0.1', port, configuration=client_config) as client:
                    reader, writer = await client.create_stream()
                    writer.write(b'opaque QUIC stream')
                    writer.write_eof()
                    await writer.drain()
                    assert await asyncio.wait_for(reader.read(), 5) == b'opaque QUIC stream'
                    recorder.flush()
                    records = engine.store.flows(engine.store.session)
                    assert len(records) == 1
                    item = records[0]
                    assert item['kind'] == 'connection' and item['protocol'] == 'QUIC'
                    assert item['host'] == 'quic.example.test'
                    assert item['bytes_sent'] > 18 and item['bytes_received'] > 18
                    assert 'method' not in item and 'url' not in item
        finally:
            upstream.close()
    asyncio.run(asyncio.wait_for(run(), 20))


def test_partial_dtls_datagram_is_forwarded_without_waiting_for_clienthello(tmp_path):
    class Echo(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport
        def datagram_received(self, data, addr):
            self.transport.sendto(data, addr)
    async def run():
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(Echo, local_addr=('127.0.0.1', 0))
        try:
            async with udp_proxy(tmp_path, transport.get_extra_info('sockname')[1]) as (port, engine, recorder):
                with socket.socket(type=socket.SOCK_DGRAM) as client:
                    client.setblocking(False)
                    packet = bytes.fromhex('16fefd0000000000000000001001')
                    await loop.sock_sendto(client, packet, ('127.0.0.1', port))
                    data, _ = await asyncio.wait_for(loop.sock_recvfrom(client, 4096), 3)
                    assert data == packet
                    recorder.flush()
                    item = engine.store.flows(engine.store.session)[0]
                    assert item['protocol'] == 'DTLS' and item['experimental'] is True
                    assert item['bytes_sent'] == item['bytes_received'] == len(packet)
        finally:
            transport.close()
    asyncio.run(asyncio.wait_for(run(), 10))
