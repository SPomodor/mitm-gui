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
    command = [os.environ['CHLS_TEST_ENGINE']] if os.environ.get('CHLS_TEST_ENGINE') else [sys.executable, '-m', 'backend']
    process = subprocess.Popen([*command, '--port', str(api_port)], env={**os.environ, 'CHLS_TOKEN': 'integration-secret', 'CHLS_DATA': str(root)}, stdout=log, stderr=log)
    client = httpx.Client(base_url=f'http://127.0.0.1:{api_port}', headers={'Authorization': 'Bearer integration-secret'}, timeout=15)
    try:
        for _ in range(150):
            if process.poll() is not None:
                pytest.fail((root / 'log.txt').read_text('utf-8'))
            try:
                if client.get('/status').status_code == 200:
                    break
            except httpx.TransportError:
                pass
            time.sleep(.1)
        else:
            pytest.fail('Engine startup timed out')
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
    assert httpx.get(str(client.base_url).rstrip('/') + '/status').status_code == 401
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
        domain_flow = next(f for f in client.get('/flows').json() if f['path'] == '/domain')
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
        gzip_flow = next(f for f in flows if f['path'] == '/gzip')
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
    command = [os.environ['CHLS_TEST_ENGINE']] if os.environ.get('CHLS_TEST_ENGINE') else [sys.executable, '-m', 'backend']
    with (root / 'restart.log').open('a', encoding='utf-8') as log:
        process = subprocess.Popen([*command, '--port', str(api_port)], env={**os.environ, 'CHLS_TOKEN': 'restart-secret', 'CHLS_DATA': str(root)}, stdout=log, stderr=log)
        client = httpx.Client(base_url=f'http://127.0.0.1:{api_port}', headers={'Authorization': 'Bearer restart-secret'}, timeout=10)
        try:
            for _ in range(150):
                if process.poll() is not None:
                    pytest.fail((root / 'restart.log').read_text('utf-8'))
                try:
                    if client.get('/status').status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(.1)
            else:
                pytest.fail('Restart timed out')
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
        assert client.get('/flows').json() == []
        assert len(client.get('/flows', params={'session': first_session}).json()) == 1
        assert client.get('/rules').json()[0]['id'] == 'restart-mock'
        with httpx.Client(proxy=f'http://127.0.0.1:{proxy_port}') as proxy:
            assert proxy.get('http://restart.invalid/check').json() == {'restart': True}
        assert client.get('/flows').json()[0]['session'] == status['session']


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
    source = '''модуль "Интеграция"
начало "Собирается"
путь info = "/driver/order/info"
общие:
 /driver/state -> 200 {"active":true}
этап "Собирается":
 GET info -> 200 "mock-order.json"
этап "Завершён":
 GET info -> 200 {"status":"completed"}
 /driver/state -> 200 {"active":false}
'''
    (root / 'mock-order.json').write_text('{"status":"assembling"}', 'utf-8')
    document = dict(source=source, folder=str(root), hosts=['127.0.0.1', 'offline.invalid'], scope='/driver/', strict=True)
    try:
        assert client.post('/capture/start', json={'port': port, 'lan': False}).status_code == 200
        assert client.get('/mocks').json()['enabled'] is False
        missing_hosts = client.post('/mocks/validate', json={**document, 'hosts': []})
        assert missing_hosts.status_code == 422
        assert 'Все домены' in missing_hosts.json()['detail']
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
            assert failed.status_code == 422 and 'Строка' in failed.json()['detail']
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
            assert client.put('/mocks', json={**document, 'hosts': ['*']}).status_code == 200
            assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
            assert proxy.get('http://new-domain.invalid/driver/order/info').json()['status'] == 'assembling'
            assert proxy.get('http://other-domain.invalid/driver/order/info').json()['status'] == 'assembling'
            assert proxy.get('http://new-domain.invalid/driver/unknown').status_code == 501
    finally:
        client.post('/mocks/control', json={'action': 'disable'})
        client.put('/rules', json=previous)


def test_trigger_modes_real_requests_retry_guard_and_reset(environment):
    client, port, _, upstream, _ = environment
    arrive = '/driver/v1/cargo-pro-api/grocery/v1/order/arrive-at-point'
    confirm = '/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm'
    source = f'''модуль "Переходы"
путь arrive = "{arrive}"
путь confirm = "{confirm}"
общие:
 POST confirm -> 500 {{"ignored":true}}
этап "start":
 GET /driver/info -> 200 {{"stage":"start"}}
 при POST arrive -> следующий
этап "arrived":
 GET /driver/info -> 200 {{"stage":"arrived"}}
 при POST confirm -> следующий
этап "confirmed":
 GET /driver/info -> 200 {{"stage":"confirmed"}}
 при POST confirm -> "complete"
этап "complete":
 GET /driver/info -> 200 {{"stage":"complete"}}
'''
    document = dict(source=source, folder='', hosts=['*'], scope='/driver/', strict=False)
    try:
        client.post('/mocks/control', json={'action': 'mode', 'mode': 'free'})
        assert client.put('/mocks', json=document).status_code == 200
        assert client.post('/mocks/control', json={'action': 'enable'}).status_code == 200
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', trust_env=False) as proxy:
            assert proxy.post(upstream + arrive).status_code == 200
            assert client.get('/mocks').json()['stage'] == 'start'
            assert client.post('/mocks/control', json={'action': 'stage', 'stage': 'confirmed'}).status_code == 200
            assert client.post('/mocks/control', json={'action': 'reset'}).json()['stage'] == 'start'
            assert client.post('/mocks/control', json={'action': 'mode', 'mode': 'scenario'}).json()['mode'] == 'scenario'
            assert client.post('/mocks/control', json={'action': 'stage', 'stage': 'complete'}).status_code == 409
            assert proxy.post(upstream + arrive).status_code == 200
            assert proxy.get(upstream + '/driver/info?poll=1').json()['stage'] == 'arrived'
            acknowledged = proxy.post(upstream + confirm, headers={'Idempotency-Key': 'one'})
            assert acknowledged.status_code == 200 and acknowledged.content == b''
            assert client.get('/mocks').json()['stage'] == 'confirmed'
            proxy.post(upstream + confirm, headers={'Idempotency-Key': 'one'})
            assert client.get('/mocks').json()['stage'] == 'confirmed'
            proxy.post(upstream + confirm, headers={'Idempotency-Key': 'two'})
            assert proxy.get(upstream + '/driver/info').json()['stage'] == 'complete'
            assert any(log.get('transition', {}).get('destination') == 'complete' for log in client.get('/mocks').json()['logs'] if log.get('transition'))
            assert client.post('/mocks/control', json={'action': 'reset'}).json()['stage'] == 'start'
            # Reset clears replay guards, so the same request can start a new run.
            assert proxy.post(upstream + arrive).status_code == 200
            assert client.get('/mocks').json()['stage'] == 'arrived'
            assert client.post('/mocks/control', json={'action': 'mode', 'mode': 'invalid'}).status_code == 422
            assert client.get('/mocks').json()['mode'] == 'scenario'
    finally:
        client.post('/mocks/control', json={'action': 'disable'})
        client.post('/mocks/control', json={'action': 'mode', 'mode': 'free'})


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
            if any(f['path'] == '/slow-clear' for f in client.get('/flows').json()):
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
            assert not any(f['path'] == '/ssl-check' for f in client.get('/flows').json())
            assert proxy.get(upstream + '/ssl-check').status_code == 418
        assert client.post('/capture/ssl', json={'enabled': True}).json()['config']['ssl_proxying'] is True
        with httpx.Client(proxy=f'http://127.0.0.1:{port}', verify=False, trust_env=False) as proxy:
            assert proxy.get(f'https://127.0.0.1:{tls_origin.server_port}/ssl-check').status_code == 418
    finally:
        tls_origin.shutdown()
        client.put('/rules', json=[])
