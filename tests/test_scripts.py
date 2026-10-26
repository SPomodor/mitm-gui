import asyncio
import json
import time

import pytest
from mitmproxy import http
from mitmproxy.test import tflow

from backend.scripts import ScriptRunner, ScriptModule
from backend.mocks import MockError
from backend.json_fields import Json, FieldError
from backend.rules import Rule, apply_rules


def flow(path='/api/order', method='GET'):
    result = tflow.tflow(resp=False)
    result.request = http.Request.make(method, 'https://api.test' + path)
    return result


SOURCE = '''from chls import Script, Scenario, response
app = Script("Order", hosts=["api.test"], path_prefix="/api/")
order = Scenario("order", initial="created")
app.use(order)

@order.get("/api/order", state="created")
def get_order(request, ctx):
    body = ctx.load_json("order.json")
    body.set("time", 42)
    ctx.state["calls"] = ctx.state.get("calls", 0) + 1
    return response(200, json=body)

@order.post("/api/confirm", state="created")
def confirm(request, ctx):
    ctx.goto("confirmed")
    return response(201, json={"success": True})

@order.get("/api/order", state="confirmed")
def confirmed(request, ctx):
    return response(200, json={"status": ctx.stage})
'''


def test_selectors_share_ambiguity_and_pointer_semantics():
    body = Json({'order': {'start': {'time': 1}}, 'items': [{'value': 2}]})
    assert body.get('time') == 1
    body.set('time', 3).set('items.0.value', False)
    assert body.get('/order/start/time') == 3
    assert body.get('value') is False
    body.data['time'] = 4
    with pytest.raises(FieldError, match='неоднозначно') as exc:
        body.set('time', 5)
    assert '/order/start/time' in str(exc.value) and '/time' in str(exc.value)
    assert body.data['time'] == 4
    body.set('/literal.key', None)
    assert body.get('/literal.key') is None
    body.remove('items.0.value')
    with pytest.raises(FieldError, match='не найдено'):
        body.get('missing')


def test_rewrite_short_name_nested_array_and_ambiguity():
    f = flow()
    f.response = http.Response.make(200, json.dumps({'items': [{'time': 1}]}), {'content-type': 'application/json'})
    rule = Rule(id='json', name='JSON', kind='rewrite', phase='response', action='json', key='time', value='false')
    apply_rules(f, [rule], 'response', 1024)
    assert json.loads(f.response.content)['items'][0]['time'] is False
    f.response.text = '{"time":1,"nested":{"time":2}}'
    before = f.response.content
    apply_rules(f, [rule], 'response', 1024)
    assert f.response.content == before
    assert 'неоднозначно' in f.metadata['rules'][-1]['error']


def test_process_scenario_snapshot_state_reset_and_persistence(tmp_path):
    (tmp_path / 'order.json').write_text('{"order":{"start":{"time":1}}}', 'utf-8')
    module = ScriptModule(tmp_path)
    runner = ScriptRunner(SOURCE, str(tmp_path))
    try:
        module.install(runner, dict(source=SOURCE, folder=str(tmp_path)))
        module.enabled = True
        (tmp_path / 'order.json').write_text('{"changed":true}', 'utf-8')
        f = flow('/api/order?x=1')
        assert asyncio.run(module.handle(f))
        assert json.loads(f.response.content)['order']['start']['time'] == 42
        assert runner.state == {'calls': 1}
        f = flow('/api/confirm', 'POST')
        assert asyncio.run(module.handle(f))
        assert f.response.status_code == 201 and runner.stage == 'confirmed'
        assert module.logs[-1]['transition']['destination'] == 'confirmed'
        assert not asyncio.run(module.handle(flow('/outside')))
        runner.reset()
        assert runner.stage == 'created' and runner.state == {}
    finally:
        module.close()
    reloaded = ScriptModule(tmp_path)
    try:
        assert reloaded.program and not reloaded.enabled
        assert reloaded.program.stage == 'created' and reloaded.program.state == {}
    finally:
        reloaded.close()


def test_error_rolls_back_state_and_response_hook(tmp_path):
    source = '''from chls import Script, response
app = Script("test")
@app.post("/api/fail")
def fail(request, ctx):
    ctx.state["changed"] = True
    return response(200, json={"bad": object()})
@app.get("/api/upstream")
def upstream(request, ctx):
    request.headers["X-Test"] = "yes"
    return None
@app.on_response
def rewrite(request, response, ctx):
    response.json.set("time", 123)
    ctx.state["response"] = True
'''
    runner = ScriptRunner(source, '')
    try:
        with pytest.raises(MockError, match='serializable'):
            runner.execute(flow('/api/fail', 'POST'), 'request')
        assert runner.state == {}
        f = flow('/api/upstream')
        runner.execute(f, 'request')
        assert f.request.headers['X-Test'] == 'yes' and f.response is None
        f.response = http.Response.make(200, '{"nested":{"time":1}}', {'content-type': 'application/json'})
        runner.execute(f, 'response')
        assert json.loads(f.response.content)['nested']['time'] == 123
        assert runner.state == {'response': True}
    finally:
        runner.close()


def test_infinite_handler_is_terminated_without_committing():
    source = '''from chls import Script
app = Script("hang")
@app.get("/api/order")
def hang(request, ctx):
    ctx.state["changed"] = True
    while True:
        pass
'''
    runner = ScriptRunner(source, '', timeout=0.2)
    try:
        started = time.monotonic()
        with pytest.raises(MockError, match='время выполнения'):
            runner.execute(flow(), 'request')
        assert time.monotonic() - started < 3
        assert not runner.process.is_alive() and runner.state == {}
    finally:
        runner.close()


def test_syntax_and_files_fail_before_install(tmp_path):
    with pytest.raises(MockError, match='Строка 1'):
        ScriptRunner('def broken(', '')
    with pytest.raises(MockError, match='внутри'):
        ScriptRunner('from chls import Script\napp = Script("bad")\napp.files = ["../outside.json"]', str(tmp_path))


def test_sessions_are_independent_and_response_uses_request_session():
    source = '''from chls import Script, response
app = Script("sessions")
app.session_key = lambda request: request.headers["X-Device-Id"]
@app.on_request
def incoming(request, ctx):
    ctx.state["calls"] = ctx.state.get("calls", 0) + 1
    return None
@app.on_response
def outgoing(request, reply, ctx):
    reply.json.set("time", ctx.state["calls"])
'''
    runner = ScriptRunner(source, '')
    try:
        first, second = flow(), flow()
        for f, key in [(first, 'one'), (second, 'two')]:
            f.request.headers['X-Device-Id'] = key
            runner.execute(f, 'request')
        runner.execute(second, 'request')
        first.response = http.Response.make(200, '{"time":0}')
        runner.execute(first, 'response')
        assert json.loads(first.response.content)['time'] == 1
        assert runner.sessions['one'][0]['calls'] == 1
        assert runner.sessions['two'][0]['calls'] == 2
        runner.reset()
        assert runner.sessions == {}
    finally:
        runner.close()


def test_legacy_conversion_preserves_explicit_response(tmp_path):
    from backend.script_migration import convert_legacy
    legacy = '''модуль "Миграция"
этап "one":
 POST /api/confirm -> 201 {"ok":true}
 при POST /api/confirm -> следующий
этап "two":
 GET /api/order -> 200 {"done":true}
'''
    source = convert_legacy(legacy, '')
    runner = ScriptRunner(source, '')
    try:
        f = flow('/api/confirm', 'POST')
        runner.execute(f, 'request')
        assert f.response.status_code == 201 and runner.stage == 'two'
        assert json.loads(f.response.content) == {'ok': True}
    finally:
        runner.close()


def test_order_template_loads_all_fixtures(tmp_path):
    import re
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / 'examples/order-187/scenario.py').read_text('utf-8')
    folder = tmp_path / '187'
    folder.mkdir(parents=True)
    for name in re.findall(r'"([^"\n/]+\.json)"', source):
        (folder / name).write_text(json.dumps({'fixture': name}), 'utf-8')
    runner = ScriptRunner(source, str(tmp_path))
    try:
        assert len(runner.info['stages']) == 7
        f = flow('/driver/v1/grocery-pro-bdu/v1/order/info')
        runner.execute(f, 'request')
        assert f.response.status_code == 200
        assert json.loads(f.response.content)['fixture'] == '0_income_order_info.json'
        init = '/driver/v1/cargo-pro-api/grocery/v1/order/exchange/init?device_id=test'
        # init is a local response at every stage, including the first request
        # from the app. It must never silently fall through to upstream.
        for stage, expected in [
            ('Собирается', '1_pickup_exchange_init.json'),
            ('В магазин', '1_pickup_exchange_init.json'),
            ('В магазине', '1_pickup_exchange_init.json'),
            ('К клиенту', '4_dropoff_exchange_init.json'),
            ('Передать заказ', '4_dropoff_exchange_init.json'),
            ('Вернуться', '6_complete_exchange_init.json'),
            ('Завершён', '6_complete_exchange_init.json'),
        ]:
            runner.reset(stage)
            f = flow(init, 'POST')
            runner.execute(f, 'request')
            assert f.response.status_code == 200
            assert json.loads(f.response.content)['fixture'] == expected
            assert runner.stage == stage
        for stage, expected, destination in [
            ('В магазине', '1_pickup_exchange_confirm.json', 'К клиенту'),
            ('Передать заказ', '4_dropoff_exchange_confirm.json', 'Вернуться'),
            ('Вернуться', '6_complete_exchange_confirm.json', 'Завершён'),
        ]:
            runner.reset(stage)
            runner.resume()
            f = flow('/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm', 'POST')
            runner.execute(f, 'request')
            assert json.loads(f.response.content)['fixture'] == expected
            assert runner.stage == destination
            assert runner.stopped is (stage == 'Передать заказ')
            if stage == 'Передать заказ':
                assert runner.execute(flow(init, 'POST'), 'request') is None
    finally:
        runner.close()


def test_http_framing_invalid_headers_and_streaming(tmp_path):
    source = '''from chls import Script, response
app = Script("framing")
@app.route("*", "/api/order")
def get_order(request, ctx):
    return response(200, json={"ok": True})
@app.get("/api/bad")
def bad(request, ctx):
    ctx.state["bad"] = True
    return response(200, headers={"X-Test": "bad\\r\\nheader"})
@app.get("/api/redirect")
def redirect(request, ctx):
    request.url = "https://different.test/target"
    return None
@app.get("/api/empty")
def empty(request, ctx):
    return response(204)
'''
    runner = ScriptRunner(source, '')
    try:
        f = flow(method='HEAD')
        runner.execute(f, 'request')
        assert f.response.raw_content == b'' and int(f.response.headers['content-length']) > 0
        f = flow('/api/bad')
        with pytest.raises(MockError, match='заголовок'):
            runner.execute(f, 'request')
        assert runner.state == {} and f.response is None
        f = flow('/api/redirect')
        runner.execute(f, 'request')
        assert f.request.host_header == 'different.test'
        f = flow('/api/empty')
        runner.execute(f, 'request')
        assert f.response.raw_content == b'' and 'content-length' not in f.response.headers
        module = ScriptModule(tmp_path)
        module.program, module.enabled, module.hosts, module.scope = runner, True, ['*'], '/'
        f = flow()
        f.request.stream = True
        assert not asyncio.run(module.handle(f)) and f.response is None
    finally:
        runner.close()


@pytest.mark.parametrize('reply', ['response(201, json={"done": True})', 'None'])
def test_stop_finishes_current_request_and_can_be_enabled_again(tmp_path, reply):
    source = f'''from chls import Script, response
app = Script("stop")
@app.get("/api/order")
def finish(request, ctx):
    ctx.state["calls"] = ctx.state.get("calls", 0) + 1
    ctx.stop()
    return {reply}
'''
    module = ScriptModule(tmp_path)
    runner = ScriptRunner(source, '')
    module.program, module.enabled, module.hosts, module.scope = runner, True, ['*'], '/'
    try:
        f = flow()
        handled = asyncio.run(module.handle(f))
        assert handled is (reply != 'None')
        if handled:
            assert f.response.status_code == 201 and json.loads(f.response.content) == {'done': True}
        else:
            assert f.response is None
        assert not module.enabled and runner.stopped
        assert runner.state == {'calls': 1}
        assert module.logs[-1]['stopped'] is True
        assert 'ctx.stop()' in module.logs[-1]['messages'][-1]
        assert not asyncio.run(module.handle(flow()))
        assert runner.execute(flow(), 'request') is None  # already queued requests also bypass
        runner.resume()
        module.enabled = True
        asyncio.run(module.handle(flow()))
        assert runner.state == {'calls': 2} and not module.enabled
    finally:
        module.close()


@pytest.mark.parametrize('failure', ['raise RuntimeError("failed")',
                                     'return response(200, json={"bad": object()})',
                                     'return response(200, headers={"X-Bad": "bad\\r\\nheader"})'])
def test_failed_handler_does_not_stop_script_or_commit_state(tmp_path, failure):
    source = f'''from chls import Script, response
app = Script("rollback stop")
@app.get("/api/order")
def finish(request, ctx):
    ctx.state["bad"] = True
    ctx.stop()
    {failure}
'''
    module = ScriptModule(tmp_path)
    runner = ScriptRunner(source, '')
    module.program, module.enabled, module.hosts, module.scope = runner, True, ['*'], '/'
    try:
        f = flow()
        assert asyncio.run(module.handle(f))
        assert f.response.status_code == 500
        assert module.enabled and not runner.stopped and runner.state == {}
    finally:
        module.close()


def test_stop_in_response_keeps_current_reply_and_skips_later_handlers(tmp_path):
    source = '''from chls import Script
app = Script("response stop")
@app.on_response
def finish(request, reply, ctx):
    reply.json.set("time", 42)
    ctx.state["done"] = True
    ctx.stop()
@app.on_response
def never(request, reply, ctx):
    raise RuntimeError("must not execute")
'''
    module = ScriptModule(tmp_path)
    runner = ScriptRunner(source, '')
    module.program, module.enabled, module.hosts, module.scope = runner, True, ['*'], '/'
    try:
        f = flow()
        assert not asyncio.run(module.handle(f))
        f.response = http.Response.make(200, '{"nested":{"time":1}}')
        asyncio.run(module.handle(f, 'response'))
        assert json.loads(f.response.content)['nested']['time'] == 42
        assert not module.enabled and runner.state == {'done': True}
        assert module.logs[-1]['stopped'] is True
    finally:
        module.close()
