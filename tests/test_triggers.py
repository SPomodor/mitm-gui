import json

import pytest

from backend.mocks import MockError, MockModule, compile_scenario
from test_mocks import make_flow


ARRIVE = '/driver/v1/cargo-pro-api/grocery/v1/order/arrive-at-point'
CONFIRM = '/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm'
SOURCE = f'''модуль "Триггеры"
путь arrive = "{ARRIVE}"
путь confirm = "{CONFIRM}"
общие:
 GET /info -> 200 {{"stage":"common"}}
этап "one":
 POST arrive -> 201 {{"ack":"one"}}
 при POST arrive -> следующий
этап "two":
 GET /info -> 200 {{"stage":"two"}}
 при POST confirm -> следующий
этап "three":
 GET /info -> 200 {{"stage":"three"}}
 при POST confirm -> "four"
этап "four":
 GET /info -> 200 {{"stage":"four"}}
'''


def module_at(tmp_path, source=SOURCE):
    module = MockModule(tmp_path)
    module.install(compile_scenario(source, ''), dict(source=source, folder='', hosts=['*'], scope='/driver/', strict=False))
    module.enabled = True
    return module


def test_free_mode_and_successful_scenario_transition(tmp_path):
    module = module_at(tmp_path)
    flow = make_flow(ARRIVE, method='POST')
    assert module.handle(flow) and module.stage == 'one'
    assert flow.response.status_code == 201
    module.set_mode('scenario')
    flow = make_flow(ARRIVE, method='POST')
    module.handle(flow)
    assert module.stage == 'two'
    assert flow.response.status_code == 200 and flow.response.content == b''
    assert flow.metadata['mock']['stage'] == 'one'
    assert flow.metadata['mock']['transition']['destination'] == 'two'
    assert module.logs[-1]['transition']['source'] == 'one'
    poll = make_flow('/info')
    module.handle(poll)
    assert json.loads(poll.response.content)['stage'] == 'two'
    restored = MockModule(tmp_path)
    assert restored.mode == 'scenario' and restored.stage == 'one' and not restored.enabled


def test_repeated_trigger_does_not_skip_consecutive_confirm_stages(tmp_path):
    module = module_at(tmp_path)
    module.set_mode('scenario')
    now = [100.0]
    module.clock = lambda: now[0]
    module.handle(make_flow(ARRIVE, method='POST'))
    module.handle(make_flow(CONFIRM + '?order=one', method='POST'))
    assert module.stage == 'three'
    duplicate = make_flow(CONFIRM + '?order=one', method='POST')
    module.handle(duplicate)
    assert module.stage == 'three'
    assert 'Повтор' in duplicate.metadata['mock']['trigger_note']
    now[0] += 2.01
    module.handle(make_flow(CONFIRM + '?order=one', method='POST'))
    assert module.stage == 'four'
    # A terminal stage acknowledges known trigger requests without advancing.
    module.handle(make_flow(CONFIRM, method='POST'))
    assert module.stage == 'four'
    assert 'не настроен' in module.logs[-1]['trigger_note']


def test_explicit_request_identity_distinguishes_new_actions_from_retries(tmp_path):
    module = module_at(tmp_path)
    module.set_mode('scenario')
    module.clock = lambda: 100.0
    module.handle(make_flow(ARRIVE, method='POST'))
    first = make_flow(CONFIRM, method='POST')
    first.request.headers['Idempotency-Key'] = 'first'
    module.handle(first)
    assert module.stage == 'three'
    module.clock = lambda: 103.0
    module.handle(first)
    assert module.stage == 'three'
    second = make_flow(CONFIRM, method='POST')
    second.request.headers['Idempotency-Key'] = 'second'
    module.handle(second)
    assert module.stage == 'four'


def test_trigger_ignores_reply_but_wrong_method_scope_and_disabled_do_not_advance(tmp_path):
    module = module_at(tmp_path, SOURCE.replace('201 {"ack":"one"}', '409 {"error":"failed"}'))
    module.set_mode('scenario')
    flow = make_flow(ARRIVE, method='POST')
    module.handle(flow)
    assert module.stage == 'two'
    assert flow.response.status_code == 200 and flow.response.content == b''
    assert not module.handle(make_flow(ARRIVE, method='GET'))
    module.hosts = ['specific.test']
    assert not module.handle(make_flow(ARRIVE, method='POST'))
    module.enabled = False
    assert not module.handle(make_flow(ARRIVE, host='specific.test', method='POST'))


@pytest.mark.parametrize('status', [200, 201, 302, 400, 409, 500])
def test_active_trigger_always_returns_empty_200_regardless_of_configured_reply(tmp_path, status):
    module = module_at(tmp_path, SOURCE.replace('201 {"ack":"one"}', f'{status} {{"ignored":true}}'))
    free = make_flow(ARRIVE, method='POST')
    module.handle(free)
    assert free.response.status_code == status and module.stage == 'one'
    module.set_mode('scenario')
    automatic = make_flow(ARRIVE, method='POST')
    module.handle(automatic)
    assert automatic.response.status_code == 200
    assert automatic.response.content == b''
    assert module.stage == 'two'


@pytest.mark.parametrize('source', [
    'модуль "x"\nобщие:\n при POST /x -> следующий\nэтап "one":',
    'модуль "x"\nэтап "one":\n при POST /x -> следующий',
    'модуль "x"\nэтап "one":\n при POST /x -> "missing"',
    'модуль "x"\nэтап "one":\n при POST /x -> "one"',
    'модуль "x"\nэтап "one":\n при POST /x?bad=1 -> "two"\nэтап "two":',
    'модуль "x"\nэтап "one":\n при POST /x -> следующий\n при POST /x -> следующий\nэтап "two":',
])
def test_invalid_transitions_are_rejected_with_a_line_number(source):
    with pytest.raises(MockError, match='Строка'):
        compile_scenario(source, '')
