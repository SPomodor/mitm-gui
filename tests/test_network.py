import socket
from types import SimpleNamespace

from backend import network


def test_interface_discovery_does_not_resolve_hostname(monkeypatch):
    def unexpected_dns(*args, **kwargs):
        raise AssertionError('Local address discovery must not call DNS')

    monkeypatch.setattr(socket, 'getaddrinfo', unexpected_dns)
    monkeypatch.setattr(socket, 'gethostname', unexpected_dns)
    monkeypatch.setattr(network.psutil, 'net_if_addrs', lambda: {
        'loopback': [SimpleNamespace(family=socket.AF_INET, address='127.0.0.1')],
        'wifi': [SimpleNamespace(family=socket.AF_INET, address='192.168.1.10'),
                 SimpleNamespace(family=socket.AF_INET6, address='fe80::1')],
        'vpn': [SimpleNamespace(family=socket.AF_INET, address='10.0.0.2')],
    })
    assert network.addresses() == ['10.0.0.2', '192.168.1.10', '127.0.0.1']


def test_interface_discovery_keeps_loopback_when_os_lookup_fails(monkeypatch):
    def unavailable():
        raise OSError('Interface lookup unavailable')

    monkeypatch.setattr(network.psutil, 'net_if_addrs', unavailable)
    assert network.addresses() == ['127.0.0.1']
