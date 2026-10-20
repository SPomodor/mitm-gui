import json
from pathlib import Path

import pytest
from mitmproxy.test import tflow
from mitmproxy import http

from backend.mocks import MockError, MockModule, compile_scenario, validate_scope


SOURCE = '''модуль "Заказ"
начало "Собирается"
путь info = "/driver/order/info"
общие:
  "/driver/state" -> 200 {"active":true}
  POST "/driver/seen" -> 200 пусто
этап "Собирается":
  info -> 200 "order.json"
этап "Завершён":
  info -> 200 {"id":"one","status":"completed"}
  "/driver/state" -> 200 {"active":false}
'''


def make_flow(path='/driver/order/info', host='api.test', method='GET'):
    flow = tflow.tflow()
    flow.request = http.Request.make(method, f'https://{host}{path}')
    return flow


def install(tmp_path):
    (tmp_path / 'order.json').write_text('{"id":"one","status":"assembling"}', 'utf-8')
    module = MockModule(tmp_path)
    scenario = compile_scenario(SOURCE, str(tmp_path))
    module.install(scenario, dict(source=SOURCE, folder=str(tmp_path), hosts=['api.test'], scope='/driver/', strict=True))
    return module


def test_stages_polling_methods_scope_and_disabled(tmp_path):
    module = install(tmp_path)
    assert not module.handle(make_flow())
    module.enabled = True
    for _ in range(3):
        flow = make_flow('/driver/order/info?poll=1')
        assert module.handle(flow)
        assert json.loads(flow.response.content)['status'] == 'assembling'
    assert module.stage == 'Собирается'
    assert module.handle(make_flow('/driver/seen', method='POST'))
    wrong_method = make_flow('/driver/seen', method='GET')
    assert module.handle(wrong_method) and wrong_method.response.status_code == 501
    assert not module.handle(make_flow(host='another.test'))
    assert not module.handle(make_flow('/driver-other/test'))
    module.stage = 'Завершён'
    flow = make_flow('/driver/state')
    module.handle(flow)
    assert json.loads(flow.response.content)['active'] is False
    module.strict = False
    assert not module.handle(make_flow('/driver/missing'))
    assert module.logs[-1]['stage'] == 'Завершён'


def test_fixture_snapshot_persistence_and_invalid_revision(tmp_path):
    module = install(tmp_path)
    module.enabled = True
    (tmp_path / 'order.json').write_text('{"new":true}', 'utf-8')
    flow = make_flow()
    module.handle(flow)
    assert json.loads(flow.response.content)['status'] == 'assembling'
    with pytest.raises(MockError, match='Строка'):
        compile_scenario(SOURCE.replace('order.json', 'missing.json'), str(tmp_path))
    assert module.enabled and module.stage == 'Собирается'
    reloaded = MockModule(tmp_path)
    assert not reloaded.enabled and reloaded.scenario and reloaded.stage == 'Собирается'
    assert reloaded.hosts == ['api.test']


def test_all_hosts_preserves_path_scope_and_persists(tmp_path):
    module = install(tmp_path)
    data = dict(source=SOURCE, folder=str(tmp_path), hosts=validate_scope(['*'], '/driver/'), scope='/driver/', strict=True)
    module.install(module.scenario, data)
    module.enabled = True
    for host in ('one.test', 'two.test', '127.0.0.1'):
        flow = make_flow(host=host)
        assert module.handle(flow)
        assert json.loads(flow.response.content)['status'] == 'assembling'
        missing = make_flow('/driver/missing', host=host)
        assert module.handle(missing) and missing.response.status_code == 501
        assert not module.handle(make_flow('/outside', host=host))
    module.strict = False
    assert not module.handle(make_flow('/driver/missing', host='three.test'))
    restored = MockModule(tmp_path)
    assert restored.hosts == ['*'] and not restored.enabled and not restored.load_error


@pytest.mark.parametrize('hosts', [[], [' '], ['*', 'api.test']])
def test_empty_and_ambiguous_hosts_are_clear_errors(hosts):
    with pytest.raises(MockError, match='домены|доменов|домен'):
        validate_scope(hosts, '/driver/')


@pytest.mark.parametrize('bad', [
    'модуль "x"\nэтап "one":\n /x -> 200 "../outside.json"',
    'модуль "x"\nэтап "one":\n /x -> 200 "missing.json"',
    'модуль "x"\nначало "missing"\nэтап "one":\n /x -> 200 пусто',
    'модуль "x"\nэтап "one":\n /x -> 204 {"a":1}',
    'модуль "x"\nэтап "one":\n /x -> 200 {broken}',
    'модуль "x"\nэтап "one":\n /x -> 200 пусто\n /x -> 200 пусто',
    'модуль "x"\nэтап "one":\n /x?y=1 -> 200 пусто',
    'модуль "x"\nэтап "one":\n выполнить "anything"',
    'модуль "x"\nэтап "one":\n /x ->',
])
def test_validation_rejects_unsafe_or_ambiguous_documents(tmp_path, bad):
    with pytest.raises(MockError):
        compile_scenario(bad, str(tmp_path))


def test_stage_specific_and_method_priority(tmp_path):
    source = '''модуль "Методы"
общие:
 GET /x -> 200 {"from":"common"}
этап "one":
 /x -> 200 {"from":"stage"}
 GET /x -> 201 {"from":"specific"}
'''
    module = MockModule(tmp_path)
    module.install(compile_scenario(source, ''), dict(source=source, folder='', hosts=['api.test'], scope='/', strict=True))
    module.enabled = True
    get = make_flow('/x')
    post = make_flow('/x', method='POST')
    module.handle(get)
    module.handle(post)
    assert get.response.status_code == 201
    assert json.loads(post.response.content)['from'] == 'stage'


def test_order_187_template_compiles_with_external_fixtures(tmp_path):
    import re
    source = (Path(__file__).resolve().parents[1] / 'examples' / 'order-187' / 'scenario.chls').read_text('utf-8')
    fixtures = tmp_path / 'order' / '187'
    fixtures.mkdir(parents=True)
    for filename in re.findall(r'-> 200 "([^"]+\.json)"', source):
        (fixtures / filename).write_text('{"fixture":true}', 'utf-8')
    scenario = compile_scenario(source, str(tmp_path))
    assert len(scenario.stages) == 7
    assert len(scenario.stages['Завершён']) == 5
    assert scenario.initial == 'Собирается'


@pytest.mark.parametrize('status', [204, 304])
def test_no_content_responses_have_no_content_length(tmp_path, status):
    source = f'модуль "Empty"\nэтап "one":\n /x -> {status} пусто'
    module = MockModule(tmp_path)
    module.install(compile_scenario(source, ''), dict(source=source, folder='', hosts=['api.test'], scope='/', strict=True))
    module.enabled = True
    flow = make_flow('/x')
    assert module.handle(flow)
    assert not flow.response.content
    assert 'content-length' not in flow.response.headers
