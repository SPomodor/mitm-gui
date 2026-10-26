"""End-to-end checks against real mitmproxy TCP/UDP listeners and an upstream."""
import contextlib
import gzip
import http.server
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
import time

import httpx
import pytest


def free_port(kind=socket.SOCK_STREAM):
    with socket.socket(type=kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def engine_command():
    if os.environ.get('CHLS_TEST_ENGINE'):
        return [os.environ['CHLS_TEST_ENGINE']]
    return [sys.executable, '-m', 'backend']


def startup_failure(message, log_path):
    detail = message + '\n' + log_path.read_text('utf-8')
    if os.environ.get('GITHUB_ACTIONS'):
        escaped = detail[-3500:].replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print(f'::error title=Engine startup::{escaped}', flush=True)
    pytest.fail(detail)


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/slow-clear'):
            time.sleep(2)
        data = json.dumps({'enabled': False, 'path': self.path, 'header': self.headers.get('X-Debug'), 'items': [1, 2]}).encode()
        compressed = self.path.startswith('/gzip')
        if compressed:
            data = gzip.compress(data)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        if compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


@pytest.fixture(scope='module')
def environment(tmp_path_factory):
    root = tmp_path_factory.mktemp('engine')
    api_port, proxy_port, wg_port = free_port(), free_port(), free_port(socket.SOCK_DGRAM)
    (root / 'capture.json').write_text(json.dumps({'http': True, 'wireguard': True, 'port': proxy_port, 'wg_port': wg_port, 'lan': False}), encoding='utf-8')
    log = (root / 'log.txt').open('w', encoding='utf-8')
    command = engine_command()
    process = subprocess.Popen([*command, '--port', str(api_port)], env={**os.environ, 'CHLS_TOKEN': 'integration-secret', 'CHLS_DATA': str(root)}, stdout=log, stderr=log)
    # macOS runners may configure system proxies. Management traffic must stay local.
    client = httpx.Client(base_url=f'http://127.0.0.1:{api_port}', headers={'Authorization': 'Bearer integration-secret'}, timeout=15, trust_env=False)
    try:
        last_status = 'not contacted'
        for _ in range(150):
            if process.poll() is not None:
                pytest.fail((root / 'log.txt').read_text('utf-8'))
            try:
                response = client.get('/status', timeout=.5)
                last_status = f'{response.status_code}: {response.text[:500]}'
                if response.status_code == 200:
                    break
            except httpx.TransportError as error:
                last_status = repr(error)
            time.sleep(.1)
        else:
            startup_failure(f'Engine startup timed out; last API response: {last_status}', root / 'log.txt')
        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        yield client, proxy_port, wg_port, f'http://127.0.0.1:{upstream.server_port}', root
        upstream.shutdown()
    finally:
        with contextlib.suppress(Exception):
            client.post('/capture/stop')
        client.close()
        process.terminate()
        process.wait(timeout=15)
        log.close()


def rule(id, kind='rewrite', **kwargs):
    return {'id': id, 'name': id, 'kind': kind, 'host': '127.0.0.1', **kwargs}


def test_real_capture_rules_and_wireguard(environment):
    client, port, wg_port, upstream, root = environment
    initial = client.get('/status').json()
    assert initial['running'] is True
    assert client.get('/flows').json() == []
    assert httpx.get(str(client.base_url).rstrip('/') + '/status', trust_env=False).status_code == 401
    response = client.post('/capture/start', json={'http': True, 'wireguard': True, 'port': port, 'wg_port': wg_port, 'lan': False})
    assert response.status_code == 200, response.text
    assert response.json()['session'] == initial['session']
    assert response.json()['running']
    assert {s['type'] for s in response.json()['servers']} == {'regular', 'wireguard'}
    profile = client.get('/wireguard', params={'endpoint': '192.168.1.20'}).json()['config']
    assert f'Endpoint = 192.168.1.20:{wg_port}' in profile
    assert 'PrivateKey =' in profile and 'PublicKey =' in profile
    assert 'wireguard_conf' not in client.get('/status').text
    assert client.get('/certificate').content.startswith(b'-----BEGIN CERTIFICATE-----')
    file = root / 'mock.json'
    file.write_text('{"enabled": false, "local": true}', encoding='utf-8')
    rules = [
        rule('request-header', phase='request', action='header', key='X-Debug', value='chls'),
        rule('block', 'block', path='/blocked', status=451),
        rule('local', 'map_local', path='/mock', file=str(file)),
        {'id': 'offline', 'name': 'offline HTTPS', 'kind': 'map_local', 'host': 'offline.invalid', 'file': str(file)},
        {'id': 'domain', 'name': 'domain via IP', 'kind': 'block', 'host': 'api.example.test', 'path': '/domain', 'status': 418},
        rule('json', phase='response', action='json', key='enabled', value='true'),
        rule('response-header', phase='response', action='header', key='X-CHLS', value='applied'),
    ]
    response = client.put('/rules', json=rules)
    assert response.status_code == 200, response.text
    tls_context = ssl.create_default_context(cafile=str(root / 'certificates' / 'mitmproxy-ca-cert.pem'))
    with httpx.Client(proxy=f'http://127.0.0.1:{port}', verify=tls_context) as tls_proxy:
        # A real CONNECT + TLS handshake to an origin that cannot resolve.
        # The proxy certificate is verified, not bypassed with verify=False.
        result = tls_proxy.get('https://offline.invalid/mock')
        assert result.status_code == 200 and result.json()['local'] is True
    with httpx.Client(proxy=f'http://127.0.0.1:{port}') as proxy:
        result = proxy.get(upstream + '/domain', headers={'Host': 'api.example.test'})
        assert result.status_code == 418
        domain_flow = next(f for f in client.get('/flows').json() if f.get('path') == '/domain')
        assert domain_flow['host'] == 'api.example.test'
        assert 'api.example.test/domain' in domain_flow['url']
        assert domain_flow['destination_host'] == '127.0.0.1'
        result = proxy.get(upstream + '/api')
        assert result.status_code == 200
        assert result.json()['enabled'] is True
        assert result.json()['header'] == 'chls'
        assert result.headers['x-chls'] == 'applied'
        result = proxy.get(upstream + '/mock')
        assert result.json() == {'enabled': True, 'local': True}
        file.write_text('{"enabled": false, "changed": true}', encoding='utf-8')
        assert proxy.get(upstream + '/mock').json()['changed']
        result = proxy.get(upstream + '/blocked')
        assert result.status_code == 451
        result = proxy.get(upstream + '/gzip')
        assert result.json()['enabled'] is True
        flows = client.get('/flows').json()
        gzip_flow = next(f for f in flows if f.get('path') == '/gzip')
        detail = client.get('/flows/' + gzip_flow['id']).json()
        assert json.loads(detail['response']['text'])['enabled'] is True
        assert json.loads(detail['original_response']['text'])['enabled'] is False
        assert len(detail['rules']) == 3
        # Stop while an HTTP client's keepalive connection is still open.
        response = client.post('/capture/stop')
        assert response.status_code == 200, response.text
        assert response.json()['running'] is False
    assert len(flows) >= 5
    assert (root / 'rules.json').exists()
    assert client.get('/wireguard').status_code == 409
    for _ in range(3):
        assert client.post('/capture/start', json={'http': True, 'wireguard': True, 'port': port, 'wg_port': wg_port, 'lan': False}).status_code == 200
        assert client.post('/capture/stop').status_code == 200


def test_independent_rule_editor_saves(environment):
    client, *_ = environment
    original = client.get('/rules').json()
    try:
        first = rule('editor-first', value='one', key='X-Debug')
        second = rule('editor/second ? imported', value='two', key='X-Debug')
        assert client.post('/rules/save', json=first).status_code == 200
        assert client.post('/rules/save', json=second).status_code == 200
        first['value'] = 'updated'
        saved = client.post('/rules/save', json=first).json()
        assert next(r for r in saved if r['id'] == second['id'])['value'] == 'two'
        assert next(r for r in saved if r['id'] == 'editor-first')['value'] == 'updated'
        assert [r['id'] for r in saved[:len(original)]] == [r['id'] for r in original]
        assert client.post('/rules/save', json={**first, 'id': ''}).status_code == 422
        assert client.post('/rules/save', json={**first, 'match': 'regex', 'path': '['}).status_code == 422
    finally:
        client.put('/rules', json=original)


def test_validation_sessions_and_failed_ports(environment):
    client, port, wg_port, upstream, root = environment
    assert client.put('/rules', json=[rule('bad', action='json', key='x', value='not-json')]).status_code == 422
    assert client.put('/rules', json=[rule('bad', match='regex', path='[')]).status_code == 422
    assert client.put('/rules', json=[rule('bad', 'map_local', file=str(root / 'missing'))]).status_code == 422
    assert client.put('/rules', json=[rule('same'), rule('same')]).status_code in (400, 422)
    old = client.get('/status').json()['session']
    new = client.post('/sessions').json()['id']
    assert old != new
    assert client.get('/flows').json() == []
    assert len(client.get('/flows', params={'session': old}).json()) >= 5
    assert client.put(f'/sessions/{old}', json={'name': '  Debug phone  '}).status_code == 200
    assert next(s for s in client.get('/sessions').json() if s['id'] == old)['name'] == 'Debug phone'
    for invalid in ('', '   ', 'line\nline', 'x' * 121):
        assert client.put(f'/sessions/{old}', json={'name': invalid}).status_code == 422
    assert client.put('/sessions/missing', json={'name': 'Unknown'}).status_code == 404
    archive = client.get(f'/sessions/{old}/export')
    assert archive.status_code == 200, archive.text
    assert len(archive.json()['log']['entries']) == len(client.get('/flows', params={'session': old}).json())
    assert client.get(f'/sessions/{new}/export').json()['log']['entries'] == []
    assert client.get('/sessions/missing/export').status_code == 404
    assert client.delete('/flows', params={'session': old}).status_code == 200
    assert client.get('/flows', params={'session': old}).json() == []
    with socket.socket() as occupied:
        occupied.bind(('127.0.0.1', 0))
        occupied.listen()
        result = client.post('/capture/start', json={'port': occupied.getsockname()[1], 'lan': False})
        assert result.status_code == 409, result.text
        assert client.get('/status').json()['running'] is False
    assert client.post('/capture/start', json={'port': port, 'lan': False}).status_code == 200
    assert client.post('/capture/stop').status_code == 200


@contextlib.contextmanager
def restarted_engine(root, api_port):
    command = engine_command()
    with (root / 'restart.log').open('a', encoding='utf-8') as log:
        process = subprocess.Popen([*command, '--port', str(api_port)], env={**os.environ, 'CHLS_TOKEN': 'restart-secret', 'CHLS_DATA': str(root)}, stdout=log, stderr=log)
        client = httpx.Client(base_url=f'http://127.0.0.1:{api_port}', headers={'Authorization': 'Bearer restart-secret'}, timeout=10, trust_env=False)
        try:
            last_status = 'not contacted'
            for _ in range(150):
                if process.poll() is not None:
                    pytest.fail((root / 'restart.log').read_text('utf-8'))
                try:
                    response = client.get('/status', timeout=.5)
                    last_status = f'{response.status_code}: {response.text[:500]}'
                    if response.status_code == 200:
                        break
                except httpx.TransportError as error:
                    last_status = repr(error)
                time.sleep(.1)
            else:
                startup_failure(f'Restart timed out; last API response: {last_status}', root / 'restart.log')
            yield client
        finally:
            with contextlib.suppress(Exception):
                client.post('/capture/stop')
            client.close()
            process.terminate()
            process.wait(timeout=15)


def test_advanced_rewrite_chain_with_real_routing_and_status(environment):
    client, port, wg_port, upstream, root = environment
    assert client.post('/capture/start', json={'http': True, 'wireguard': False, 'port': port, 'lan': False}).status_code == 200
    def advanced(id, action, phase='request', **spec):
        return {'id': id, 'name': id, 'kind': 'rewrite', 'host': 'unreachable.invalid', 'phase':phase, 'action':action, 'rewrite':spec}
    rules = [
        advanced('route','url',search_value=r'^http://unreachable\.invalid/original',replacement_value=upstream+'/new',regex=True),
        advanced('path','path',search_value='/new',replacement_value='/final'),
        advanced('query','query_modify',search_name='token',search_value='old',replacement_name='auth',replacement_value='new',whole_value=True),
        advanced('query-add','query_add',replacement_name='debug',replacement_value='yes'),
        advanced('status','status','response',search_value='200',replacement_value='404',whole_value=True),
        advanced('body','body','response',search_value=r'("enabled":\s*)false',replacement_value='$1true',regex=True),
        advanced('header','header_modify','response',search_name='Content-Type',search_value='application/json',replacement_value='application/problem+json',whole_value=True),
    ]
    result=client.put('/rules',json=rules)
    assert result.status_code==200, result.text
    with httpx.Client(proxy=f'http://127.0.0.1:{port}') as proxy:
        result=proxy.get('http://unreachable.invalid/original?token=old&token=keep')
        assert result.status_code==404
        assert result.headers['content-type']=='application/problem+json'
        assert result.json()['enabled'] is True
        assert result.json()['path']=='/final?auth=new&token=keep&debug=yes'
    latest=client.get('/flows').json()[0]
    assert latest['status']==404
    assert latest['original_host']=='unreachable.invalid'
    assert latest['original_path']=='/original?token=old&token=keep'
    assert len(latest['rules'])==7
    assert all(r.get('matched') is True and not r.get('error') for r in latest['rules'])
    from urllib.parse import urlsplit
    host_rule = advanced('host-only', 'host', search_value='unreachable.invalid', replacement_value='127.0.0.1')
    assert client.put('/rules',json=[host_rule]).status_code == 200
    with httpx.Client(proxy=f'http://127.0.0.1:{port}') as proxy:
        result = proxy.get(f'http://unreachable.invalid:{urlsplit(upstream).port}/host-only')
        assert result.status_code == 200 and result.json()['path'] == '/host-only'
        assert client.put('/rules',json=[host_rule, advanced('empty-status','status','response',replacement_value='204')]).status_code == 200
        for _ in range(2):
            result = proxy.get(f'http://unreachable.invalid:{urlsplit(upstream).port}/empty')
            assert result.status_code == 204 and result.content == b''
    assert client.post('/capture/stop').status_code==200


def test_new_launch_creates_session_and_starts_capture_with_previous_settings(tmp_path):
    api_port, proxy_port = free_port(), free_port()
    (tmp_path / 'capture.json').write_text(json.dumps({'http': True, 'wireguard': False, 'port': proxy_port, 'lan': False}), encoding='utf-8')
    file = tmp_path / 'mock.json'
    file.write_text('{"restart": true}', encoding='utf-8')
    with restarted_engine(tmp_path, api_port) as client:
        status = client.get('/status').json()
        assert status['running'] is True
        first_session = status['session']
        assert client.put('/rules', json=[{'id': 'restart-mock', 'name': 'preserved', 'kind': 'map_local', 'file': str(file)}]).status_code == 200
        with httpx.Client(proxy=f'http://127.0.0.1:{proxy_port}') as proxy:
            assert proxy.get('http://restart.invalid/check').json() == {'restart': True}
        assert len(client.get('/flows').json()) == 1
        # Even if the user stopped before closing, the next launch records again.
        assert client.post('/capture/stop').json()['running'] is False
    with restarted_engine(tmp_path, api_port) as client:
        status = client.get('/status').json()
        assert status['running'] is True
        assert status['config']['port'] == proxy_port
        assert status['session'] != first_session
        assert len(client.get('/sessions').json()) == 2
        listed = client.get('/sessions').json()
        assert next(s for s in listed if s['id'] == first_session)['archived'] is True
        assert next(s for s in listed if s['id'] == status['session'])['archived'] is False
        assert client.get('/flows').json() == []
        assert len(client.get('/flows', params={'session': first_session}).json()) == 1
        assert client.get('/rules').json()[0]['id'] == 'restart-mock'
        with httpx.Client(proxy=f'http://127.0.0.1:{proxy_port}') as proxy:
            assert proxy.get('http://restart.invalid/check').json() == {'restart': True}
        assert client.get('/flows').json()[0]['session'] == status['session']
        assert client.post('/sessions/close').status_code == 200
        assert all(s['archived'] for s in client.get('/sessions').json())


def test_occupied_port_on_autostart_keeps_management_api_available(tmp_path):
    api_port = free_port()
    with socket.socket() as occupied:
        occupied.bind(('127.0.0.1', 0))
        occupied.listen()
        (tmp_path / 'capture.json').write_text(json.dumps({'http': True, 'wireguard': False, 'port': occupied.getsockname()[1], 'lan': False}), encoding='utf-8')
        with restarted_engine(tmp_path, api_port) as client:
            status = client.get('/status').json()
            assert status['running'] is False
            assert status['errors'] and 'автоматически' in status['errors'][0]
            assert len(client.get('/sessions').json()) == 1


def test_mock_module_real_http_tls_stage_priority_and_failed_apply(environment):
    client, port, _, upstream, root = environment
    previous = client.get('/rules').json()
    source = '''from chls import Script, Scenario, response
app = Script("Интеграция", hosts=["127.0.0.1", "offline.invalid"], path_prefix="/driver/", unmatched="block")
order = Scenario("order", initial="Собирается")
app.use(order)
@app.get("/driver/state")
def shared(request, ctx):
    return response(200, json={"active": True})
@order.get("/driver/order/info", state="Собирается")
def collecting(request, ctx):
    return response(200, file="mock-order.json")
@order.get("/driver/order/info", state="Завершён")
def complete(request, ctx):
    return response(200, json={"status": "completed"})
@order.get("/driver/state", state="Завершён")
def completed_state(request, ctx):
    return response(200, json={"active": False})
'''
    (root / 'mock-order.json').write_text('{"status":"assembling"}', 'utf-8')
    document = dict(source=source, folder=str(root))
    try:
        assert client.post('/capture/start', json={'port': port, 'lan': False}).status_code == 200
        assert client.get('/mocks').json()['enabled'] is False
        invalid_hosts = client.post('/mocks/validate', json={**document, 'source': source + '\napp.hosts = [\"https://invalid/path\"]'})
        assert invalid_hosts.status_code == 422
        assert 'домен' in invalid_hosts.json()['detail']
        assert client.post('/mocks/validate', json={**document, 'hosts': ['*']}).status_code == 422
        assert client.post('/mocks/validate', json=document).status_code == 200
        assert client.get('/mocks').json()['stages'] == []
        assert client.put('/mocks', json=document).status_code == 200
        # Response Rewrite must not change a mock's response.
        assert client.put('/rules', json=[rule('interfering-status', action='status', phase='response', rewrite={'replacement_value': '418'})]).status_code == 200
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
            assert proxy.get(upstream + '/driver/order/info').status_code == 418
            assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
            for i in range(3):
                response = proxy.get(upstream + '/driver/order/info', params={'poll': i})
                assert response.status_code == 200 and response.json()['status'] == 'assembling'
            assert client.get('/mocks').json()['stage'] == 'Собирается'
            assert proxy.get(upstream + '/driver/missing').status_code == 501
            assert proxy.get(upstream + '/outside').status_code == 418
            failed = client.put('/mocks', json={**document, 'source': source.replace('mock-order.json', 'missing.json')})
            assert failed.status_code == 422 and 'missing.json' in failed.json()['detail']
            assert proxy.get(upstream + '/driver/order/info').json()['status'] == 'assembling'
            assert client.post('/mocks/control', json={'action': 'stage', 'stage': 'Завершён'}).status_code == 200
            assert proxy.get(upstream + '/driver/order/info').json()['status'] == 'completed'
            assert proxy.get(upstream + '/driver/state').json()['active'] is False
            assert client.post('/mocks/control', json={'action': 'stage', 'stage': 'missing'}).status_code == 422
            context = ssl.create_default_context(cafile=str(root / 'certificates' / 'mitmproxy-ca-cert.pem'))
            with httpx.Client(proxy=f'http://127.0.0.1:{port}', verify=context, trust_env=False) as tls_proxy:
                assert tls_proxy.get('https://offline.invalid/driver/order/info').json()['status'] == 'completed'
            flows = client.get('/flows').json()
            mocked = next(f for f in flows if f['host'] == 'offline.invalid')
            assert client.get('/flows/' + mocked['id']).json()['mock']['stage'] == 'Завершён'
            assert client.post('/mocks/control', json={'action': 'reset'}).json()['stage'] == 'Собирается'
            assert client.post('/mocks/control', json={'action': 'disable'}).status_code == 200
            assert proxy.get(upstream + '/driver/order/info').status_code == 418
            assert client.put('/mocks', json={**document, 'source': source + '\napp.hosts = [\"*\"]'}).status_code == 200
            assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
            assert proxy.get('http://new-domain.invalid/driver/order/info').json()['status'] == 'assembling'
            assert proxy.get('http://other-domain.invalid/driver/order/info').json()['status'] == 'assembling'
            assert proxy.get('http://new-domain.invalid/driver/unknown').status_code == 501
    finally:
        client.post('/mocks/control', json={'action': 'disable'})
        client.put('/rules', json=previous)


def test_python_transitions_explicit_responses_and_repeated_requests(environment):
    client, port, _, upstream, _ = environment
    source = '''from chls import Script, Scenario, response
app = Script("Переходы", path_prefix="/driver/")
order = Scenario("order", initial="start")
app.use(order)
@app.get("/driver/info")
def info(request, ctx):
    return response(200, json={"stage": ctx.stage, "count": ctx.state.get("count", 0)})
@order.post("/driver/confirm", state="start")
def start(request, ctx):
    ctx.goto("confirmed")
    return response(201, json={"accepted": True})
@order.post("/driver/confirm", state="confirmed")
def confirm(request, ctx):
    ctx.state["count"] = ctx.state.get("count", 0) + 1
    return response(409, json={"repeat": True})
'''
    document = dict(source=source, folder='')
    try:
        assert client.put('/mocks', json=document).status_code == 200
        assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
            assert proxy.post(upstream + '/driver/confirm').status_code == 201
            for _ in range(2):
                assert proxy.post(upstream + '/driver/confirm', headers={'Idempotency-Key': 'same'}).status_code == 409
            assert proxy.get(upstream + '/driver/info').json() == {'stage': 'confirmed', 'count': 2}
            assert client.get('/mocks').json()['state'] == {'count': 2}
            assert client.post('/mocks/control', json={'action': 'reset'}).json()['state'] == {}
            assert proxy.get(upstream + '/driver/info').json()['stage'] == 'start'
            assert client.post('/mocks/control', json={'action': 'mode', 'mode': 'scenario'}).status_code == 422
    finally:
        client.post('/mocks/control', json={'action': 'disable'})


def test_scripts_forward_gzip_json_and_timeout_keep_api_responsive(environment):
    from concurrent.futures import ThreadPoolExecutor
    client, port, _, upstream, _ = environment
    previous = client.get('/rules').json()
    source = f'''from chls import Script
app = Script("Forward and timeout", path_prefix="/script/")
@app.get("/script/forward")
def forward(request, ctx):
    request.url = {upstream + '/gzip'!r}
    request.headers["X-Debug"] = "script"
    ctx.state["forwarded"] = True
    return None
@app.get("/script/hang")
def hang(request, ctx):
    ctx.state["bad"] = True
    while True:
        pass
@app.on_response
def change(request, reply, ctx):
    reply.json.set("enabled", True)
    reply.headers["X-Script"] = "yes"
'''
    try:
        client.put('/rules', json=[])
        assert client.put('/mocks', json=dict(source=source, folder='')).status_code == 200
        client.post('/mocks/control', json={'action': 'enable'})
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False, timeout=10) as proxy:
            reply = proxy.get(upstream + '/script/forward')
            assert reply.json()['enabled'] is True and reply.json()['header'] == 'script'
            assert reply.headers['content-encoding'] == 'gzip' and reply.headers['X-Script'] == 'yes'
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(proxy.get, upstream + '/script/hang')
                time.sleep(.15)
                started = time.monotonic()
                assert client.get('/status').status_code == 200
                assert time.monotonic() - started < 1
                assert httpx.get(upstream + '/outside', proxy=f'http://127.0.0.1:{port}', trust_env=False).status_code == 200
                assert pending.result().status_code == 500
            status = client.get('/mocks').json()
            assert status['state'] == {'forwarded': True}
            assert 'время выполнения' in status['load_error']
    finally:
        client.post('/mocks/control', json={'action': 'disable'})
        client.put('/rules', json=previous)


def test_ctx_stop_current_reply_upstream_response_and_enable_again(environment):
    client, port, _, upstream, _ = environment
    previous = client.get('/rules').json()
    source = '''from chls import Script, response
app = Script("Stop from script", path_prefix="/script/")
@app.get("/script/stop")
def stop(request, ctx):
    ctx.state["calls"] = ctx.state.get("calls", 0) + 1
    ctx.stop()
    return response(201, json={"calls": ctx.state["calls"]})
@app.on_response
def change(request, reply, ctx):
    if request.path == "/script/stop":
        raise RuntimeError("Must be skipped after request stop")
    reply.json.set("enabled", True)
    ctx.stop()
'''
    try:
        client.put('/rules', json=[])
        assert client.put('/mocks', json=dict(source=source, folder='')).status_code == 200
        client.post('/mocks/control', json={'action': 'enable'})
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
            reply = proxy.get(upstream + '/script/stop')
            assert reply.status_code == 201 and reply.json() == {'calls': 1}
            status = client.get('/mocks').json()
            assert not status['enabled'] and status['state'] == {'calls': 1}
            assert status['logs'][0]['stopped'] is True
            assert proxy.get(upstream + '/script/stop').json()['enabled'] is False
            assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
            assert proxy.get(upstream + '/script/stop').json() == {'calls': 2}
            client.post('/mocks/control', json={'action': 'enable'})
            assert proxy.get(upstream + '/script/response-stop').json()['enabled'] is True
            status = client.get('/mocks').json()
            assert not status['enabled'] and status['logs'][0]['phase'] == 'response'
    finally:
        client.post('/mocks/control', json={'action': 'disable'})
        client.put('/rules', json=previous)


def test_recording_clear_delete_query_and_ssl(environment):
    from concurrent.futures import ThreadPoolExecutor
    client, port, _, upstream, root = environment
    assert client.post('/capture/start', json={'port': port, 'lan': False}).status_code == 200
    client.post('/mocks/control', json={'action': 'disable'})
    session = client.post('/sessions').json()['id']
    assert client.put('/rules', json=[rule('query-block', 'block', path='/report', query='encrypted_request=1', match='exact', status=418)]).status_code == 200
    with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
        assert client.post('/recording', json={'enabled': False}).json()['running'] is True
        assert proxy.get(upstream + '/report?encrypted_request=1').status_code == 418
        assert proxy.get(upstream + '/report?encrypted_request=2').status_code == 200
        assert client.get('/flows').json() == []
        assert client.post('/recording', json={'enabled': True}).json()['recording'] is True
        assert proxy.get(upstream + '/report?encrypted_request=1').status_code == 418
        assert len(client.get('/flows').json()) == 1
    with ThreadPoolExecutor() as pool:
        future = pool.submit(httpx.get, upstream + '/slow-clear', proxy=f'http://127.0.0.1:{port}')
        for _ in range(200):
            if any(f.get('path') == '/slow-clear' for f in client.get('/flows').json()):
                break
            time.sleep(.02)
        else:
            pytest.fail('No pending request was captured')
        removed_ids = [f['id'] for f in client.get('/flows').json()]
        assert client.delete('/flows', params={'session': session}).status_code == 200
        assert future.result().status_code == 200
        assert client.get('/flows').json() == []
        assert not any(p.name.startswith(tuple(removed_ids)) for p in (root / 'bodies').iterdir())
    assert client.delete(f'/sessions/{session}').status_code == 409
    with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
        assert proxy.get(upstream + '/stored-before-delete').status_code == 200
    saved_id = client.get('/flows').json()[0]['id']
    assert list((root / 'bodies').glob(saved_id + '-*'))
    client.post('/sessions')
    assert client.delete(f'/sessions/{session}').status_code == 200
    assert client.get(f'/flows/{saved_id}').status_code == 404
    assert not list((root / 'bodies').glob(saved_id + '-*'))
    assert not any(s['id'] == session for s in client.get('/sessions').json())
    assert client.get(f'/sessions/{session}/export').status_code == 404
    assert client.delete('/sessions/missing').status_code == 404

    tls_origin = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(root / 'certificates' / 'mitmproxy-ca.pem'))
    tls_origin.socket = context.wrap_socket(tls_origin.socket, server_side=True)
    thread = threading.Thread(target=tls_origin.serve_forever, daemon=True)
    thread.start()
    try:
        assert client.put('/rules', json=[rule('ssl-block', 'block', path='/ssl-check', query='', match='exact', status=418)]).status_code == 200
        assert client.post('/capture/ssl', json={'enabled': False}).json()['config']['ssl_proxying'] is False
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', verify=False, trust_env=False) as proxy:
            assert proxy.get(f'https://127.0.0.1:{tls_origin.server_port}/ssl-check').status_code == 200
            assert not any(f.get('path') == '/ssl-check' for f in client.get('/flows').json())
            for _ in range(100):
                tunnels = [f for f in client.get('/flows').json() if f.get('kind') == 'connection']
                if tunnels and tunnels[0]['state'] == 'closed':
                    break
                time.sleep(.02)
            assert len(tunnels) == 1
            tunnel = tunnels[0]
            assert tunnel['protocol'] == 'TLS'
            assert tunnel['port'] == tls_origin.server_port
            assert tunnel['bytes_sent'] > 0 and tunnel['bytes_received'] > 0
            assert tunnel['size'] == tunnel['bytes_sent'] + tunnel['bytes_received']
            assert tunnel['state'] == 'closed' and tunnel['duration'] is not None
            assert 'status' not in tunnel and 'rules' not in tunnel and 'method' not in tunnel
            detail = client.get(f"/flows/{tunnel['id']}").json()
            assert 'request' not in detail and 'response' not in detail
            assert client.get(f"/flows/{tunnel['id']}/body/request").status_code == 404
            assert not list((root / 'bodies').glob(tunnel['id'] + '-*'))
            session = client.get('/status').json()['session']
            strict = client.get(f'/sessions/{session}/export').json()['log']
            assert not any(e.get('_chls', {}).get('id') == tunnel['id'] for e in strict['entries'])
            har = client.get(f'/sessions/{session}/export?format=charles').json()['log']
            assert '_chlsTunnels' not in har
            imported_tunnel = next(e for e in har['entries'] if e.get('_chls', {}).get('id') == tunnel['id'])
            assert imported_tunnel['request']['method'] == 'CONNECT'
            assert imported_tunnel['request']['url'] == f"https://127.0.0.1:{tls_origin.server_port}/"
            assert imported_tunnel['response']['status'] == 0
            assert imported_tunnel['response']['content']['size'] == tunnel['bytes_received']
            assert 'text' not in imported_tunnel['response']['content']
            assert all(e['request']['method'] != 'TLS' for e in har['entries'])
            if os.environ.get('CHLS_TEST_CHARLES_JAR'):
                from xml.etree import ElementTree
                exported = root / 'encrypted-export.har'
                exported.write_text(json.dumps({'log': har}), encoding='utf-8')
                converted = exported.with_suffix('.xml')
                jar = Path(os.environ['CHLS_TEST_CHARLES_JAR'])
                result = subprocess.run([os.environ.get('CHLS_TEST_JAVA', 'java'),
                                         '-Djava.awt.headless=true', f'-Djava.library.path={jar.parent}',
                                         '-jar', str(jar), 'convert', str(exported), str(converted)],
                                        capture_output=True, text=True, timeout=45)
                assert result.returncode == 0, result.stdout + result.stderr
                transactions = ElementTree.parse(converted).findall('transaction')
                actual_tunnel = next(t for t in transactions if t.get('method') == 'CONNECT')
                assert int(actual_tunnel.get('port')) == tls_origin.server_port
                assert int(actual_tunnel.get('totalSize')) == tunnel['size']
            assert proxy.get(upstream + '/ssl-check').status_code == 418
        assert client.post('/capture/ssl', json={'enabled': True}).json()['config']['ssl_proxying'] is True
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', verify=False, trust_env=False) as proxy:
            assert proxy.get(f'https://127.0.0.1:{tls_origin.server_port}/ssl-check').status_code == 418
    finally:
        tls_origin.shutdown()
        client.put('/rules', json=[])


def test_partial_tls_handshake_is_recorded_without_http_fields(environment):
    client, port, _, upstream, root = environment
    client.post('/recording', json={'enabled': True}).raise_for_status()
    client.post('/capture/start', json={'port': port, 'lan': False, 'ssl_proxying': False}).raise_for_status()
    session = client.post('/sessions').json()['id']
    target = int(upstream.rsplit(':', 1)[1])
    with socket.create_connection(('127.0.0.1', port), timeout=3) as sock:
        sock.sendall(f'CONNECT 127.0.0.1:{target} HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\n\r\n'.encode())
        assert b'200' in sock.recv(4096)
        sock.sendall(bytes.fromhex('1603010100010000fc03'))
    for _ in range(100):
        records = client.get('/flows', params={'session': session}).json()
        if records and records[0]['state'] != 'open':
            break
        time.sleep(.02)
    assert len(records) == 1
    item = records[0]
    assert item['kind'] == 'connection' and item['protocol'] == 'TLS'
    assert item['bytes_sent'] == 10
    assert item['state'] in ('closed', 'error')
    assert all(key not in item for key in ('method', 'url', 'path', 'status', 'rules'))
    assert client.get(f'/sessions/{session}/export').json()['log']['entries'] == []
    assert len(client.get(f'/sessions/{session}/export?format=charles').json()['log']['entries']) == 1
    assert client.get(f'/sessions/{session}/export?format=invalid').status_code == 422
    client.post('/capture/ssl', json={'enabled': True})


def test_selected_ssl_hosts_use_sni_and_leave_other_tls_opaque(environment):
    client, port, _, upstream, root = environment
    client.post('/recording', json={'enabled': True}).raise_for_status()
    client.post('/capture/start', json={'port': port, 'lan': False}).raise_for_status()
    client.post('/mocks/control', json={'action': 'disable'})
    client.post('/sessions').raise_for_status()
    origin = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(str(root / 'certificates' / 'mitmproxy-ca.pem'))
    origin.socket = server_context.wrap_socket(origin.socket, server_side=True)
    threading.Thread(target=origin.serve_forever, daemon=True).start()
    target = origin.server_port
    def tls_get(name):
        raw = socket.create_connection(('127.0.0.1', port), timeout=5)
        try:
            raw.sendall(f'CONNECT 127.0.0.1:{target} HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\n\r\n'.encode())
            header = b''
            while b'\r\n\r\n' not in header:
                header += raw.recv(4096)
            assert b'200' in header
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            with context.wrap_socket(raw, server_hostname=name) as secure:
                secure.sendall(f'GET /ssl-policy-check HTTP/1.1\r\nHost: {name}\r\nConnection: close\r\n\r\n'.encode())
                response = b''
                while True:
                    data = secure.recv(4096)
                    if not data:
                        break
                    response += data
                return int(response.split(b' ')[1])
        finally:
            raw.close()
    try:
        client.put('/rules', json=[dict(id='ssl-scope', name='scope', kind='block', host='',
                                      path='/ssl-policy-check', query='', match='exact', status=418)]).raise_for_status()
        settings = {'enabled': True, 'scope': 'selected', 'hosts': [f'allowed.example.test:{target}', f'*.wild.example.test:{target}']}
        response = client.post('/capture/ssl', json=settings)
        assert response.status_code == 200, response.text
        assert tls_get('allowed.example.test') == 418
        assert tls_get('a.wild.example.test') == 418
        assert tls_get('excluded.example.test') == 200
        assert tls_get('wild.example.test') == 200
        saved = client.get('/flows').json()
        assert len([item for item in saved if item['kind'] == 'http']) == 2
        opaque = [item for item in saved if item['kind'] == 'connection']
        assert {item['host'] for item in opaque} == {'excluded.example.test', 'wild.example.test'}
        assert all(item['ssl_reason'] == 'not_selected' for item in opaque)
        persisted = json.loads((root/'capture.json').read_text('utf-8'))
        assert persisted['ssl_scope'] == 'selected' and len(persisted['ssl_hosts']) == 2
        assert client.post('/capture/ssl', json={'enabled': False}).json()['config']['ssl_hosts'] == persisted['ssl_hosts']
        assert tls_get('allowed.example.test') == 200
        assert client.post('/capture/ssl', json={'enabled': True}).json()['config']['ssl_scope'] == 'selected'
        before = client.get('/status').json()['config']
        assert client.post('/capture/ssl', json={'enabled': True, 'hosts': ['https://bad/path']}).status_code == 422
        assert client.get('/status').json()['config'] == before
        client.post('/capture/ssl', json={'enabled': True, 'scope': 'selected', 'hosts': []}).raise_for_status()
        assert tls_get('allowed.example.test') == 200
        # Partial ClientHello must also remain visible while a domain decision is pending.
        client.post('/capture/ssl', json=settings).raise_for_status()
        with socket.create_connection(('127.0.0.1', port), timeout=3) as raw:
            raw.sendall(f'CONNECT 127.0.0.1:{target} HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\n\r\n'.encode())
            assert b'200' in raw.recv(4096)
            raw.sendall(bytes.fromhex('1603010100010000fc03'))
        for _ in range(100):
            items = client.get('/flows').json()
            if any('host selection' in (item.get('error') or '') for item in items):
                break
            time.sleep(.02)
        assert any('host selection' in (item.get('error') or '') for item in items)
    finally:
        origin.shutdown()
        client.put('/rules', json=[])
        client.post('/capture/ssl', json={'enabled': True, 'scope': 'all', 'hosts': []})


def test_old_script_policy_migrates_and_survives_engine_restart(tmp_path):
    proxy_port = free_port()
    (tmp_path / 'capture.json').write_text(json.dumps({'http': True, 'wireguard': False, 'port': proxy_port, 'lan': False}), 'utf-8')
    source = '''from chls import Script, response
app = Script("migration")
app.hosts = ["code.test"]
@app.get("/legacy/order")
def reply(request, ctx):
    return response(200, json={"mock": True})
'''
    file = tmp_path / 'script-module.json'
    file.write_text(json.dumps(dict(source=source, folder='', hosts=['external.test'], scope='/legacy/', strict=True)), 'utf-8')
    with restarted_engine(tmp_path, free_port()) as client:
        status = client.get('/mocks').json()
        assert status['applied'] and not status['enabled']
        assert status['policy'] == dict(hosts=['code.test'], path_prefix='/legacy/', unmatched='block')
        assert "app.path_prefix = '/legacy/'" in status['source']
        assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
        with httpx.Client(proxy=f'http://127.0.0.1:{proxy_port}', trust_env=False) as proxy:
            assert proxy.get('http://code.test/legacy/order').json() == {'mock': True}
            assert proxy.get('http://code.test/legacy/unknown').status_code == 501
        assert client.put('/mocks', json=dict(source=status['source'], folder='')).status_code == 200
        assert set(json.loads(file.read_text('utf-8'))) == {'version', 'source', 'folder'}
    with restarted_engine(tmp_path, free_port()) as client:
        reloaded = client.get('/mocks').json()
        assert reloaded['policy'] == status['policy']
        assert reloaded['source'] == status['source']


def test_ssl_scope_and_hosts_survive_engine_restart(tmp_path):
    api_port, proxy_port = free_port(), free_port()
    (tmp_path/'capture.json').write_text(json.dumps({'http': True, 'wireguard': False, 'port': proxy_port, 'lan': False}), encoding='utf-8')
    with restarted_engine(tmp_path, api_port) as client:
        result = client.post('/capture/ssl', json={'enabled': True, 'scope': 'selected', 'hosts': ['API.Example.Test', '*.example.net:8443']})
        assert result.status_code == 200, result.text
    with restarted_engine(tmp_path, api_port) as client:
        config = client.get('/status').json()['config']
        assert config['ssl_proxying'] is True
        assert config['ssl_scope'] == 'selected'
        assert config['ssl_hosts'] == ['api.example.test', '*.example.net:8443']
