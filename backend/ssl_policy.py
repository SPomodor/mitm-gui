"""TLS interception scope, evaluated before HTTP paths are available."""
from ipaddress import ip_address
import re
from urllib.parse import urlsplit


def normalize_hosts(entries):
    if len(entries) > 200:
        raise ValueError('Не больше 200 SSL-хостов')
    result = []
    for value in entries:
        value = value.strip().lower().rstrip('.')
        if not value or any(char.isspace() for char in value) or any(char in value for char in '/?#@'):
            raise ValueError('Укажите домен или IP, при необходимости с портом; без URL и пути')
        wildcard = value.startswith('*.')
        raw = value[2:] if wildcard else value
        try:
            address = ip_address(raw)
            host, port = str(address), None
        except ValueError:
            try:
                parsed = urlsplit('//' + raw)
                host, port = parsed.hostname, parsed.port
                if not host or raw.endswith(':'):
                    raise ValueError()
            except ValueError:
                raise ValueError('Некорректный SSL-хост или порт') from None
        host = host.rstrip('.')
        try:
            address = ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            if wildcard:
                raise ValueError('Маска разрешена только для доменов')
            host = f'[{address}]' if address.version == 6 else str(address)
        else:
            try:
                host = host.encode('idna').decode('ascii')
            except UnicodeError:
                raise ValueError('Некорректный SSL-домен') from None
            if len(host) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')):
                raise ValueError('Некорректный SSL-домен; маска допускается только в начале: *.example.com')
        if port is not None and not 1 <= port <= 65535:
            raise ValueError('SSL-порт должен быть от 1 до 65535')
        pattern = ('*.' if wildcard else '') + host + (f':{port}' if port is not None else '')
        if pattern not in result:
            result.append(pattern)
    return result


def should_decrypt(config, host, port, destination=None):
    if not config.ssl_proxying:
        return False
    if getattr(config, 'ssl_scope', 'all') == 'all':
        return True
    candidates = set()
    for candidate in (host, destination):
        if candidate:
            try:
                value = candidate.lower().rstrip('.').strip('[]')
                try:
                    value = str(ip_address(value))
                except ValueError:
                    value = value.encode('idna').decode('ascii')
                candidates.add(value)
            except UnicodeError:
                pass
    for pattern in getattr(config, 'ssl_hosts', []):
        wildcard = pattern.startswith('*.')
        parsed = urlsplit('//' + (pattern[2:] if wildcard else pattern))
        if parsed.port is not None and parsed.port != port:
            continue
        wanted = parsed.hostname
        if any((candidate.endswith('.' + wanted) if wildcard else candidate == wanted) for candidate in candidates):
            return True
    return False
