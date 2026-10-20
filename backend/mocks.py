"""Small declarative mock language. No eval, Python, JavaScript or network IO."""
import json
import re
import shlex
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http

from .hosts import flow_host


class MockError(ValueError):
    pass


@dataclass(frozen=True)
class Reply:
    method: str
    path: str
    status: int
    body: bytes
    source: str
    line: int


@dataclass(frozen=True)
class Scenario:
    name: str
    initial: str
    common: tuple
    stages: dict


def compile_scenario(source: str, folder: str) -> Scenario:
    if len(source) > 200_000:
        raise MockError('Сценарий слишком большой: максимум 200 000 символов')
    aliases, stages, common, cache = {}, {}, [], {}
    name = initial = None
    file_root = Path(folder).resolve() if folder else None
    base = file_root
    target = None
    count = 0
    for line_number, raw in enumerate(source.lstrip('\ufeff').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        try:
            if '->' in line:
                if target is None:
                    raise ValueError('Ответ должен находиться в блоке «общие» или «этап»')
                left, right = line.split('->', 1)
                tokens = shlex.split(left)
                if len(tokens) == 1:
                    method, selector = '*', tokens[0]
                elif len(tokens) == 2 and tokens[0] in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'):
                    method, selector = tokens
                else:
                    raise ValueError('Ожидается: [МЕТОД] путь -> код ответ')
                path = aliases.get(selector, selector)
                if not path.startswith('/') or '?' in path or '#' in path:
                    raise ValueError('Укажите точный путь без query string или объявленный псевдоним')
                parts = right.strip().split(maxsplit=1)
                if len(parts) != 2:
                    raise ValueError('Ожидается код и файл, JSON или «пусто»')
                status = int(parts[0])
                if not 200 <= status <= 599 or len(parts) != 2:
                    raise ValueError('Ожидается код 200–599 и файл, JSON или «пусто»')
                value = parts[1].strip()
                if value == 'пусто':
                    body, origin = b'', 'пусто'
                elif value.startswith(('{', '[')):
                    body = json.dumps(json.loads(value), ensure_ascii=False).encode('utf-8')
                    origin = 'JSON в сценарии'
                else:
                    files = shlex.split(value)
                    if len(files) != 1:
                        raise ValueError('Заключите имя JSON-файла в кавычки')
                    origin = files[0]
                    if base is None:
                        raise ValueError('Выберите папку с JSON-файлами')
                    file = (base / origin).resolve()
                    if not file.is_relative_to(base) or not file.is_relative_to(file_root):
                        raise ValueError('Файл должен находиться внутри выбранной папки')
                    if file not in cache:
                        if file.stat().st_size > 8 * 1024 * 1024:
                            raise ValueError('JSON-файл больше 8 MB')
                        data = file.read_bytes()
                        json.loads(data)
                        cache[file] = data
                        if sum(map(len, cache.values())) > 64 * 1024 * 1024:
                            raise ValueError('Общий размер JSON-файлов больше 64 MB')
                    body = cache[file]
                if status in (204, 304) and body:
                    raise ValueError('Ответы 204/304 должны использовать «пусто»')
                if any(r.method == method and r.path == path for r in target):
                    raise ValueError('Повторный ответ для этого пути и метода в одном блоке')
                target.append(Reply(method, path, status, body, origin, line_number))
                count += 1
                if count > 1000:
                    raise ValueError('Не более 1000 ответов в сценарии')
                continue
            tokens = shlex.split(line)
            if len(tokens) == 2 and tokens[0] == 'модуль' and name is None:
                name = tokens[1]
            elif len(tokens) == 2 and tokens[0] == 'начало' and initial is None:
                initial = tokens[1]
            elif len(tokens) == 2 and tokens[0] == 'файлы' and target is None:
                if file_root is not None:
                    base = (file_root / tokens[1]).resolve()
                    if not base.is_relative_to(file_root):
                        raise ValueError('Папка файлов должна быть внутри выбранной папки')
            elif len(tokens) == 4 and tokens[0] == 'путь' and tokens[2] == '=' and target is None:
                if tokens[1] in aliases:
                    raise ValueError('Псевдоним уже объявлен')
                aliases[tokens[1]] = tokens[3]
            elif line == 'общие:' and target is None:
                target = common
            elif line.startswith('этап ') and line.endswith(':'):
                stage_tokens = shlex.split(line[:-1])
                if len(stage_tokens) != 2 or not stage_tokens[1] or stage_tokens[1] in stages:
                    raise ValueError('Имя этапа должно быть непустым и уникальным')
                if len(stages) >= 50:
                    raise ValueError('Не более 50 этапов')
                target = stages[stage_tokens[1]] = []
            else:
                raise ValueError('Неизвестная команда или неверный синтаксис')
        except (ValueError, OSError) as error:
            raise MockError(f'Строка {line_number}: {error}') from error
    if not name or not stages:
        raise MockError('Укажите название модуля и хотя бы один этап')
    initial = initial or next(iter(stages))
    if initial not in stages:
        raise MockError(f'Начальный этап «{initial}» не объявлен')
    return Scenario(name, initial, tuple(common), {key: tuple(value) for key, value in stages.items()})


def validate_scope(hosts, scope):
    hosts = [host.strip().lower().rstrip('.') for host in hosts if host.strip()]
    if not hosts:
        raise MockError('Укажите хотя бы один домен или включите «Все домены»')
    if '*' in hosts and hosts != ['*']:
        raise MockError('«Все домены» нельзя объединять со списком доменов')
    if hosts != ['*'] and (len(hosts) > 20 or any(not re.fullmatch(r'[a-z0-9][a-z0-9.\-]*', host) for host in hosts)):
        raise MockError('Укажите 1–20 точных доменов или IPv4 без протокола и порта')
    if not scope.startswith('/') or '?' in scope or '#' in scope:
        raise MockError('Префикс API должен начинаться с / и не содержать ? или #')
    return list(dict.fromkeys(hosts))


class MockModule:
    def __init__(self, root):
        self.root = root
        self.scenario = None
        self.source = self.folder = self.stage = ''
        self.hosts = []
        self.scope = '/driver/'
        self.strict = True
        self.enabled = False
        self.revision = 0
        self.logs = deque(maxlen=200)
        self.load_error = ''
        file = root / 'mock-module.json'
        if file.exists():
            try:
                data = json.loads(file.read_text('utf-8'))
                self.source, self.folder = data['source'], data['folder']
                self.hosts = validate_scope(data['hosts'], data['scope'])
                self.scope, self.strict = data['scope'], data['strict']
                self.scenario = compile_scenario(self.source, self.folder)
                self.stage = self.scenario.initial
            except (ValueError, OSError, KeyError) as error:
                self.load_error = str(error)

    def status(self):
        return dict(source=self.source, folder=self.folder, hosts=self.hosts, scope=self.scope,
                    strict=self.strict, enabled=self.enabled, stage=self.stage, revision=self.revision,
                    name=self.scenario.name if self.scenario else '', stages=list(self.scenario.stages) if self.scenario else [],
                    logs=list(reversed(self.logs)), load_error=self.load_error)

    def install(self, scenario, data):
        # Persist first; a failed save must leave the active revision untouched.
        file = self.root / 'mock-module.json'
        temporary = file.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
        temporary.replace(file)
        self.scenario = scenario
        self.source, self.folder = data['source'], data['folder']
        self.hosts, self.scope, self.strict = data['hosts'], data['scope'], data['strict']
        self.stage = scenario.initial
        self.revision += 1
        self.load_error = ''

    def handle(self, flow):
        if not self.enabled or not self.scenario or ('*' not in self.hosts and flow_host(flow).lower().rstrip('.') not in self.hosts):
            return False
        path = urlsplit(flow.request.path).path
        reply = None
        for group in (self.scenario.stages[self.stage], self.scenario.common):
            reply = next((r for r in group if r.path == path and r.method == flow.request.method), None)
            reply = reply or next((r for r in group if r.path == path and r.method == '*'), None)
            if reply:
                break
        if not reply and not (self.strict and (self.scope == '/' or path == self.scope.rstrip('/') or path.startswith(self.scope.rstrip('/') + '/'))):
            return False
        blocked = reply is None
        body = b'{"error":"CHLS_MOCK_UNHANDLED"}' if blocked else reply.body
        status = 501 if blocked else reply.status
        headers = {'Content-Type': 'application/json; charset=utf-8'} if body else {}
        flow.response = http.Response.make(status, b'' if flow.request.method == 'HEAD' else body, headers)
        if status in (204, 304):
            flow.response.headers.pop('Content-Length', None)
        elif flow.request.method == 'HEAD':
            flow.response.headers['Content-Length'] = str(len(body))
        event = dict(time=time.time(), module=self.scenario.name, stage=self.stage, revision=self.revision,
                     method=flow.request.method, path=flow.request.path, status=status, blocked=blocked,
                     source=reply.source if reply else 'Нет обработчика', line=reply.line if reply else None)
        self.logs.append(event)
        flow.metadata['mock'] = event
        flow.metadata.setdefault('rules', []).append({'id': 'mock-module', 'name': f'Мок · {self.scenario.name} · {self.stage}', 'kind': 'mock', 'phase': 'request', 'matched': True, 'matches': 1})
        return True
