"""Decode saved HTTP bodies consistently for preview, clipboard and export."""
import codecs
import json
import re

from mitmproxy import http


def read_body(message, root):
    filename = message.get('body_file')
    if not filename:
        return b'', b''
    raw = (root / 'bodies' / filename).read_bytes()
    reply = http.Response.make(200)
    reply.headers = http.Headers((k.encode('latin1'), v.encode('latin1')) for k, v in message.get('headers', []))
    reply.raw_content = raw
    return raw, reply.content or b''


def body_text(data, headers):
    mime = next((v for k, v in headers if k.lower() == 'content-type'), '')
    charset = re.search(r'charset\s*=\s*[\"\']?([^;\s\"\']+)', mime, re.I)
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encodings = ['utf-16']
    elif data.startswith(codecs.BOM_UTF8):
        encodings = ['utf-8-sig']
    else:
        encodings = ['utf-8']
        if charset:
            encodings.append(charset.group(1))
    for encoding in encodings:
        try:
            text = data.decode(encoding)
            if any(ord(c) < 32 and c not in '\t\r\n' for c in text):
                continue
            return text
        except (UnicodeError, LookupError):
            pass
    return None


def body_document(message, root, side):
    raw, decoded = read_body(message, root)
    text = body_text(decoded, message.get('headers', []))
    mime = next((v.split(';', 1)[0].strip().lower() for k, v in message.get('headers', [])
                 if k.lower() == 'content-type'), 'application/octet-stream')
    is_json = mime == 'application/json' or mime.endswith('+json')
    if not is_json and text is not None and text.lstrip().startswith(('{', '[')):
        try:
            json.loads(text)
            is_json = True
        except ValueError:
            pass
    extension = 'json' if is_json else 'txt' if text is not None else {
        'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf',
    }.get(mime, 'bin')
    return dict(text=text, content=decoded if text is None else text.encode('utf-8'),
                media_type=('application/json' if is_json else 'text/plain') + '; charset=utf-8' if text is not None else mime,
                filename=f'{side}.{extension}')
