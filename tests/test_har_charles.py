"""Encrypted summaries must be regular HAR entries, including for Charles import."""
import json
import os
from pathlib import Path
import subprocess
from xml.etree import ElementTree

import pytest

from backend.har import export_har


@pytest.fixture
def compatibility_har(tmp_path):
    rows = [dict(id='plain', started=1792922400, duration=12, state='complete',
                 url='https://plain.example.test/api', request=dict(method='GET', headers=[]),
                 response=dict(status=200, headers=[]))]
    cases = [('complete', 'tcp', 'TLS', 'closed.example.test'),
             ('pending', 'tcp', 'TLS', 'open.example.test'),
             ('error', 'tcp', 'TLS', 'failed.example.test'),
             ('complete', 'udp', 'QUIC', 'quic.example.test'),
             ('complete', 'udp', 'DTLS', '2001:db8::1')]
    for index, (state, transport, protocol, host) in enumerate(cases):
        authority = f'[{host}]' if ':' in host else host
        rows.append(dict(id=f'tunnel-{index}', started=1792922401+index,
                         duration=None if state == 'pending' else 123,
                         state=state, error='Connection refused' if state == 'error' else None,
                         host=host, destination_host='192.0.2.1', port=8443,
                         url=f'{protocol.lower()}://{authority}:8443',
                         encrypted=True, transport=transport, method=protocol,
                         bytes_sent=100, bytes_received=8192, size=8292,
                         request=None, response=None, original_request=None, original_response=None))
    generated = export_har(tmp_path, {'id': 'compatibility'}, [json.dumps(row) for row in rows], include_connections=True)
    target = tmp_path / 'encrypted.har'
    generated.replace(target)
    return target, rows


def test_encrypted_har_entries_keep_mixed_history_states_counts_and_ipv6(compatibility_har):
    file, rows = compatibility_har
    log = json.loads(file.read_text('utf-8'))['log']
    assert len(log['entries']) == len(rows) == 6
    assert '_chlsTunnels' not in log
    assert log['entries'][0]['request']['method'] == 'GET'
    assert log['entries'][0]['response']['status'] == 200
    for entry, row in zip(log['entries'][1:], rows[1:]):
        assert entry['_chls']['id'] == row['id']
        assert entry['_chls']['state'] == {'complete': 'closed', 'pending': 'open', 'error': 'error'}[row['state']]
        assert entry['_chls']['protocol'] == row['method']
        assert entry['request']['method'] == ('CONNECT' if row['transport'] == 'tcp' else 'CONNECT-UDP')
        assert entry['request']['bodySize'] == 100
        assert entry['response']['bodySize'] == entry['response']['content']['size'] == 8192
        assert entry['response']['status'] == 0
        assert entry['request']['headers'] == entry['response']['headers'] == []
        assert 'text' not in entry['response']['content']
        assert 'postData' not in entry['request']
        assert 'compatibility summary' in entry['comment']
        assert entry['serverIPAddress'] == '192.0.2.1'
    assert log['entries'][-1]['request']['url'] == 'https://[2001:db8::1]:8443/'
    assert [e['response']['_charlesStatus'] for e in log['entries'][1:4]] == ['COMPLETE', 'CONNECTED', 'EXCEPTION']


def test_charles_import_preserves_every_connection(compatibility_har):
    # Optional external compatibility check: no GUI, proxy or user profile changes.
    jar = os.environ.get('CHLS_TEST_CHARLES_JAR')
    java = os.environ.get('CHLS_TEST_JAVA', 'java')
    if not jar:
        pytest.skip('Set CHLS_TEST_CHARLES_JAR to enable real Charles import validation')
    file, rows = compatibility_har
    target = file.with_suffix('.xml')
    result = subprocess.run([java, '-Djava.awt.headless=true',
                             f'-Djava.library.path={Path(jar).parent}', '-jar', jar,
                             'convert', str(file), str(target)],
                            capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stdout + result.stderr
    assert target.exists(), result.stdout + result.stderr
    transactions = ElementTree.parse(target).findall('transaction')
    assert len(transactions) == len(rows)
    assert transactions[0].get('method') == 'GET'
    for transaction, row in zip(transactions[1:], rows[1:]):
        assert transaction.get('host').strip('[]') == row['host']
        assert int(transaction.get('port')) == 8443
        assert int(transaction.get('totalSize')) == 8292
        assert int(transaction.find('request').get('body')) == 100
        assert int(transaction.find('response').get('body')) == 8192
        assert transaction.get('status') == {'complete': 'COMPLETE', 'pending': 'CONNECTED', 'error': 'EXCEPTION'}[row['state']]
        assert transaction.get('method') == ('CONNECT' if row['transport'] == 'tcp' else 'CONNECT-UDP')


def test_default_har_excludes_connection_summaries(compatibility_har, tmp_path):
    _, rows = compatibility_har
    file = export_har(tmp_path, {'id': 'strict'}, [json.dumps(row) for row in rows])
    try:
        log = json.loads(file.read_text('utf-8'))['log']
        assert len(log['entries']) == 1
        assert log['entries'][0]['request']['method'] == 'GET'
        assert '_chlsTunnels' not in log
        assert 'comment' not in log
    finally:
        file.unlink()
