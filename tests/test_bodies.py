import gzip
import json

import pytest

from backend.bodies import body_document
from backend.har import har_message, export_har


@pytest.mark.parametrize('encoding', ['utf-8', 'cp1251', 'utf-16'])
def test_cyrillic_compressed_body_is_complete_utf8_json(tmp_path, encoding):
    body = {'message': 'Сообщим, когда всё починят', 'padding': 'я' * 600000, 'tail': 'КОНЕЦ'}
    text = json.dumps(body, ensure_ascii=False)
    raw = gzip.compress(text.encode(encoding))
    (tmp_path / 'bodies').mkdir()
    (tmp_path / 'bodies' / 'saved').write_bytes(raw)
    message = dict(body_file='saved', status=200, headers=[
        ('Content-Type', f'application/json; charset={encoding}'), ('Content-Encoding', 'gzip')])
    document = body_document(message, tmp_path, 'original_response')
    assert document['filename'] == 'original_response.json'
    assert document['text'] == text
    assert json.loads(document['content'].decode('utf-8')) == body
    assert len(document['content']) > 1024 * 1024
    assert har_message(message, tmp_path)['content']['text'] == text


def test_har_unicode_survives_non_utf8_file_reader(tmp_path):
    (tmp_path / 'bodies').mkdir()
    value = 'Сообщим, когда всё починят'
    (tmp_path / 'bodies' / 'saved').write_bytes(json.dumps({'text': value}, ensure_ascii=False).encode())
    message = dict(body_file='saved', status=200, headers=[('Content-Type', 'application/json')])
    entry = dict(id='flow', kind='http', started=1, url='https://example.com/',
                 request={'method': 'GET', 'headers': []}, response=message)
    file = export_har(tmp_path, {'name': 'Русская сессия'}, [json.dumps(entry)])
    try:
        raw = file.read_bytes()
        assert raw.isascii()
        for encoding in ('utf-8', 'cp1251'):
            exported = json.loads(raw.decode(encoding))['log']['entries'][0]
            assert json.loads(exported['response']['content']['text'])['text'] == value
    finally:
        file.unlink()


def test_binary_download_does_not_reencode_bytes(tmp_path):
    (tmp_path / 'bodies').mkdir()
    raw = b'\x89PNG\x00\xff\x00'
    (tmp_path / 'bodies' / 'saved').write_bytes(raw)
    document = body_document({'body_file': 'saved', 'headers': [('Content-Type', 'image/png')]}, tmp_path, 'response')
    assert document['text'] is None
    assert document['content'] == raw
    assert document['filename'] == 'response.png'
