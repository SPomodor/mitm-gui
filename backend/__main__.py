import argparse
import asyncio
import contextlib
import json
import logging
import os
import re
import time
from typing import Literal
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from mitmproxy import http, options
from mitmproxy.tools.dump import DumpMaster
from pydantic import BaseModel, Field, field_validator

from .network import addresses
from .rules import Rule, apply_rules
from .store import Store
from .har import export_har
from .bodies import body_document
from .hosts import display_url, flow_host
from .mocks import MockError
from .scripts import ScriptModule, ScriptRunner
from .script_migration import convert_legacy
from .tunnels import TunnelCapture, OpaqueNextLayer
from .records import begin_recording, can_record
from .ssl_policy import normalize_hosts, should_decrypt

MAX_BODY = 8 * 1024 * 1024
MAX_PREVIEW = 1024 * 1024
EXPORT_LOCK = asyncio.Lock()
TOKEN = os.environ.get('CHLS_TOKEN', '')
ROOT = Path(os.environ.get('CHLS_DATA', 'runtime')).resolve()
ROOT.mkdir(parents=True, exist_ok=True)


class CaptureConfig(BaseModel):
    ssl_proxying: bool = True
    ssl_scope: Literal['all', 'selected'] = 'all'
    ssl_hosts: list[str] = Field(default_factory=list)
    http: bool = True
    wireguard: bool = False
    port: int = Field(default=8080, ge=1024, le=65535)
    wg_port: int = Field(default=51820, ge=1024, le=65535)
    lan: bool = True
    endpoint: str = ''

    @field_validator('ssl_hosts')
    @classmethod
    def validate_ssl_hosts(cls, value):
        return normalize_hosts(value)


class Engine:
    def __init__(self):
        self.store = Store(ROOT)
        self.rules = []
        self.mocks = ScriptModule(ROOT)
        self.script_lock = asyncio.Lock()
        self.config = CaptureConfig(wireguard=True)
        self.clients = set()
        self.pending = {}
        self.recording = True
        self.generations = {}
        self.event = asyncio.Event()
        self.master = None
        self.lock = asyncio.Lock()
        self.errors = []
        self.ready = asyncio.Event()
        config_file = ROOT / 'capture.json'
        if config_file.exists():
            try:
                self.config = CaptureConfig.model_validate_json(config_file.read_text('utf-8'))
            except Exception as exc:
                self.errors.append(f'Настройки захвата сброшены: {exc}')
        rule_file = ROOT / 'rules.json'
        if rule_file.exists():
            try:
                items = json.loads(rule_file.read_text('utf-8'))
                for item in items:
                    try:
                        self.rules.append(Rule.model_validate(item, context={'loading': True}))
                    except Exception as exc:
                        self.errors.append(f'Правило не загружено: {exc}')
            except Exception as exc:
                self.errors.append(f'Не удалось прочитать rules.json: {exc}')

    def publish(self, message):
        self.pending[message.get('id', message['type'])] = message
        self.event.set()

    async def broadcast(self):
        while True:
            await self.event.wait()
            await asyncio.sleep(.12)
            batch = list(self.pending.values())
            self.pending.clear()
            self.event.clear()
            for queue in list(self.clients):
                if queue.full():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                    queue.put_nowait([{'type': 'resync'}])
                else:
                    queue.put_nowait(batch)

    def status(self):
        servers = []
        if self.master:
            for server in self.master.addons.get('proxyserver').servers:
                item = server.to_json()
                item.pop('wireguard_conf', None)
                servers.append(item)
        return {'recording': self.recording, 'running': any(s.get('is_running') for s in servers), 'servers': servers, 'config': self.config.model_dump(), 'session': self.store.session, 'errors': self.errors[-10:], 'addresses': addresses(), 'max_body_mb': MAX_BODY // 1024 // 1024}

    async def stop(self):
        proxyserver = self.master.addons.get('proxyserver')
        # mitmproxy closes Rust listeners asynchronously without awaiting them.
        # Keep the handles so a quick Stop/Start cannot race the UDP socket.
        wireguard_servers = [listener for server in proxyserver.servers
                             if server.mode.type_name == 'wireguard'
                             for listener in server._servers]
        self.master.options.update(server=False)
        await proxyserver.setup_servers()
        # Explicitly close connections so Stop never leaves an invisible capture running.
        for connection in list(self.master.addons.get('proxyserver').connections.values()):
            connection.close_connection(connection.client)
        if wireguard_servers:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.gather(*(server.wait_closed() for server in wireguard_servers)), timeout=3)
        self.publish({'type': 'status'})



def snapshot(engine, flow, message, side):
    if not message:
        return None
    data = message.raw_content
    return {'headers': list(message.headers.items(multi=True)), 'body_file': engine.store.body(flow.id, side, data), 'size': len(data) if data is not None else 0, 'streamed': bool(message.stream), 'http_version': message.http_version, 'url': getattr(message, 'url', None), 'method': getattr(message, 'method', None), 'status': getattr(message, 'status_code', None)}


class CaptureAddon:
    def __init__(self, engine):
        self.engine = engine

    def running(self):
        self.engine.ready.set()

    def tls_clienthello(self, data):
        # Tunnel TLS unchanged; ordinary HTTP and listeners remain active.
        destination, port = data.context.server.address or ('', 443)
        decision = self.engine.tunnels.decisions.pop(data.context.client.id, None)
        data.ignore_connection = not (decision if decision is not None else should_decrypt(self.engine.config, data.client_hello.sni, port, destination))

    def requestheaders(self, flow):
        begin_recording(self.engine, flow)

    def can_record(self, flow):
        return can_record(self.engine, flow)

    async def request(self, flow):
        if self.can_record(flow):
            flow.metadata['original_request'] = snapshot(self.engine, flow, flow.request, 'original_request')
        # Each flow uses an immutable rule revision for request and response.
        flow.metadata['rule_revision'] = list(self.engine.rules)
        flow.metadata.setdefault('rule_location', {'host': flow_host(flow), 'destination_host': flow.request.host,
                                                  'method': flow.request.method, 'path': flow.request.path})
        handled = await self.engine.mocks.handle(flow)
        if flow.metadata.get('_script_revision') is not None:
            self.engine.publish({'type': 'mocks'})
        if not handled:
            apply_rules(flow, flow.metadata['rule_revision'], 'request', MAX_BODY)
        self.record(flow)

    async def response(self, flow):
        if self.can_record(flow):
            flow.metadata['original_response'] = snapshot(self.engine, flow, flow.response, 'original_response')
        if not flow.metadata.get('mock'):
            apply_rules(flow, flow.metadata.get('rule_revision', self.engine.rules), 'response', MAX_BODY)
        await self.engine.mocks.handle(flow, 'response')
        if flow.metadata.get('_script_revision') is not None:
            self.engine.publish({'type': 'mocks'})
        self.record(flow)

    def error(self, flow):
        self.record(flow)

    def record(self, flow):
        if not self.can_record(flow):
            return
        request, response = flow.request, flow.response
        started = request.timestamp_start
        ended = response.timestamp_end if response else flow.timestamp_end
        host = flow_host(flow)
        summary = {'kind': 'http', 'id': flow.id, 'session': flow.metadata.get('session', self.engine.store.session), 'started': started, 'method': request.method, 'url': display_url(request.pretty_url, host), 'host': host, 'destination_host': request.host, 'path': request.path, 'status': response.status_code if response else None, 'duration': round((ended-started)*1000) if ended else None, 'size': len(response.raw_content or b'') if response else 0, 'client': str(flow.client_conn.peername[0]) if flow.client_conn.peername else '', 'error': str(flow.error) if flow.error else None, 'rules': flow.metadata.get('rules', []), 'state': 'error' if flow.error else 'complete' if response else 'pending'}
        location = flow.metadata.get('rule_location', {})
        summary.update(original_host=location.get('host', host), original_path=location.get('path', request.path), original_method=location.get('method', request.method))
        detail = {**summary, 'mock': flow.metadata.get('mock'), 'request': snapshot(self.engine, flow, request, 'request'), 'response': snapshot(self.engine, flow, response, 'response'), 'original_request': flow.metadata.get('original_request'), 'original_response': flow.metadata.get('original_response')}
        self.engine.store.save(summary, detail)
        self.engine.publish({'type': 'flow', **summary})


engine = None


@asynccontextmanager
async def lifespan(app):
    global engine
    engine = Engine()
    opts = options.Options(confdir=str(ROOT / 'certificates'), server=False)
    engine.master = DumpMaster(opts, with_termlog=False, with_dumper=False)
    # Issue certificates from SNI without contacting the origin, so HTTPS mocks
    # work offline. Real upstream connections still use normal TLS verification.
    engine.master.options.update(stream_large_bodies='8m', body_size_limit='64m', upstream_cert=False, connection_strategy='lazy')
    capture = CaptureAddon(engine)
    engine.master.addons.remove(engine.master.addons.get('nextlayer'))
    engine.tunnels = TunnelCapture(engine)
    engine.master.addons.add(capture, engine.tunnels, OpaqueNextLayer(engine))
    master_task = asyncio.create_task(engine.master.run())
    broadcast_task = asyncio.create_task(engine.broadcast())
    ready_task = asyncio.create_task(engine.ready.wait())
    await asyncio.wait([master_task, ready_task], return_when=asyncio.FIRST_COMPLETED)
    if master_task.done():
        ready_task.cancel()
        master_task.result()
        raise RuntimeError('mitmproxy exited during startup')
    try:
        await start_capture(engine.config)
    except Exception as exc:
        # Keep the UI available to fix ports/settings when automatic start fails.
        reason = exc.detail if isinstance(exc, HTTPException) else str(exc)
        engine.errors.append(f'Не удалось автоматически начать захват: {reason}')
    yield
    engine.master.options.update(server=False)
    await engine.master.addons.get('proxyserver').setup_servers()
    engine.master.shutdown()
    await master_task
    broadcast_task.cancel()
    await asyncio.to_thread(engine.mocks.close)
    engine.store.archive_sessions()
    engine.store.db.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def authenticate(request: Request, call_next):
    # Only the Electron main process holds this per-launch secret.
    if not TOKEN or request.headers.get('authorization') != f'Bearer {TOKEN}':
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
    return await call_next(request)


@app.get('/status')
async def status():
    return engine.status()


async def start_capture(config: CaptureConfig):
    if not config.http and not config.wireguard:
        raise HTTPException(400, 'Включите хотя бы один способ подключения')
    async with engine.lock:
        if engine.config == config and engine.master.options.server and engine.status()['running'] and all(s.is_running for s in engine.master.addons.get('proxyserver').servers):
            return engine.status()
        await engine.stop()
        modes = []
        host = '0.0.0.0' if config.lan else '127.0.0.1'
        if config.http:
            modes.append(f'regular@{host}:{config.port}')
        if config.wireguard:
            modes.append(f'wireguard@{host}:{config.wg_port}')
        engine.config = config
        engine.master.options.update(mode=modes, server=True)
        ok = await engine.master.addons.get('proxyserver').setup_servers()
        if not ok or not all(s.is_running for s in engine.master.addons.get('proxyserver').servers):
            errors = [str(s.last_exception) for s in engine.master.addons.get('proxyserver').servers if s.last_exception]
            await engine.stop()
            raise HTTPException(409, '; '.join(errors) or 'Не удалось открыть порт')
        engine.publish({'type': 'status'})
        (ROOT / 'capture.json').write_text(config.model_dump_json(indent=2), 'utf-8')
    return engine.status()


@app.post('/capture/start')
async def start(config: CaptureConfig):
    return await start_capture(config)


@app.post('/capture/stop')
async def stop():
    async with engine.lock:
        await engine.stop()
    return engine.status()


class Toggle(BaseModel):
    enabled: bool


class SSLSettings(Toggle):
    scope: Literal['all', 'selected'] | None = None
    hosts: list[str] | None = None


@app.post('/recording')
async def recording(payload: Toggle):
    engine.recording = payload.enabled
    engine.publish({'type': 'status'})
    return engine.status()


@app.post('/capture/ssl')
async def ssl_proxying(payload: SSLSettings):
    values = engine.config.model_dump()
    values['ssl_proxying'] = payload.enabled
    if payload.scope is not None:
        values['ssl_scope'] = payload.scope
    if payload.hosts is not None:
        values['ssl_hosts'] = payload.hosts
    try:
        config = CaptureConfig.model_validate(values)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    temporary = (ROOT / 'capture.json').with_suffix('.tmp')
    temporary.write_text(config.model_dump_json(indent=2), 'utf-8')
    temporary.replace(ROOT / 'capture.json')
    engine.config = config
    engine.publish({'type': 'status'})
    return engine.status()


def invalidate_session(session):
    engine.generations[session] = engine.generations.get(session, 0) + 1
    for key, event in list(engine.pending.items()):
        if event.get('type') == 'flow' and event.get('session') == session:
            del engine.pending[key]


@app.delete('/sessions/{session_id}')
async def delete_session(session_id: str):
    if not any(s['id'] == session_id for s in engine.store.sessions()):
        raise HTTPException(404, 'Сессия не найдена')
    if session_id == engine.store.session:
        raise HTTPException(409, 'Идёт запись в эту сессию. Сначала создайте новую сессию')
    async with EXPORT_LOCK:
        invalidate_session(session_id)
        engine.store.clear(session_id)
        engine.store.db.execute('DELETE FROM sessions WHERE id=?', (session_id,))
        engine.store.db.commit()
    engine.publish({'type': 'resync'})
    return {'ok': True}


@app.get('/wireguard')
async def wireguard(endpoint: str = ''):
    if endpoint and not re.fullmatch(r'[a-zA-Z0-9.\-]+', endpoint):
        raise HTTPException(400, 'Укажите IPv4 или имя компьютера без порта')
    for server in engine.master.addons.get('proxyserver').servers:
        config = server.to_json().get('wireguard_conf')
        if config:
            host = endpoint or next((ip for ip in addresses() if not ip.startswith('127.')), '127.0.0.1')
            config = re.sub(r'Endpoint = .*', f'Endpoint = {host}:{engine.config.wg_port}', config)
            config += '\nPersistentKeepalive = 25\n'
            return {'config': config}
    raise HTTPException(409, 'Сначала запустите захват с WireGuard')


@app.get('/certificate')
async def certificate():
    file = ROOT / 'certificates' / 'mitmproxy-ca-cert.cer'
    if not file.exists():
        raise HTTPException(404, 'CA ещё не создан')
    return FileResponse(file, filename='chls-ca.cer')


@app.get('/rules')
async def rules():
    return engine.rules


class MockDocument(BaseModel):
    model_config = {'extra': 'forbid'}
    source: str = Field(max_length=200_000)
    folder: str = Field(default='', max_length=4096)


@app.get('/mocks')
async def mock_status():
    return engine.mocks.status()


@app.post('/mocks/convert')
async def mock_convert(document: MockDocument):
    try:
        source = await asyncio.to_thread(convert_legacy, document.source, document.folder)
        return {'source': source}
    except (ValueError, OSError) as error:
        raise HTTPException(422, str(error))


@app.post('/mocks/validate')
@app.put('/mocks')
async def mock_document(document: MockDocument, request: Request):
    program = None
    try:
        data = document.model_dump()
        program = await asyncio.to_thread(ScriptRunner, data['source'], data['folder'])
        if request.method == 'PUT':
            async with engine.script_lock:
                await asyncio.to_thread(engine.mocks.install, program, data)
            program = None
            engine.publish({'type': 'mocks'})
            return engine.mocks.status()
        return program.info
    except (MockError, OSError) as error:
        raise HTTPException(422, str(error))
    finally:
        if program:
            await asyncio.to_thread(program.close)


class MockControl(BaseModel):
    action: str
    stage: str = ''


@app.post('/mocks/control')
async def mock_control(command: MockControl):
    async with engine.script_lock:
        module = engine.mocks
        if command.action not in ('enable', 'disable', 'stage', 'reset', 'clear'):
            raise HTTPException(422, 'Неизвестная команда')
        if command.action in ('enable', 'stage', 'reset') and not module.program:
            raise HTTPException(409, 'Сначала примените корректный сценарий')
        if command.action == 'stage':
            if command.stage not in module.program.info['stages']:
                raise HTTPException(422, 'Этап не найден')
            await asyncio.to_thread(module.program.reset, command.stage)
        elif command.action == 'enable':
            try:
                await asyncio.to_thread(module.program.resume)
            except MockError as error:
                raise HTTPException(409, str(error))
            module.enabled = True
        elif command.action == 'disable':
            module.enabled = False
        elif command.action == 'reset':
            await asyncio.to_thread(module.program.reset)
            module.logs.clear()
        else:
            module.logs.clear()
        engine.publish({'type': 'mocks'})
        return module.status()


@app.put('/rules')
async def set_rules(rules: list[Rule]):
    if len(rules) > 500 or len({r.id for r in rules}) != len(rules):
        raise HTTPException(400, 'Не более 500 правил с уникальными ID')
    file = ROOT / 'rules.json'
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps([r.model_dump() for r in rules], ensure_ascii=False, indent=2), 'utf-8')
    temporary.replace(file)
    engine.rules = rules
    engine.publish({'type': 'rules'})
    return rules


@app.post('/rules/save')
async def save_rule(rule: Rule):
    rule_id = rule.id
    current = engine.rules
    updated = [rule if item.id == rule_id else item for item in current]
    if not any(item.id == rule_id for item in current):
        updated.append(rule)
    return await set_rules(updated)


@app.get('/sessions')
async def sessions():
    return engine.store.sessions()


@app.post('/sessions')
async def new_session():
    item = engine.store.new_session()
    engine.publish({'type': 'status'})
    return item


@app.post('/sessions/close')
async def close_sessions():
    engine.store.archive_sessions()
    return {'ok': True}


class SessionRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@app.put('/sessions/{session_id}')
async def rename_session(session_id: str, payload: SessionRename):
    name = payload.name.strip()
    if not name or any(ord(c) < 32 for c in name):
        raise HTTPException(422, 'Введите название сессии без переносов строк')
    if not engine.store.rename_session(session_id, name):
        raise HTTPException(404, 'Сессия не найдена')
    engine.publish({'type': 'status'})
    return {'id': session_id, 'name': name}


@app.get('/sessions/{session_id}/export')
async def session_export(session_id: str, format: Literal['http', 'charles'] = 'http'):
    async with EXPORT_LOCK:
        engine.tunnels.flush()
        snapshot = engine.store.export_snapshot(session_id)
        if snapshot is None:
            raise HTTPException(404, 'Сессия не найдена')
        file = await asyncio.to_thread(export_har, ROOT, *snapshot, include_connections=format == 'charles')
    return FileResponse(file, media_type='application/json; charset=utf-8', filename='session.har',
                        background=BackgroundTask(file.unlink, missing_ok=True))


@app.get('/flows')
async def flows(session: str = ''):
    engine.tunnels.flush()
    return engine.store.flows(session or engine.store.session)


@app.delete('/flows')
async def clear(session: str):
    async with EXPORT_LOCK:
        invalidate_session(session)
        engine.store.clear(session)
    engine.publish({'type': 'resync'})
    return {'ok': True}


@app.get('/flows/{flow_id}')
async def detail(flow_id: str):
    engine.tunnels.flush()
    item = engine.store.detail(flow_id)
    if not item:
        raise HTTPException(404, 'Запрос не найден')
    for side in ('request', 'response', 'original_request', 'original_response'):
        message = item.get(side)
        if not message:
            continue
        file = ROOT / 'bodies' / message['body_file'] if message['body_file'] else None
        if not file or not file.exists():
            message.update(text='', truncated=False)
            continue
        try:
            document = body_document(message, ROOT, side)
            message['download_name'] = document['filename']
            text = document['text']
            if text is None:
                raise ValueError('Binary body')
            encoded = text.encode('utf-8')
            message['text'] = encoded[:MAX_PREVIEW].decode('utf-8', errors='ignore')
            message['truncated'] = len(encoded) > MAX_PREVIEW
            message['textual'] = True
        except Exception:
            message.update(text='Бинарное или неподдерживаемое содержимое. Сохраните тело в файл.', truncated=False, textual=False)
    return item


@app.get('/flows/{flow_id}/body/{side}')
async def body(flow_id: str, side: str, raw: bool = False):
    item = engine.store.detail(flow_id)
    if not item or side not in ('request', 'response', 'original_request', 'original_response') or not item.get(side) or not item[side]['body_file']:
        raise HTTPException(404, 'Тело не сохранено')
    if raw:
        return FileResponse(ROOT / 'bodies' / item[side]['body_file'], filename=f'{side}.bin')
    try:
        document = body_document(item[side], ROOT, side)
    except (ValueError, OSError) as error:
        raise HTTPException(422, 'Не удалось декодировать тело') from error
    return Response(document['content'], media_type=document['media_type'],
                    headers={'Content-Disposition': f'attachment; filename="{document["filename"]}"'})


@app.get('/flows/{flow_id}/body/{side}/text')
async def full_body_text(flow_id: str, side: str):
    item = engine.store.detail(flow_id)
    if not item or side not in ('request', 'response', 'original_request', 'original_response') or not item.get(side) or not item[side]['body_file']:
        raise HTTPException(404, 'Тело не сохранено')
    try:
        document = body_document(item[side], ROOT, side)
    except (ValueError, OSError) as error:
        raise HTTPException(422, 'Не удалось декодировать тело') from error
    if document['text'] is None:
        raise HTTPException(422, 'Тело содержит бинарные данные')
    return {'text': document['text']}


@app.websocket('/events')
async def events(websocket: WebSocket):
    if not TOKEN or websocket.headers.get('authorization') != f'Bearer {TOKEN}':
        await websocket.close(code=1008)
        return
    await websocket.accept()
    queue = asyncio.Queue(maxsize=32)
    engine.clients.add(queue)
    try:
        while True:
            try:
                batch = await asyncio.wait_for(queue.get(), timeout=20)
            except asyncio.TimeoutError:
                batch = [{'type': 'heartbeat', 'time': time.time()}]
            await websocket.send_json(batch)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        engine.clients.discard(queue)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if not TOKEN:
        raise SystemExit('CHLS_TOKEN must be set by the desktop launcher')
    # Never print WireGuard client profiles to logs (they contain private keys).
    logging.getLogger('mitmproxy.proxy.mode_servers').setLevel(logging.WARNING)
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning', ws='websockets-sansio', access_log=False)


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    main()
