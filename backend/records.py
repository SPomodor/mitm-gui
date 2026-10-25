"""Common recording lifecycle and compatibility for old history records."""


def begin_recording(engine, flow):
    session = engine.store.session
    flow.metadata.update(session=session, recording=engine.recording,
                         generation=engine.generations.get(session, 0))


def can_record(engine, flow):
    session = flow.metadata.get('session')
    return (flow.metadata.get('recording', False)
            and flow.metadata.get('generation') == engine.generations.get(session, 0)
            and engine.store.db.execute('SELECT 1 FROM sessions WHERE id=?', (session,)).fetchone() is not None)


def normalize_record(item):
    if item.get('kind') == 'connection':
        return item
    if item.get('encrypted'):
        from urllib.parse import urlsplit
        parsed = urlsplit(item['url'])
        host = item.get('host') or parsed.hostname or ''
        port = item.get('port') or parsed.port or 443
        authority = f'[{host}]' if ':' in host else host
        excluded = {'encrypted', 'method', 'url', 'path', 'status', 'rules',
                    'original_host', 'original_path', 'original_method',
                    'request', 'response', 'original_request', 'original_response'}
        return {**{k: v for k, v in item.items() if k not in excluded},
                'kind': 'connection', 'protocol': item.get('method', 'TLS'),
                'endpoint': f'{authority}:{port}', 'port': port,
                'experimental': item.get('transport') == 'udp',
                'state': {'pending': 'open', 'complete': 'closed'}.get(item['state'], item['state'])}
    return {**item, 'kind': 'http'}
