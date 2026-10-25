"""Explicit Charles compatibility adapter. These are synthetic tunnel summaries."""
from datetime import datetime, timezone
from ipaddress import ip_address


def tunnel_entry(detail):
    """Export-only approximation for Charles, never an observed HTTP request."""
    host = detail['host']
    port = detail['port']
    authority = f'[{host}]' if ':' in host else host
    sent, received = detail.get('bytes_sent', 0), detail.get('bytes_received', 0)
    transport = detail.get('transport', 'tcp')
    method = 'CONNECT-UDP' if transport == 'udp' else 'CONNECT'
    protocol = detail['protocol']
    comment = (f'Encrypted {protocol}/{transport.upper()} connection. '
               f'{method} is a HAR compatibility summary, not a captured HTTP request. '
               'HTTP headers, status and bodies are unavailable; encrypted payload bytes were not stored. '
               'Sizes are wire byte counts including handshake traffic.')
    if detail.get('error'):
        comment += f" Connection error: {detail['error']}"
    state = detail['state']
    common = dict(httpVersion='HTTP/1.1', cookies=[], headers=[], headersSize=-1,
                  _chlsBodyUnavailable=True)
    entry = dict(startedDateTime=datetime.fromtimestamp(detail['started'], timezone.utc).isoformat(), time=detail.get('duration') or 0,
                 request=dict(common, method=method, url=f'https://{authority}:{port}/',
                              queryString=[], bodySize=sent),
                 response=dict(common, status=0, statusText='', redirectURL='', bodySize=received,
                               content=dict(size=received, mimeType='application/octet-stream'),
                               _charlesStatus={'closed': 'COMPLETE', 'error': 'EXCEPTION'}.get(state, 'CONNECTED')),
                 cache={}, timings=dict(send=-1, wait=-1, receive=-1), comment=comment,
                 connection=detail['id'],
                 _chls={key: value for key, value in detail.items()
                        if key not in ('request', 'response', 'original_request', 'original_response')})
    try:
        entry['serverIPAddress'] = str(ip_address(detail.get('destination_host') or host))
    except ValueError:
        pass
    return entry
