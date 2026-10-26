import asyncio
import json

import pytest
from mitmproxy import http
from mitmproxy.test import tflow

from backend.scripts import ScriptModule, ScriptRunner
from backend.mocks import MockError


def flow(path, host='api.test'):
    item = tflow.tflow(resp=False)
    item.request = http.Request.make('GET', f'https://{host}{path}')
    return item


def install(root, source):
    module = ScriptModule(root)
    module.install(ScriptRunner(source, ''), dict(source=source, folder=''))
    module.enabled = True
    return module


def test_default_policy_needs_no_external_configuration(tmp_path):
    source = '''from chls import Script, response
app = Script("defaults")
@app.get("/outside")
def reply(request, ctx):
    return response(201)
'''
    module = install(tmp_path, source)
    try:
        f = flow('/outside', 'other.test')
        assert asyncio.run(module.handle(f)) and f.response.status_code == 201
        assert not asyncio.run(module.handle(flow('/unknown')))
        assert module.status()['policy'] == dict(hosts=['*'], path_prefix='/', unmatched='forward')
        assert not {'hosts', 'scope', 'strict'} & module.status().keys()
        saved = json.loads((tmp_path / 'script-module.json').read_text('utf-8'))
        assert saved == dict(version=2, source=source, folder='')
    finally:
        module.close()


def test_script_policy_filters_hosts_and_prefix_and_blocks_unknown_paths(tmp_path):
    source = '''from chls import Script, response
app = Script("scoped", hosts=["API.TEST."], path_prefix="/api/", unmatched="block")
@app.get("/api/order")
def reply(request, ctx):
    return response(201)
'''
    module = install(tmp_path, source)
    try:
        f = flow('/api/order?device=1')
        assert asyncio.run(module.handle(f)) and f.response.status_code == 201
        unknown = flow('/api/unknown')
        assert asyncio.run(module.handle(unknown)) and unknown.response.status_code == 501
        assert not asyncio.run(module.handle(flow('/api-other/unknown')))
        assert not asyncio.run(module.handle(flow('/api/order', 'other.test')))
    finally:
        module.close()
    reloaded = ScriptModule(tmp_path)
    try:
        assert not reloaded.enabled and reloaded.program
        assert reloaded.status()['policy'] == dict(hosts=['api.test'], path_prefix='/api/', unmatched='block')
        assert reloaded.source == source
    finally:
        reloaded.close()


@pytest.mark.parametrize('code_hosts,expected_hosts', [('', ['legacy.test']),
    ('app.hosts = ["code.test"]', ['code.test'])])
def test_old_gui_settings_are_visible_in_code_and_preserve_precedence(tmp_path, code_hosts, expected_hosts):
    source = 'from chls import Script\napp = Script("old")\n' + code_hosts
    old = dict(source=source, folder='', hosts=['legacy.test'], scope='/legacy/', strict=True)
    file = tmp_path / 'script-module.json'
    file.write_text(json.dumps(old), 'utf-8')
    module = ScriptModule(tmp_path)
    try:
        assert module.program and not module.enabled
        assert module.status()['policy'] == dict(hosts=expected_hosts, path_prefix='/legacy/', unmatched='block')
        assert "app.path_prefix = '/legacy/'" in module.source
        assert "app.unmatched = 'block'" in module.source
        assert json.loads(file.read_text('utf-8')) == old  # original remains until Apply
        module.enabled = True
        f = flow('/legacy/unknown', expected_hosts[0])
        assert asyncio.run(module.handle(f)) and f.response.status_code == 501
        assert not asyncio.run(module.handle(flow('/outside', expected_hosts[0])))
        migrated_source = module.source
        module.install(ScriptRunner(migrated_source, ''), dict(source=migrated_source, folder=''))
    finally:
        module.close()
    reloaded = ScriptModule(tmp_path)
    try:
        assert reloaded.program and reloaded.source == migrated_source
        assert reloaded.source.count('# Область перенесена') == 1
    finally:
        reloaded.close()


def test_saved_legacy_dsl_converts_policy_but_requires_apply(tmp_path):
    legacy = 'модуль "old"\nэтап "one":\n GET /legacy/x -> 200 {}'
    old = dict(source=legacy, folder='', hosts=['old.test'], scope='/legacy/', strict=True)
    file = tmp_path / 'mock-module.json'
    file.write_text(json.dumps(old), 'utf-8')
    module = ScriptModule(tmp_path)
    assert module.program is None and not module.enabled
    assert 'from chls import' in module.source
    runner = ScriptRunner(module.source, '')
    try:
        assert runner.info['hosts'] == ['old.test']
        assert runner.info['path_prefix'] == '/legacy/' and runner.info['unmatched'] == 'block'
        assert json.loads(file.read_text('utf-8')) == old
    finally:
        runner.close()


@pytest.mark.parametrize('options', [dict(hosts=['https://bad/path']), dict(hosts=['*', 'api.test']),
    dict(path_prefix='api'), dict(path_prefix='/api?x'), dict(unmatched='ignore')])
def test_invalid_policy_rejected_at_validation(options):
    with pytest.raises(MockError):
        ScriptRunner(f'from chls import Script\napp = Script("invalid", **{options!r})', '')
