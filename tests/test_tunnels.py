import asyncio
import ssl
from types import SimpleNamespace

import pytest
from mitmproxy import connection, tcp, udp
from mitmproxy.options import Options
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layer import NextLayer
from mitmproxy.proxy.layers import ServerTLSLayer, ClientTLSLayer, TCPLayer

from backend.__main__ import CaptureAddon
from backend.store import Store
from backend.tunnels import TunnelCapture, OpaqueNextLayer


@pytest.fixture
def capture(tmp_path):
    engine = SimpleNamespace(store=Store(tmp_path), generations={}, recording=True,
                             config=SimpleNamespace(ssl_proxying=False), publish=lambda message: None)
    addon = TunnelCapture(engine)
    yield engine, addon
    addon.done()
    engine.store.db.close()


def make_flow(datagram=False):
    client = connection.Client(peername=('127.0.0.1', 12345), sockname=('127.0.0.1', 8080),
                               transport_protocol='udp' if datagram else 'tcp')
    client.sni = 'example.test'
    server = connection.Server(address=('192.0.2.1', 443), transport_protocol=client.transport_protocol)
    flow = udp.UDPFlow(client, server) if datagram else tcp.TCPFlow(client, server)
    flow.metadata['connection_protocol'] = 'QUIC' if datagram else 'TLS'
    return flow


@pytest.mark.parametrize('datagram', [False, True])
def test_encrypted_counters_flush_without_retaining_payload_and_keep_original_session(capture, datagram):
    engine, addon = capture
    flow = make_flow(datagram)
    async def run():
        addon.tcp_start(flow)
        session = engine.store.session
        engine.recording = False
        engine.store.new_session()
        message_type = udp.UDPMessage if datagram else tcp.TCPMessage
        flow.messages.extend([message_type(True, b'ciphertext'), message_type(False, b'reply')])
        addon.tcp_message(flow)
        assert flow.messages == []
        await asyncio.sleep(.3)
        saved = engine.store.detail(flow.id)
        assert saved['bytes_sent'] == 10 and saved['bytes_received'] == 5
        assert saved['session'] == session and saved['state'] == 'open'
        assert saved['host'] == 'example.test'
        assert engine.store.flows(engine.store.session) == []
        addon.tcp_end(flow)
        addon.flush()
        assert engine.store.detail(flow.id)['state'] == 'closed'
        assert list((engine.store.root / 'bodies').iterdir()) == []
        # A connection opened on pause remains unrecorded after resuming.
        paused = make_flow(datagram)
        addon.tcp_start(paused)
        engine.recording = True
        addon.tcp_end(paused)
        addon.flush()
        assert engine.store.detail(paused.id) is None
    asyncio.run(run())


@pytest.mark.parametrize('delete', [False, True])
def test_late_tunnel_events_do_not_restore_cleared_or_deleted_sessions(capture, delete):
    engine, addon = capture
    flow = make_flow()
    async def run():
        addon.tcp_start(flow)
        session = engine.store.session
        flow.messages.append(tcp.TCPMessage(True, b'data'))
        addon.tcp_message(flow)
        engine.generations[session] = 1
        engine.store.clear(session)
        if delete:
            engine.store.db.execute('DELETE FROM sessions WHERE id=?', (session,))
            engine.store.db.commit()
        await asyncio.sleep(.3)
        addon.tcp_end(flow)
        assert engine.store.detail(flow.id) is None
    asyncio.run(run())


def test_partial_clienthello_selects_raw_relay_before_native_tls_layers(capture):
    engine, addon = capture
    flow = make_flow()
    context = Context(flow.client_conn, Options())
    context.server.address = flow.server_conn.address
    nextlayer = NextLayer(context)
    nextlayer.data_client = lambda: bytes.fromhex('1603010100010000fc03')
    selector = OpaqueNextLayer(engine)
    selector.next_layer(nextlayer)
    assert isinstance(nextlayer.layer, TCPLayer)
    assert context.layers == [nextlayer.layer]
    assert nextlayer.layer.flow.metadata['connection_protocol'] == 'TLS'


def test_one_transaction_flushes_many_active_connections(capture):
    engine, addon = capture
    commits = []
    engine.store.db.set_trace_callback(lambda sql: commits.append(sql) if sql == 'COMMIT' else None)
    async def run():
        for _ in range(100):
            flow = make_flow()
            addon.tcp_start(flow)
            flow.messages.append(tcp.TCPMessage(True, b'data'))
            addon.tcp_message(flow)
            addon.tcp_end(flow)
        addon.flush()
        assert len(engine.store.flows(engine.store.session)) == 100
        assert len(commits) == 1
    asyncio.run(run())


def test_legacy_history_is_read_as_connection_without_rewriting_database(capture):
    import json
    engine, _ = capture
    legacy = dict(id='legacy', session=engine.store.session, started=1, encrypted=True,
                  method='TLS', url='tls://example.test:443', host='example.test', port=443,
                  path='', status=None, rules=[], state='complete', transport='tcp',
                  request=None, response=None, size=30, bytes_sent=10, bytes_received=20)
    engine.store.save(legacy, legacy)
    item = engine.store.detail('legacy')
    assert item['kind'] == 'connection' and item['protocol'] == 'TLS'
    assert item['state'] == 'closed' and item['endpoint'] == 'example.test:443'
    assert all(key not in item for key in ('url', 'path', 'method', 'status', 'request'))
    stored = json.loads(engine.store.db.execute('SELECT detail FROM flows WHERE id=?', ('legacy',)).fetchone()[0])
    assert stored == legacy


@pytest.mark.parametrize('prefix', [b'\xc0\x01\x01\x00', b'\x16\xfe\x01\x00'])
def test_dns_is_delegated_even_when_transaction_id_resembles_tls_or_quic(capture, monkeypatch, prefix):
    from mitmproxy.addons.next_layer import NextLayer as NativeSelector
    engine, _ = capture
    flow = make_flow(datagram=True)
    context = Context(flow.client_conn, Options())
    context.server.address = ('10.0.0.53', 53)
    nextlayer = NextLayer(context)
    nextlayer.data_client = lambda: prefix + bytes(20)
    calls = []
    monkeypatch.setattr(NativeSelector, 'next_layer', lambda self, value: calls.append(value))
    OpaqueNextLayer(engine).next_layer(nextlayer)
    assert calls == [nextlayer]
    assert nextlayer.layer is None
