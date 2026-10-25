from types import SimpleNamespace

import pytest

from backend.ssl_policy import normalize_hosts, should_decrypt


def config(hosts=(), enabled=True, scope='selected'):
    return SimpleNamespace(ssl_proxying=enabled, ssl_scope=scope, ssl_hosts=normalize_hosts(list(hosts)))


def test_ssl_policy_exact_wildcard_ports_ip_and_master_switch():
    policy = config(['API.Example.com.', '*.example.net:8443', '127.0.0.1:443', '[::1]:443'])
    assert should_decrypt(policy, 'api.example.com', 443)
    assert not should_decrypt(policy, 'other.example.com', 443)
    assert should_decrypt(policy, 'a.b.example.net', 8443)
    assert not should_decrypt(policy, 'example.net', 8443)
    assert not should_decrypt(policy, 'a.example.net', 443)
    assert not should_decrypt(policy, 'a.example.net.attacker.test', 8443)
    assert should_decrypt(policy, 'other.test', 443, '127.0.0.1')
    assert should_decrypt(policy, None, 443, '::1')
    assert not should_decrypt(config(), 'api.example.com', 443)
    assert should_decrypt(config(scope='all'), 'any.test', 443)
    assert not should_decrypt(config(['api.example.com'], enabled=False), 'api.example.com', 443)
    assert normalize_hosts(['API.example.com', 'api.example.com', '::1']) == ['api.example.com', '[::1]']


@pytest.mark.parametrize('entry', ['https://example.com/a', 'example.com/path', '*', 'a.*.test',
                                  '*.127.0.0.1', 'example.com:0', 'example.com:65536', 'user@host',
                                  'a b.test', 'example.com:', '.example.com'])
def test_invalid_ssl_hosts_are_rejected(entry):
    with pytest.raises(ValueError):
        normalize_hosts([entry])
