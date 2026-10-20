import base64
import gzip
import json

from backend.har import export_har
from backend.store import Store


def test_rename_persists_without_changing_active_session(tmp_path):
    store = Store(tmp_path)
    old = store.session
    active = store.new_session()['id']
    assert store.rename_session(old, 'Phone debugging')
    assert not store.rename_session('missing', 'Unknown')
    store.db.close()
    reopened = Store(tmp_path)
    assert next(s for s in reopened.sessions() if s['id'] == old)['name'] == 'Phone debugging'
    assert reopened.session not in (old, active)
    reopened.db.close()


def test_har_full_bodies_binary_compression_and_snapshot(tmp_path):
    store = Store(tmp_path)
    payload = ('hello ' * 60000).encode()
    request = {'method': 'POST', 'url': 'https://example.org/test?q=1&q=2', 'headers': [['Content-Type', 'application/octet-stream']],
               'body_file': store.body('one', 'request', b'\xff\x00'), 'http_version': 'HTTP/2'}
    response = {'status': 404, 'headers': [['Content-Type', 'text/plain'], ['Content-Encoding', 'gzip'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']],
                'body_file': store.body('one', 'response', gzip.compress(payload)), 'http_version': 'HTTP/2'}
    detail = {'id': 'one', 'session': store.session, 'started': 1700000000, 'duration': 123, 'url': request['url'],
              'request': request, 'response': response, 'original_response': response, 'rules': ['rewrite'], 'state': 'complete'}
    store.save(detail, detail)
    session, rows = store.export_snapshot(store.session)
    # Recording a newer version cannot overwrite the snapshot's body files.
    store.body('one', 'response', b'new body')
    file = export_har(tmp_path, session, rows)
    try:
        document = json.loads(file.read_text('utf-8'))['log']
        entry = document['entries'][0]
        assert document['_chlsSession']['id'] == store.session
        assert entry['request']['queryString'] == [{'name': 'q', 'value': '1'}, {'name': 'q', 'value': '2'}]
        assert base64.b64decode(entry['request']['postData']['text']) == b'\xff\x00'
        assert entry['response']['content']['text'].encode() == payload
        assert entry['response']['status'] == 404
        assert len(entry['response']['headers']) == 4
        assert entry['_chls']['original_response']['content']['text'].encode() == payload
        assert entry['time'] == 123
    finally:
        file.unlink()
        store.db.close()


def test_export_is_not_limited_to_visible_history(tmp_path):
    store = Store(tmp_path)
    detail = {'id': 'pending', 'session': store.session, 'started': 1700000000, 'url': 'https://example.org/',
              'request': {'method': 'GET', 'headers': []}, 'response': None, 'state': 'pending'}
    store.db.executemany('INSERT INTO flows VALUES (?,?,?,?,?)',
                         [(str(i), store.session, i, json.dumps(detail), json.dumps(detail)) for i in range(10001)])
    store.db.commit()
    assert len(store.flows(store.session)) == 10000
    session, rows = store.export_snapshot(store.session)
    file = export_har(tmp_path, session, rows)
    try:
        entries = json.loads(file.read_text('utf-8'))['log']['entries']
        assert len(entries) == 10001
        assert entries[0]['response']['status'] == 0
    finally:
        file.unlink()
        store.db.close()
