"""Ordered rules. A terminal request action stops request processing only."""
import json
import re
from pathlib import Path
from typing import Literal

from mitmproxy import http
from pydantic import BaseModel, Field, ValidationInfo, model_validator

from .hosts import flow_host, hostname
from .rewrite import RewriteOptions, REQUEST_ACTIONS, apply_rewrite, validate_spec


class Rule(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    kind: Literal['block', 'map_local', 'rewrite']
    phase: Literal['request', 'response', 'both'] = 'request'
    host: str = ''
    path: str = ''
    query: str | None = None
    method: str = ''
    match: Literal['contains', 'exact', 'regex'] = 'contains'
    action: Literal['header', 'body', 'json', 'url', 'host', 'path', 'status', 'header_add', 'header_modify', 'header_remove', 'query_add', 'query_modify', 'query_remove'] = 'header'
    rewrite: RewriteOptions | None = None
    key: str = ''
    value: str = ''
    remove: bool = False
    status: int = Field(default=200, ge=100, le=599)
    disconnect: bool = False
    file: str = ''
    content_type: str = 'application/json'

    @model_validator(mode='after')
    def validate_rule(self, info: ValidationInfo):
        if self.match != 'regex':
            if self.path.startswith(('https://', 'http://')):
                from urllib.parse import urlsplit
                url = urlsplit(self.path)
                self.host = url.hostname or self.host
                self.path, self.query = url.path or '/', url.query
            elif self.query is not None and '?' in self.path:
                self.path, self.query = self.path.split('?', 1)
        if self.match == 'regex':
            if self.query and len(self.query) > 500:
                raise ValueError('Query regex is too long')
            if len(self.path) > 500:
                raise ValueError('Regex is too long')
            try:
                re.compile(self.path)
                if self.query:
                    re.compile(self.query)
            except re.error as exc:
                raise ValueError(f'Некорректное выражение: {exc}') from exc
        if self.kind == 'rewrite':
            if self.action in REQUEST_ACTIONS and self.phase != 'request':
                raise ValueError('Host, Path, URL и query-параметры изменяются только в запросе')
            if self.action == 'status' and self.phase != 'response':
                raise ValueError('Response Status применяется только к ответу')
            if self.action not in ('header', 'json', 'body', 'url') and self.rewrite is None:
                raise ValueError('Укажите параметры поиска и замены')
            if self.rewrite is not None and self.action not in ('header', 'json'):
                validate_spec(self.action, self.rewrite)
            if self.action in ('header', 'json') and not self.key:
                raise ValueError('Укажите имя заголовка или путь JSON')
            if self.action == 'header' and any(c in self.key + self.value for c in '\r\n'):
                raise ValueError('Переносы строк в заголовках запрещены')
            if self.action == 'json' and not self.remove:
                json.loads(self.value)
            if self.action == 'url' and self.rewrite is None and not self.value.startswith(('http://','https://')):
                raise ValueError('URL должен начинаться с http:// или https:// и применяться к запросу')
            if self.action == 'body' and self.rewrite is None and not self.key:
                raise ValueError('Укажите текст для поиска')
        if self.kind == 'map_local' and not (info.context or {}).get('loading') and not Path(self.file).is_file():
            raise ValueError('Локальный файл не найден')
        return self


def matches(rule: Rule, flow: http.HTTPFlow) -> bool:
    request = flow.request
    location = flow.metadata.get('rule_location', {})
    host = location.get('host', flow_host(flow))
    wanted = rule.host.lower().strip().rstrip('.')
    if wanted.startswith('*.'):
        suffix = wanted[2:]
        if host != suffix and not host.endswith('.' + suffix):
            return False
    elif wanted and host != wanted and hostname(location.get('destination_host', request.host)) != wanted:
        return False
    if rule.method and location.get('method', request.method).upper() != rule.method.upper():
        return False
    path = location.get('path', request.path)
    query = ''
    if rule.query is not None:
        path, _, query = path.partition('?')
    def compare(wanted, actual):
        if rule.match == 'exact':
            return actual == wanted
        if rule.match == 'regex':
            return re.search(wanted, actual) is not None
        return wanted in actual
    if rule.query and not compare(rule.query, query):
        return False
    return compare(rule.path, path)


def apply_rules(flow: http.HTTPFlow, rules: list[Rule], phase: str, max_body: int):
    flow.metadata.setdefault('rule_location', {'host': flow_host(flow), 'destination_host': flow.request.host,
                                             'method': flow.request.method, 'path': flow.request.path})
    trace = flow.metadata.setdefault('rules', [])
    for rule in rules:
        if not rule.enabled or (rule.phase if rule.kind == 'rewrite' else 'request') not in (phase, 'both') or not matches(rule, flow):
            continue
        entry = {'id': rule.id, 'name': rule.name, 'kind': rule.kind, 'phase': phase}
        try:
            if rule.kind == 'block':
                if rule.disconnect:
                    flow.kill()
                else:
                    flow.response = http.Response.make(rule.status, b'Blocked by CHLS', {'content-type': 'text/plain; charset=utf-8'})
                trace.append(entry)
                break
            if rule.kind == 'map_local':
                file = Path(rule.file)
                if file.stat().st_size > max_body:
                    raise ValueError('Файл превышает лимит буферизации')
                flow.response = http.Response.make(rule.status, file.read_bytes(), {'content-type': rule.content_type})
                trace.append(entry)
                break
            message = flow.request if phase == 'request' else flow.response
            if message is None:
                continue
            if rule.rewrite is not None and rule.action not in ('header', 'json'):
                hits = apply_rewrite(flow, phase, rule.action, rule.rewrite, max_body)
                entry.update(matched=bool(hits), matches=hits)
            elif rule.action == 'header':
                if rule.remove:
                    message.headers.pop(rule.key, None)
                else:
                    message.headers[rule.key] = rule.value
            elif rule.action == 'url':
                flow.request.url = rule.value
            else:
                if message.stream or message.raw_content is None:
                    raise ValueError('Тело передаётся потоком; правило пропущено')
                if len(message.raw_content) > max_body:
                    raise ValueError('Тело превышает лимит буферизации')
                if rule.action == 'body':
                    message.text = message.get_text(strict=True).replace(rule.key, rule.value)
                elif rule.action == 'json':
                    document = json.loads(message.get_text(strict=True))
                    parts = rule.key.split('.')
                    target = document
                    for part in parts[:-1]:
                        target = target[int(part)] if isinstance(target, list) else target[part]
                    key = int(parts[-1]) if isinstance(target, list) else parts[-1]
                    if rule.remove:
                        del target[key]
                    else:
                        target[key] = json.loads(rule.value)
                    message.text = json.dumps(document, ensure_ascii=False)
                message.headers.pop('etag', None)
                message.headers.pop('content-md5', None)
            trace.append(entry)
        except Exception as exc:
            trace.append({**entry, 'error': str(exc)})
    if phase == 'response' and flow.response and flow.response.status_code in (204, 304):
        # These statuses cannot carry a message body. Normalize after all rules,
        # including a later Body rule, so HTTP/1 keepalive framing stays valid.
        flow.response.raw_content = b''
        for header in ('content-length', 'transfer-encoding', 'content-encoding'):
            flow.response.headers.pop(header, None)
