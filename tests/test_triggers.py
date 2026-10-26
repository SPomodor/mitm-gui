import pytest
from backend.mocks import MockError, compile_scenario


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
