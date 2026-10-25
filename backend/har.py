"""Write a complete HAR incrementally, without loading a session's bodies into RAM."""
import base64
import json
import os
import tempfile
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from mitmproxy import http

from .hosts import readable_record
from .records import normalize_record
from .charles_har import tunnel_entry


def date(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def message_body(message, root):
    filename = message.get('body_file')
    if not filename:
        return b'', b''
    raw = (root / 'bodies' / filename).read_bytes()
    response = http.Response.make(200)
    response.headers = http.Headers((k.encode('latin1'), v.encode('latin1')) for k, v in message['headers'])
    response.raw_content = raw
    try:
        return raw, response.content or b''
    except ValueError:
        return raw, raw


def har_message(message, root, url='', request=False):
    raw, decoded = message_body(message, root)
    headers = message.get('headers', [])
    mime = next((v for k, v in headers if k.lower() == 'content-type'), 'application/octet-stream')
    result = {'httpVersion': message.get('http_version', 'HTTP/1.1'),
              'headers': [{'name': k, 'value': v} for k, v in headers],
              'cookies': [], 'headersSize': -1, 'bodySize': len(raw)}
    try:
        text = decoded.decode('utf-8')
        # Binary UTF-8 data, including NUL bytes, also needs base64.
        if any(ord(c) < 32 and c not in '\t\r\n' for c in text):
            raise UnicodeError()
        encoding = None
    except UnicodeError:
        text = base64.b64encode(decoded).decode('ascii')
        encoding = 'base64'
    if request:
        url = url or message.get('url') or ''
        result.update(method=message.get('method', 'GET'), url=url,
                      queryString=[{'name': k, 'value': v} for k, v in parse_qsl(urlsplit(url).query, keep_blank_values=True)])
        if raw:
            result['postData'] = {'mimeType': mime, 'text': text}
            if encoding:
                result['postData']['encoding'] = encoding
    else:
        status = message.get('status') or 0
        result.update(status=status, statusText=HTTPStatus(status).phrase if status in HTTPStatus._value2member_map_ else '',
                      redirectURL=next((v for k, v in headers if k.lower() == 'location'), ''),
                      content={'size': len(decoded), 'mimeType': mime, 'text': text})
        if encoding:
            result['content']['encoding'] = encoding
    if message.get('streamed') or not message.get('body_file') and message.get('size', 0):
        result['_chlsBodyUnavailable'] = True
    return result


def export_har(root: Path, session, rows, *, include_connections=False):
    handle = tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', suffix='.har', delete=False)
    file = Path(handle.name)
    try:
        with handle:
            handle.write('{"log":')
            header = {'version': '1.2', 'creator': {'name': 'CHLS', 'version': os.environ.get('CHLS_VERSION', '0.3.0')},
                      '_chlsSession': session, 'pages': []}
            if include_connections:
                header['comment'] = 'Charles compatibility export: CONNECT/CONNECT-UDP entries are synthetic connection summaries, not captured HTTP requests.'
            handle.write(json.dumps(header, ensure_ascii=False)[:-1] + ',"entries":[')
            index = 0
            for row in rows:
                detail = readable_record(normalize_record(json.loads(row)))
                if detail['kind'] == 'connection':
                    if not include_connections:
                        continue
                    if index:
                        handle.write(',')
                    json.dump(tunnel_entry(detail), handle, ensure_ascii=False)
                    index += 1
                    continue
                entry = {'startedDateTime': date(detail['started']), 'time': detail.get('duration') or 0,
                         'request': har_message(detail['request'], root, detail['url'], True),
                         'response': har_message(detail.get('response') or {}, root),
                         'cache': {}, 'timings': {'send': 0, 'wait': detail.get('duration') or 0, 'receive': 0},
                         '_chls': {k: detail.get(k) for k in ('id', 'state', 'error', 'rules')}}
                for side in ('original_request', 'original_response'):
                    if detail.get(side):
                        entry['_chls'][side] = har_message(detail[side], root, '', side.endswith('request'))
                if index:
                    handle.write(',')
                json.dump(entry, handle, ensure_ascii=False)
                index += 1
            handle.write(']}}')
        return file
    except BaseException:
        file.unlink(missing_ok=True)
        raise
