"""One-way import of legacy .chls documents into reviewable Python source."""
import json
import shlex
from .mocks import compile_scenario, validate_scope


def migrate_policy(source, hosts, scope, strict):
    """Move the old GUI settings into visible Python, preserving old precedence."""
    hosts = validate_scope(hosts, scope)
    if not isinstance(strict, bool):
        raise ValueError('Сохранённая настройка strict должна быть true/false')
    return source.rstrip() + '\n\n# Область перенесена из настроек CHLS. Теперь её можно изменить здесь.\n' + (
        f'if app.hosts == []:\n    app.hosts = {hosts!r}\n'
        f'app.path_prefix = {scope!r}\n'
        f'app.unmatched = {"block" if strict else "forward"!r}\n')


def convert_legacy(source, folder):
    scenario = compile_scenario(source, folder)
    prefix = ''
    for raw in source.splitlines():
        tokens = shlex.split(raw.strip()) if raw.strip().startswith('файлы ') else []
        if tokens:
            prefix = tokens[1].rstrip('/\\') + '/'
    out = ['# Перенесено из .chls. Проверьте ответы переходов перед применением.',
           '# Нет скрытого 200 и автоматического подавления повторов.',
           'from chls import Script, Scenario, response', '',
           f'app = Script({scenario.name!r})', f'order = Scenario("order", initial={scenario.initial!r})',
           'app.use(order)', '']
    index = 0
    def handler(method, path, reply, stage=None, destination=None):
        nonlocal index
        index += 1
        decorator = f'@app.route({method!r}, {path!r})' if stage is None else f'@order.route({method!r}, {path!r}, state={stage!r})'
        out.extend([decorator, f'def handle_{index}(request, ctx):'])
        if destination:
            out.append(f'    ctx.goto({destination!r})')
        if reply is None:
            out.append('    return response(200)')
        elif not reply.body:
            out.append(f'    return response({reply.status})')
        elif reply.source == 'JSON в сценарии':
            out.append(f'    return response({reply.status}, json={json.loads(reply.body)!r})')
        else:
            out.append(f'    return response({reply.status}, file={prefix + reply.source!r})')
        out.append('')
    for reply in sorted(scenario.common, key=lambda r: r.method == '*'):
        handler(reply.method, reply.path, reply)
    for stage, replies in scenario.stages.items():
        triggers = scenario.triggers[stage]
        used = set()
        for trigger in triggers:
            reply = next((r for r in replies if r.path == trigger.path and r.method == trigger.method), None)
            if reply is None:
                reply = next((r for r in scenario.common if r.path == trigger.path and r.method in (trigger.method, '*')), None)
            handler(trigger.method, trigger.path, reply, stage, trigger.destination)
            used.add((trigger.method, trigger.path))
        for reply in sorted(replies, key=lambda r: r.method == '*'):
            if (reply.method, reply.path) not in used:
                handler(reply.method, reply.path, reply, stage)
    return '\n'.join(out)
