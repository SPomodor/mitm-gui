"""Search/replace operations for HTTP messages, with explicit empty values."""
import re
from ipaddress import ip_address
from urllib.parse import urlsplit

from mitmproxy import http
from mitmproxy.net.http import status_codes
from pydantic import BaseModel, Field

from .hosts import display_url, flow_host

REQUEST_ACTIONS = {'host', 'path', 'url', 'query_add', 'query_modify', 'query_remove'}
ADVANCED_ACTIONS = REQUEST_ACTIONS | {'header_add', 'header_modify', 'header_remove', 'status', 'body'}
FIELD_ACTIONS = {'header_modify', 'header_remove', 'query_modify', 'query_remove'}


class RewriteOptions(BaseModel):
    search_name: str = Field(default='', max_length=500)
    search_value: str = Field(default='', max_length=10000)
    replacement_name: str = Field(default='', max_length=1000)
    replacement_value: str | None = Field(default=None, max_length=8 * 1024 * 1024)
    regex: bool = False
    whole_value: bool = False
    case_sensitive: bool = True
    replace_all: bool = True


def pattern(search: str, opts: RewriteOptions, name=False):
    expression = search if opts.regex else re.escape(search)
    return re.compile(expression, re.IGNORECASE if name or not opts.case_sensitive else 0)


GROUP_REFERENCE = re.compile(r'\$\$|\$(\d+)|\$\{([A-Za-z_][A-Za-z_0-9]*|\d+)\}')


def expand_replacement(template: str, match: re.Match) -> str:
    def expand(token):
        if token.group() == '$$':
            return '$'
        group = token.group(1) or token.group(2)
        return match.group(int(group) if group.isdigit() else group) or ''
    return GROUP_REFERENCE.sub(expand, template)


def validate_spec(action: str, opts: RewriteOptions):
    if opts.regex:
        if len(opts.search_value) > 500:
            raise ValueError('Regex не должен превышать 500 символов')
        for search, replacement in ((opts.search_name, opts.replacement_name), (opts.search_value, opts.replacement_value)):
            try:
                compiled = re.compile(search)
            except re.error as exc:
                raise ValueError(f'Некорректный regex: {exc}') from exc
            for token in GROUP_REFERENCE.finditer(replacement or ''):
                group = token.group(1) or token.group(2)
                if group and (int(group) > compiled.groups if group.isdigit() else group not in compiled.groupindex):
                    raise ValueError(f'Группа ${group} отсутствует в выражении соответствующего поля')
    if action.endswith('_add'):
        if not opts.replacement_name:
            raise ValueError('Укажите имя добавляемого заголовка или параметра')
    elif not action.endswith('_remove') and opts.replacement_value is None and not (action in FIELD_ACTIONS and opts.replacement_name):
        raise ValueError('Укажите новое значение, новое имя или включите замену пустой строкой')
    if action.startswith('header_'):
        if opts.replacement_name and not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", opts.replacement_name) and not opts.regex:
            raise ValueError('Недопустимое имя заголовка')
        if any(c in (opts.replacement_value or '') + opts.replacement_name for c in '\r\n'):
            raise ValueError('Переносы строк в заголовках запрещены')


def replace_text(text: str, search: str, replacement: str | None, opts: RewriteOptions, name=False):
    if not search:
        return (text if replacement is None else replacement), 1
    compiled = pattern(search, opts, name)
    if (name and not opts.regex) or (not name and opts.whole_value):
        match = compiled.fullmatch(text)
        if match is None:
            return text, 0
        if replacement is None:
            return text, 1
        return (expand_replacement(replacement, match) if opts.regex else replacement), 1
    if replacement is None:
        return text, int(compiled.search(text) is not None)
    return compiled.subn(lambda match: expand_replacement(replacement, match) if opts.regex else replacement,
                         text, count=1 if name or not opts.replace_all else 0)


def change_fields(fields, opts: RewriteOptions, remove=False):
    result, hits = [], 0
    for name, value in fields:
        if hits and not opts.replace_all:
            result.append((name, value))
            continue
        _, name_matches = replace_text(name, opts.search_name, None, opts, name=True)
        new_value, value_matches = replace_text(value, opts.search_value, opts.replacement_value, opts)
        if not name_matches or not value_matches:
            result.append((name, value))
            continue
        hits += value_matches
        if not remove:
            new_name, _ = replace_text(name, opts.search_name, opts.replacement_name or None, opts, name=True)
            result.append((new_name, new_value))
    return result, hits


def checked_url(value: str):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.fragment or any(c.isspace() for c in value):
        raise ValueError('Нужен полный URL http(s) без пробелов и фрагмента #')
    _ = parsed.port
    return value


def apply_rewrite(flow: http.HTTPFlow, phase: str, action: str, opts: RewriteOptions, max_body: int) -> int:
    request = flow.request
    message = request if phase == 'request' else flow.response
    if message is None:
        return 0
    if action.startswith(('header_', 'query_')):
        is_header = action.startswith('header_')
        fields = list(message.headers.items(multi=True) if is_header else request.query.items(multi=True))
        if action.endswith('_add'):
            fields.append((opts.replacement_name, opts.replacement_value or ''))
            hits = 1
        else:
            fields, hits = change_fields(fields, opts, remove=action.endswith('_remove'))
        if hits:
            if is_header:
                headers = http.Headers()
                for name, value in fields:
                    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or '\r' in value or '\n' in value:
                        raise ValueError('Замена создаёт недопустимый заголовок')
                    headers.add(name, value)
                message.headers = headers
            else:
                request.query = fields
        return hits
    if action == 'host':
        value = flow_host(flow)
    elif action == 'path':
        value = request.path.partition('?')[0]
    elif action == 'url':
        value = display_url(request.pretty_url, flow_host(flow))
    elif action == 'status':
        value = str(message.status_code)
    elif action == 'body':
        if message.stream or message.raw_content is None:
            raise ValueError('Тело передаётся потоком; правило пропущено')
        if len(message.raw_content) > max_body:
            raise ValueError('Тело превышает лимит буферизации')
        value = message.get_text(strict=True)
        if len(value.encode('utf-8')) > max_body:
            raise ValueError('Распакованное тело превышает лимит буферизации')
    else:
        raise ValueError('Неизвестное действие Rewrite')
    result, hits = replace_text(value, opts.search_value, opts.replacement_value, opts)
    if not hits or result == value:
        return hits
    if action == 'host':
        try:
            ip_address(result.strip('[]'))
        except ValueError:
            if not re.fullmatch(r'[A-Za-z0-9.\-]+', result.encode('idna').decode()):
                raise ValueError('Host должен содержать только имя сервера или IP, без схемы, порта и пути')
        request.host = result.strip('[]')
    elif action == 'path':
        if not result.startswith('/') or '?' in result or '#' in result or any(c.isspace() for c in result):
            raise ValueError('Path должен начинаться с / и не содержать query, # или пробелы')
        _, separator, query = request.path.partition('?')
        request.path = result + (separator + query if separator else '')
    elif action == 'url':
        request.url = checked_url(result)
    elif action == 'status':
        if not re.fullmatch(r'[1-5][0-9]{2}', result):
            raise ValueError('Результат Response Status должен быть числом от 100 до 599')
        message.status_code = int(result)
        message.reason = '' if message.is_http2 or message.is_http3 else status_codes.RESPONSES.get(int(result), '')
    elif action == 'body':
        if len(result.encode('utf-8')) > max_body:
            raise ValueError('Результат замены превышает лимит буферизации')
        message.text = result
        message.headers.pop('etag', None)
        message.headers.pop('content-md5', None)
    return hits
