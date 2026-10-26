import pytest
from backend.mocks import MockError, compile_scenario, validate_scope


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
