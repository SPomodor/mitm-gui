"""Human-readable HTTP identity, independent of a tunnel's destination IP."""
from ipaddress import ip_address
from urllib.parse import urlsplit, urlunsplit


def is_ip(value: str) -> bool:
    try:
        ip_address(value.strip('[]'))
        return True
    except ValueError:
        return False


def hostname(value: str | None) -> str:
    if not value:
        return ''
    value = value.strip()
    if is_ip(value):
        return value.strip('[]').lower()
    try:
        host = urlsplit(value if '://' in value else '//' + value).hostname or ''
        if any(c.isspace() or c in '/\\?#@' for c in host):
            return ''
        return host.rstrip('.').lower()
    except ValueError:
        return ''


def choose_host(*candidates: str | None) -> str:
    hosts = [host for value in candidates if (host := hostname(value))]
    return next((host for host in hosts if not is_ip(host)), hosts[0] if hosts else '')


def flow_host(flow) -> str:
    return choose_host(flow.request.pretty_host, flow.request.host,
                       flow.client_conn.sni, flow.server_conn.sni)


def display_url(original: str, host: str) -> str:
    try:
        parts = urlsplit(original)
        if not parts.hostname or not host or hostname(parts.hostname) == host:
            return original
        authority = f'[{host}]' if ':' in host else host
        if parts.port:
            authority += f':{parts.port}'
        return urlunsplit((parts.scheme, authority, parts.path, parts.query, parts.fragment))
    except ValueError:
        return original


def readable_record(record: dict) -> dict:
    """Recover names in older history when the URL or saved Host contains one."""
    if record.get('kind') == 'connection':
        return record
    request = record.get('request') or {}
    authority = next((value for key, value in request.get('headers', [])
                      if key.lower() in ('host', ':authority')), '')
    host = choose_host(record.get('url'), authority, record.get('host'))
    if host:
        record['host'] = host
        record['url'] = display_url(record.get('url', ''), host)
    return record
