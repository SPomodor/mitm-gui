"""The public `mitm_gui` module (`chls` compatibility alias) installed inside script worker processes."""
import copy
import json as _json
from dataclasses import dataclass
from urllib.parse import urlsplit, parse_qs

from mitmproxy.http import Headers
from .json_fields import Json

_fixtures = {}
_MISSING = object()


class Message:
    def __init__(self, data):
        self.headers = Headers((k.encode('latin1'), v.encode('latin1')) for k, v in data.get('headers', []))
        self.content = data.get('content', b'')
        self.status = data.get('status', 200)
        self.method = data.get('method', 'GET')
        self.url = data.get('url', '')
        self.client = data.get('client', '')
        self._json = None

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        if not isinstance(value, (bytes, bytearray)):
            raise TypeError('content должен содержать bytes; для строки используйте text')
        self._content = bytes(value)
        self._json = None

    @property
    def path(self):
        return urlsplit(self.url).path

    @property
    def query(self):
        return parse_qs(urlsplit(self.url).query, keep_blank_values=True)

    @property
    def text(self):
        return self.content.decode('utf-8')

    @text.setter
    def text(self, value):
        self.content = value.encode('utf-8')
        self._json = None

    @property
    def json(self):
        if self._json is None:
            self._json = Json(_json.loads(self.content))
        return self._json

    def wire(self):
        content = self.content if self._json is None else _json.dumps(self._json.data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(content) > 8 * 1024 * 1024:
            raise ValueError('Тело больше 8 MB')
        return dict(headers=list(self.headers.items(multi=True)), content=content,
                    status=self.status, method=self.method, url=self.url)


def response(status=200, *, json=_MISSING, file=None, text=None, headers=None):
    if sum((json is not _MISSING, file is not None, text is not None)) > 1:
        raise ValueError('Выберите одно тело: json, file или text')
    message = Message(dict(status=status, headers=list((headers or {}).items())))
    if file is not None:
        json = load_json(file)
    if json is not _MISSING:
        message._json = json if isinstance(json, Json) else Json(json)
        message.headers['content-type'] = 'application/json; charset=utf-8'
    elif text is not None:
        message.text = text
        message.headers.setdefault('content-type', 'text/plain; charset=utf-8')
    return message


def load_json(file):
    if file not in _fixtures:
        raise ValueError(f'Файл «{file}» не включён в снимок. Укажите его в app.files или литералом в load_json()/response(file=...)')
    return Json(_fixtures[file])


@dataclass
class Route:
    method: str
    path: str
    handler: object
    state: str | None = None
    scenario: object = None


class Script:
    def __init__(self, name, *, hosts=None, path_prefix='/', unmatched='forward'):
        self.name = name
        self.hosts = [] if hosts is None else hosts
        self.path_prefix = path_prefix
        self.unmatched = unmatched
        self.files = []
        self.routes = []
        self.response_handlers = []
        self.scenario = None
        self.session_key = None

    def route(self, method, path):
        def register(handler):
            self.routes.append(Route(method.upper(), path, handler))
            return handler
        return register

    def get(self, path):
        return self.route('GET', path)

    def post(self, path):
        return self.route('POST', path)

    def on_request(self, handler):
        self.routes.append(Route('*', '*', handler))
        return handler

    def on_response(self, handler):
        self.response_handlers.append(handler)
        return handler

    def use(self, scenario):
        if self.scenario is not None:
            raise ValueError('Один сценарий на скрипт; используйте ctx.state для дополнительных состояний')
        self.scenario = scenario
        self.routes.extend(scenario.routes)
        scenario.app = self


class Scenario:
    def __init__(self, name, *, initial):
        self.name, self.initial = name, initial
        self.routes, self.app = [], None

    @property
    def stages(self):
        return list(dict.fromkeys([self.initial] + [r.state for r in self.routes if r.state is not None]))

    def route(self, method, path, *, state):
        def register(handler):
            route = Route(method.upper(), path, handler, state, self)
            self.routes.append(route)
            if self.app is not None:
                self.app.routes.append(route)
            return handler
        return register

    def get(self, path, *, state):
        return self.route('GET', path, state=state)

    def post(self, path, *, state):
        return self.route('POST', path, state=state)


class Context:
    def __init__(self, state, stage, scenario):
        self.state = copy.deepcopy(state)
        self.stage, self.scenario = stage, scenario
        self.logs = []
        self._stop_requested = False

    def stop(self):
        """Disable the whole script after this handler succeeds; keep its state."""
        self._stop_requested = True

    def goto(self, stage):
        if self.scenario is None or stage not in self.scenario.stages:
            raise ValueError(f'Неизвестное состояние: {stage}')
        self.stage = stage

    def load_json(self, file):
        return load_json(file)

    def log(self, value):
        if len(self.logs) < 50:
            self.logs.append(str(value)[:2000])


def forward():
    """Explicitly continue to ordinary mitm gui rules and the upstream server."""
    return None
