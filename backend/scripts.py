"""Managed script revisions. Workers execute Python; the proxy owns HTTP and state."""
import copy
import json
import multiprocessing
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http
from .hosts import flow_host
from .mocks import MockError
from .script_migration import convert_legacy, migrate_policy
from .script_worker import run_worker


class ScriptRunner:
    def __init__(self, source, folder, timeout=2.0):
        if len(source) > 200_000:
            raise MockError('Скрипт слишком большой: максимум 200 000 символов')
        self.lock = threading.Lock()
        self.timeout, self.failed = timeout, ''
        self.stopped = False
        self.state, self.stage = {}, ''
        self.sessions, self.session_key = {}, 'global'
        context = multiprocessing.get_context('spawn')
        self.pipe, child = context.Pipe()
        self.process = context.Process(target=run_worker, args=(child, source, folder), daemon=True)
        try:
            self.process.start()
        except OSError as exc:
            self.pipe.close()
            child.close()
            raise MockError(f'Не удалось запустить процесс скрипта: {exc}') from exc
        child.close()
        try:
            self.info = self.receive(10)
            self.stage = self.info['initial']
        except BaseException:
            self.close()
            raise

    def receive(self, timeout):
        try:
            if not self.pipe.poll(timeout):
                raise TimeoutError(f'Скрипт превысил время выполнения ({timeout:g} с). Примените его заново.')
            result = self.pipe.recv()
        except (EOFError, OSError, TimeoutError) as exc:
            self.failed = str(exc) or 'Процесс скрипта завершился. Примените скрипт заново.'
            self.close()
            raise MockError(self.failed) from exc
        if not result.get('ok'):
            raise MockError(result['error'])
        return result

    def close(self):
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(timeout=1)
        self.pipe.close()

    def reset(self, stage=None):
        with self.lock:
            if stage is None:
                self.state = {}
                self.sessions = {}
            self.stage = self.info['initial'] if stage is None else stage
            if stage is not None:
                self.sessions[self.session_key] = (self.state, self.stage)

    def resume(self):
        with self.lock:
            if self.failed:
                raise MockError(self.failed)
            self.stopped = False

    def execute(self, flow, phase):
        with self.lock:
            # Requests queued before ctx.stop() must also bypass this revision.
            if self.stopped:
                return None
            if self.failed:
                raise MockError(self.failed)
            request = wire(flow.request)
            request['client'] = flow.client_conn.peername[0] if flow.client_conn.peername else ''
            if phase == 'request':
                self.pipe.send(dict(phase='key', request=request))
                key = self.receive(self.timeout)['key']
                flow.metadata['_script_session'] = key
            else:
                key = flow.metadata.get('_script_session', 'global')
            state, stage = self.sessions.get(key, ({}, self.info['initial']))
            if key not in self.sessions and len(self.sessions) >= 1000:
                raise MockError('Не более 1000 контекстов. Сбросьте состояние скрипта.')
            old_state, old_stage = copy.deepcopy(state), stage
            self.pipe.send(dict(phase=phase, request=request, response=wire(flow.response) if phase == 'response' else None,
                                state=state, stage=stage))
            result = self.receive(self.timeout)
            # Build both messages before changing live traffic or committing state.
            changed_request = flow.request.copy()
            changed_request.method = result['request']['method']
            import re
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", changed_request.method):
                raise MockError('Недопустимый HTTP-метод')
            changed_request.url = result['request']['url']
            if urlsplit(changed_request.url).scheme not in ('http', 'https'):
                raise MockError('URL запроса должен использовать http или https')
            host_header = changed_request.host_header
            if host_header is None:
                host_header = f'[{changed_request.host}]' if ':' in changed_request.host else changed_request.host
                if changed_request.port != (443 if changed_request.scheme == 'https' else 80):
                    host_header += f':{changed_request.port}'
            apply_message(changed_request, result['request'])
            if changed_request.url != flow.request.url and changed_request.host_header == flow.request.host_header:
                changed_request.host_header = host_header
            changed_response = None
            if result['response'] is not None:
                value = result['response']
                changed_response = http.Response.make(value['status'], b'')
                apply_message(changed_response, value)
                if changed_request.method == 'HEAD':
                    size = len(changed_response.content or b'')
                    if phase == 'response' and not size:
                        declared = dict((k.lower(), v) for k, v in value['headers']).get('content-length', '')
                        size = int(declared) if declared.isdigit() else 0
                    changed_response.raw_content = b''
                    changed_response.headers['content-length'] = str(size)
                if value['status'] in (204, 304):
                    changed_response.content = b''
                    for header in ('content-length', 'transfer-encoding', 'content-encoding'):
                        changed_response.headers.pop(header, None)
            sessions = {**self.sessions, key: (result['state'], result['stage'])}
            if len(json.dumps(sessions, ensure_ascii=False).encode()) > 4 * 1024 * 1024:
                raise MockError('Общий размер состояния больше 4 MB. Сбросьте состояние скрипта.')
            flow.request = changed_request
            if changed_response is not None:
                # Keep origin timestamps for forwarded responses.
                if phase == 'response' and flow.response:
                    changed_response.timestamp_start = flow.response.timestamp_start
                    changed_response.timestamp_end = flow.response.timestamp_end
                    changed_response.http_version = flow.response.http_version
                flow.response = changed_response
            self.state, self.stage = result['state'], result['stage']
            self.sessions, self.session_key = sessions, key
            result.update(old_stage=old_stage, state_changes={key: self.state.get(key) for key in old_state.keys() | self.state.keys()
                                                            if old_state.get(key) != self.state.get(key) or (key in old_state) != (key in self.state)})
            if result['stop']:
                self.stopped = True
            return result


def wire(message):
    if message is None:
        return None
    if message.stream or message.raw_content is None:
        raise MockError('Тело передаётся потоком; скрипт пропущен')
    if len(message.raw_content) > 8 * 1024 * 1024:
        raise MockError('Тело больше 8 MB')
    content = message.content
    if len(content) > 8 * 1024 * 1024:
        raise MockError('Распакованное тело больше 8 MB')
    return dict(content=content, headers=list(message.headers.items(multi=True)),
                status=getattr(message, 'status_code', 200), method=getattr(message, 'method', 'GET'),
                url=getattr(message, 'url', ''))


def apply_message(message, value):
    import re
    original = message.content
    headers = http.Headers()
    for name, item in value['headers']:
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or any(c in item for c in '\r\n'):
            raise MockError('Скрипт создал недопустимый заголовок')
        headers.add(name, item)
    message.headers = headers
    # The worker receives decoded bodies. mitmproxy re-encodes according to headers.
    message.content = value['content']
    if original != value['content']:
        message.headers.pop('etag', None)
        message.headers.pop('content-md5', None)


class ScriptModule:
    def __init__(self, root):
        self.root = Path(root)
        self.program = None
        self.source = self.folder = ''
        self.hosts, self.scope, self.strict = ['*'], '/', False
        self.enabled, self.revision = False, 0
        self.logs = deque(maxlen=200)
        self.load_error = ''
        file = self.root / 'script-module.json'
        if file.exists():
            try:
                data = json.loads(file.read_text('utf-8'))
                self.source, self.folder = data['source'], data['folder']
                if data.get('version') != 2:
                    self.source = migrate_policy(self.source, data['hosts'], data['scope'], data['strict'])
                self.program = ScriptRunner(self.source, self.folder)
                self.set_policy(self.program)
            except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
                self.load_error = str(exc)
        elif (self.root / 'mock-module.json').exists():
            # Preserve the old document as an editable draft; never execute legacy semantics.
            try:
                data = json.loads((self.root / 'mock-module.json').read_text('utf-8'))
                self.source, self.folder = data['source'], data['folder']
                self.source = migrate_policy(convert_legacy(self.source, self.folder), data['hosts'], data['scope'], data['strict'])
                self.load_error = 'Старый .chls переведён в Python вместе с областью действия. Проверьте и примените скрипт.'
            except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
                self.load_error = str(exc)

    def status(self):
        program = self.program
        return dict(source=self.source, folder=self.folder,
                    policy={key: program.info[key] for key in ('hosts', 'path_prefix', 'unmatched')} if program else None,
                    enabled=self.enabled, revision=self.revision, name=program.info['name'] if program else '',
                    stages=program.info['stages'] if program else [], stage=program.stage if program else '',
                    state=copy.deepcopy(program.state) if program else {}, logs=list(reversed(self.logs)),
                    session_key=program.session_key if program else 'global', sessions=len(program.sessions) if program else 0,
                    load_error=program.failed if program and program.failed else self.load_error,
                    applied=program is not None)

    def set_policy(self, program):
        self.hosts = program.info['hosts']
        self.scope = program.info['path_prefix']
        self.strict = program.info['unmatched'] == 'block'

    def install(self, program, data):
        data = dict(version=2, source=data['source'], folder=data['folder'])
        file = self.root / 'script-module.json'
        temporary = file.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
        temporary.replace(file)
        old = self.program
        self.program = program
        self.source, self.folder = data['source'], data['folder']
        self.set_policy(program)
        self.revision += 1
        self.load_error = ''
        if old:
            with old.lock:
                old.failed = 'Версия скрипта заменена'
                old.close()

    def close(self):
        if self.program:
            with self.program.lock:
                self.program.close()

    async def handle(self, flow, phase='request'):
        import asyncio
        program = self.program
        if not self.enabled or not program:
            return False
        if phase == 'request':
            if '*' not in self.hosts and flow_host(flow).lower().rstrip('.') not in self.hosts:
                return False
            path = urlsplit(flow.request.path).path
            if self.scope != '/' and path != self.scope.rstrip('/') and not path.startswith(self.scope.rstrip('/') + '/'):
                return False
            flow.metadata['_script_revision'] = self.revision
        elif flow.metadata.get('_script_revision') != self.revision:
            return False
        if phase == 'response' and not program.info['response_handlers']:
            return False
        message = flow.request if phase == 'request' else flow.response
        if message is None or message.stream or message.raw_content is None:
            flow.metadata.setdefault('rules', []).append(dict(id='script', name=program.info['name'], kind='script', phase=phase,
                                                            error='Потоковое тело: скрипт пропущен'))
            return False
        try:
            result = await asyncio.to_thread(program.execute, flow, phase)
            if result is None:
                return False
            # A newly applied revision must not inherit old state/log entries.
            if program is not self.program:
                return flow.response is not None
            if result['stop'] and program.stopped:
                self.enabled = False
            blocked = False
            if phase == 'request' and result['response'] is None and not result['handler'] and self.strict:
                flow.response = http.Response.make(501, b'{"error":"CHLS_SCRIPT_UNHANDLED"}', {'content-type': 'application/json'})
                blocked = True
            handled = phase == 'request' and flow.response is not None
            if result['handler'] or blocked:
                event = dict(time=time.time(), module=program.info['name'], stage=result['stage'], revision=self.revision,
                             method=flow.request.method, path=flow.request.path, status=flow.response.status_code if flow.response else None,
                             blocked=blocked, source=result['handler'] or 'Нет обработчика', line=result['line'], phase=phase,
                             messages=result['logs'] + (['Скрипт выключен: ctx.stop()'] if result['stop'] else []),
                             stopped=result['stop'], state_changes=result['state_changes'],
                             transition=dict(source=result['old_stage'], destination=result['stage'], line=result['line'])
                             if result['old_stage'] != result['stage'] else None)
                self.logs.append(event)
                flow.metadata.setdefault('rules', []).append(dict(id='script', name=event['source'], kind='script', phase=phase, matched=True, matches=1))
                if handled:
                    flow.metadata['mock'] = event
            return handled
        except Exception as exc:
            self.logs.append(dict(time=time.time(), module=program.info['name'], stage=program.stage, revision=self.revision,
                                  method=flow.request.method, path=flow.request.path, status=500, blocked=True,
                                  source=str(exc), line=None, phase=phase, error=str(exc)))
            flow.metadata.setdefault('rules', []).append(dict(id='script', name=program.info['name'], kind='script', phase=phase, error=str(exc)))
            if phase == 'request':
                flow.response = http.Response.make(500, json.dumps({'error': 'CHLS_SCRIPT_ERROR', 'detail': str(exc)}, ensure_ascii=False).encode(), {'content-type': 'application/json; charset=utf-8'})
                flow.metadata['mock'] = {'error': str(exc)}
                return True
            return False
