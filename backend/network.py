"""Local interface discovery without DNS or outbound network requests."""
import socket

import psutil


def addresses():
    result = {'127.0.0.1'}
    try:
        interfaces = psutil.net_if_addrs()
    except OSError:
        return sorted(result)
    for interface in interfaces.values():
        for address in interface:
            if address.family == socket.AF_INET and address.address != '0.0.0.0':
                result.add(address.address)
    return sorted(result, key=lambda value: (value.startswith('127.'), value))
