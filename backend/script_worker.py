"""One disposable Python process per applied script revision."""
import ast
import inspect
import json
import multiprocessing
import os
import sys
import threading
import traceback
from pathlib import Path

from . import script_api as api
from .mocks import validate_scope


def error_text(exc):
    if isinstance(exc, SyntaxError):
        return f'Строка {exc.lineno}: {exc.msg}'
    frames = traceback.extract_tb(exc.__traceback__)
    frame = next((f for f in reversed(frames) if f.filename == 'script.py'), None)
    return (f'Строка {frame.lineno}: ' if frame else '') + f'{type(exc).__name__}: {exc}'


def run_worker(pipe, source, folder):
    # Electron may terminate the engine on Windows without running Python's
    # shutdown handlers. Exit even if user code is currently looping.
    parent = multiprocessing.parent_process()
    if parent is not None:
        def watch_parent():
            from multiprocessing.connection import wait
            wait([parent.sentinel])
            os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()
    try:
        sys.modules['chls'] = api
        tree = ast.parse(source.lstrip('\ufeff'), filename='script.py')
        namespace = {'__name__': '__chls_script__', '__file__': 'script.py'}
        exec(compile(tree, 'script.py', 'exec'), namespace)
        app = namespace.get('app')
        if not isinstance(app, api.Script):
            raise ValueError('Объявите app = Script("Название")')
        if not isinstance(app.name, str) or not app.name or len(app.name) > 200:
            raise ValueError('Название скрипта: от 1 до 200 символов')
        if len(app.routes) > 1000:
            raise ValueError('Не более 1000 обработчиков')
        if not isinstance(app.hosts, list) or any(not isinstance(host, str) for host in app.hosts):
            raise ValueError('app.hosts должен быть списком доменов')
        if not isinstance(app.path_prefix, str) or len(app.path_prefix) > 1024:
            raise ValueError('app.path_prefix должен быть строкой до 1024 символов')
        hosts = validate_scope(app.hosts or ['*'], app.path_prefix)
        if app.unmatched not in ('forward', 'block'):
            raise ValueError('app.unmatched: выберите "forward" или "block"')
        if not isinstance(app.files, list) or len(app.files) > 1000 or any(not isinstance(file, str) for file in app.files):
            raise ValueError('app.files должен быть списком до 1000 имён файлов')
        for route in app.routes:
            if not isinstance(route.path, str) or not isinstance(route.method, str):
                raise ValueError('Метод и путь обработчика должны быть строками')
            if route.path != '*' and (not route.path.startswith('/') or '?' in route.path or '#' in route.path):
                raise ValueError('Путь обработчика должен начинаться с / без query и #')
            if inspect.iscoroutinefunction(route.handler):
                raise ValueError('Обработчики должны быть обычными def, без async')
            inspect.signature(route.handler).bind(None, None)
        for handler in app.response_handlers:
            if inspect.iscoroutinefunction(handler):
                raise ValueError('Обработчики должны быть обычными def, без async')
            inspect.signature(handler).bind(None, None, None)
        files = set(app.files)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ''
                if name == 'load_json' and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    files.add(node.args[0].value)
                if name == 'response':
                    files.update(kw.value.value for kw in node.keywords if kw.arg == 'file' and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str))
        root = Path(folder).resolve() if folder else None
        total, cache = 0, {}
        for name in files:
            if root is None:
                raise ValueError('Выберите папку JSON')
            file = (root / name).resolve()
            if not file.is_relative_to(root):
                raise ValueError('JSON-файл должен находиться внутри выбранной папки')
            if file not in cache:
                if file.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError('JSON-файл больше 8 MB')
                data = file.read_bytes()
                total += len(data)
                if total > 64 * 1024 * 1024:
                    raise ValueError('Общий размер JSON больше 64 MB')
                cache[file] = json.loads(data)
            api._fixtures[name] = cache[file]
        scenario = app.scenario
        if app.session_key is not None and not callable(app.session_key):
            raise ValueError('app.session_key должна быть функцией от request')
        pipe.send(dict(ok=True, name=app.name, hosts=hosts, path_prefix=app.path_prefix, unmatched=app.unmatched,
                       stages=scenario.stages if scenario else [], initial=scenario.initial if scenario else '',
                       response_handlers=len(app.response_handlers)))
    except BaseException as exc:
        pipe.send(dict(ok=False, error=error_text(exc)))
        pipe.close()
        return
    while True:
        try:
            command = pipe.recv()
        except EOFError:
            break
        try:
            if command['phase'] == 'key':
                request = api.Message(command['request'])
                key = app.session_key(request) if app.session_key else 'global'
                if not isinstance(key, str) or not key or len(key) > 200:
                    raise ValueError('Ключ контекста должен быть непустой строкой до 200 символов')
                pipe.send(dict(ok=True, key=key))
                continue
            ctx = api.Context(command['state'], command['stage'], scenario)
            request = api.Message(command['request'])
            result, handler_name, line = None, '', None
            if command['phase'] == 'request':
                candidates = [r for r in app.routes if r.method in ('*', request.method) and r.path in ('*', request.path)
                              and (r.state is None or r.state == ctx.stage)]
                # State-specific handlers override shared handlers; order is stable within each group.
                candidates.sort(key=lambda r: r.state is None)
                if candidates:
                    handler = candidates[0].handler
                    handler_name, line = handler.__name__, handler.__code__.co_firstlineno
                    result = handler(request, ctx)
                    if result is not None and not isinstance(result, api.Message):
                        raise TypeError('Верните response(...) или forward()/None')
            else:
                result = api.Message(command['response'])
                for handler in app.response_handlers:
                    handler_name, line = handler.__name__, handler.__code__.co_firstlineno
                    replacement = handler(request, result, ctx)
                    if replacement is not None:
                        if not isinstance(replacement, api.Message):
                            raise TypeError('Обработчик ответа должен вернуть response(...) или None')
                        result = replacement
                    if ctx._stop_requested:
                        break
            # Serialize before committing state. Invalid JSON or bodies roll back this invocation.
            if not isinstance(ctx.state, dict):
                raise TypeError('ctx.state должен оставаться словарём')
            if not isinstance(ctx.stage, str) or scenario and ctx.stage not in scenario.stages:
                raise ValueError('Неизвестное состояние. Используйте ctx.goto()')
            state = json.loads(json.dumps(ctx.state, ensure_ascii=False, allow_nan=False))
            if len(json.dumps(state).encode()) > 1024 * 1024:
                raise ValueError('Состояние скрипта больше 1 MB')
            request_wire = request.wire()
            response_wire = result.wire() if result is not None else None
            if response_wire is not None:
                status = response_wire['status']
                if not isinstance(status, int) or isinstance(status, bool) or not 200 <= status <= 599:
                    raise ValueError('Код ответа должен быть от 200 до 599')
                if status in (204, 304) and response_wire['content']:
                    raise ValueError('Ответ 204/304 должен быть пустым')
            pipe.send(dict(ok=True, request=request_wire, response=response_wire, state=state,
                           stage=ctx.stage, logs=ctx.logs, handler=handler_name, line=line,
                           stop=ctx._stop_requested))
        except BaseException as exc:
            pipe.send(dict(ok=False, error=error_text(exc)))
    pipe.close()
