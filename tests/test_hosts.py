from mitmproxy import connection, http

from backend.hosts import display_url, flow_host, readable_record
from backend.rules import Rule, apply_rules


def make_flow():
    flow = http.HTTPFlow(connection.Client(peername=('10.0.0.2', 40000), sockname=('10.0.0.1', 8080)),
                         connection.Server(address=('198.18.3.227', 443)))
    flow.request = http.Request.make('GET', 'https://198.18.3.227/api/precheck')
    return flow


def test_host_header_drives_display_and_domain_rules_without_changing_destination():
    flow = make_flow()
    flow.request.headers['Host'] = 'api.example.com'
    assert flow_host(flow) == 'api.example.com'
    assert display_url(flow.request.pretty_url, flow_host(flow)) == 'https://api.example.com/api/precheck'
    apply_rules(flow, [Rule(id='domain', name='domain block', kind='block', host='api.example.com', status=403)], 'request', 1024)
    assert flow.response.status_code == 403
    assert flow.request.host == '198.18.3.227'
    assert flow.server_conn.address == ('198.18.3.227', 443)


def test_http2_authority_and_sni_fallback():
    flow = make_flow()
    flow.request.http_version = 'HTTP/2.0'
    flow.request.authority = 'api.example.com:8443'
    assert flow_host(flow) == 'api.example.com'
    assert display_url(flow.request.pretty_url, flow_host(flow)) == 'https://api.example.com:8443/api/precheck'
    flow.request.authority = ''
    flow.request.headers.pop('Host', None)
    flow.client_conn.sni = 'secure.example.com'
    assert flow_host(flow) == 'secure.example.com'
    assert display_url(flow.request.pretty_url, flow_host(flow)) == 'https://secure.example.com/api/precheck'


def test_unknown_ip_is_preserved_and_wildcard_uses_known_domain():
    flow = make_flow()
    assert flow_host(flow) == '198.18.3.227'
    flow.client_conn.sni = 'api.example.com'
    apply_rules(flow, [Rule(id='domain', name='wildcard', kind='block', host='*.example.com', status=451)], 'request', 1024)
    assert flow.response.status_code == 451


def test_existing_history_recovers_domain_without_modifying_source_headers():
    summary = readable_record({'host': '198.18.3.227', 'url': 'https://api.example.com/api/precheck'})
    assert summary['host'] == 'api.example.com'
    detail = readable_record({'host': '198.18.3.227', 'url': 'https://198.18.3.227/api/precheck',
                              'request': {'headers': [['Host', 'api.example.com']]}})
    assert detail['host'] == 'api.example.com'
    assert detail['url'] == 'https://api.example.com/api/precheck'
