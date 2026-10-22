import gzip

import pytest
from mitmproxy import connection, http
from pydantic import ValidationError

from backend.rules import Rule, apply_rules, matches


@pytest.mark.parametrize('mode,path,query,expected', [
    ('exact', '/v1/items', 'q=one&q=two&keep=a%2Bb', True),
    ('exact', '/v1/items', 'q=other', False),
    ('exact', '/v1/items', '', True),
    ('contains', '/items', 'keep=a%2B', True),
    ('regex', r'^/v1/items$', r'^q=one.*keep=', True),
    ('regex', r'^/v1/items$', r'^absent=', False),
])
def test_separate_path_and_query_matching(mode, path, query, expected):
    rule = Rule(id='query', name='query', kind='block', match=mode, path=path, query=query)
    assert matches(rule, flow()) is expected


def test_pasted_url_and_legacy_query_rules():
    rule = Rule(id='url', name='URL', kind='block', match='exact', path='https://api.example.com/v1/items?q=one&q=two&keep=a%2Bb')
    assert rule.host == 'api.example.com'
    assert rule.path == '/v1/items' and rule.query == 'q=one&q=two&keep=a%2Bb'
    assert matches(rule, flow())
    legacy = Rule(id='old', name='Old', kind='block', match='regex', path=r'^/v1/items\?q=one')
    assert legacy.query is None and matches(legacy, flow())
    with pytest.raises(ValidationError):
        Rule(id='invalid', name='Invalid', kind='block', match='regex', query='[')


def flow():
    f = http.HTTPFlow(connection.Client(peername=('10.0.0.2', 40000), sockname=('10.0.0.1', 8080)),
                      connection.Server(address=('198.18.3.227', 443)))
    f.request = http.Request.make('GET', 'https://198.18.3.227/v1/items?q=one&q=two&keep=a%2Bb', headers={'Host':'api.example.com'})
    f.request.host_header = 'api.example.com'
    f.response = http.Response.make(200, 'Hello HELLO hello', {'content-type':'text/plain', 'etag':'old'})
    return f


def rewrite(action, phase='response', **spec):
    return Rule(id='test',name=action,kind='rewrite',phase=phase,action=action,rewrite=spec)


def apply(f, rule, phase='response'):
    apply_rules(f, [rule], phase, 1024 * 1024)
    assert not f.metadata['rules'][-1].get('error'), f.metadata['rules']


def test_status_change_updates_reason_and_respects_match():
    f = flow()
    apply(f, rewrite('status',search_value='200',replacement_value='404',whole_value=True))
    assert f.response.status_code == 404 and f.response.reason == 'Not Found'
    apply(f, rewrite('status',search_value='200',replacement_value='500',whole_value=True))
    assert f.response.status_code == 404
    assert f.metadata['rules'][-1]['matched'] is False


def test_bodyless_status_normalized_after_later_body_rule():
    f=flow()
    apply_rules(f,[rewrite('status',search_value='200',replacement_value='204'),rewrite('body',replacement_value='must not be sent')],'response',1024)
    assert f.response.status_code == 204 and f.response.raw_content == b''
    assert 'content-length' not in f.response.headers
    assert 'transfer-encoding' not in f.response.headers


def test_body_match_case_first_all_full_value_and_literal_backslashes():
    f = flow()
    apply(f, rewrite('body',search_value='hello',replacement_value=r'C:\new\1',case_sensitive=False,replace_all=False))
    assert f.response.text == r'C:\new\1 HELLO hello'
    apply(f, rewrite('body',search_value='HELLO',replacement_value='x',case_sensitive=True))
    assert f.response.text == r'C:\new\1 x hello'
    apply(f, rewrite('body',search_value='hello',replacement_value='no',whole_value=True))
    assert f.metadata['rules'][-1]['matched'] is False
    assert 'etag' not in f.response.headers


def test_regex_groups_dollars_and_empty_replacement_on_compressed_body():
    f = flow()
    f.response.headers['content-encoding'] = 'gzip'
    f.response.raw_content = gzip.compress(b'user=12; user=34;')
    apply(f, rewrite('body',search_value=r'user=(\d+)',replacement_value='id:$1 $$',regex=True))
    assert f.response.text == 'id:12 $; id:34 $;'
    assert gzip.decompress(f.response.raw_content).decode() == f.response.text
    assert int(f.response.headers['content-length']) == len(f.response.raw_content)
    apply(f, rewrite('body',search_value=r'id:\d+ \$;',replacement_value='',regex=True))
    assert f.response.text == ' '
    f.response.text = 'one\ntwo'
    apply(f, rewrite('body', search_value='(?s)(.*)',replacement_value='[$1]',regex=True,whole_value=True))
    assert f.response.text == '[one\ntwo]'


def test_query_actions_preserve_repeated_values_encoding_and_order():
    f = flow()
    apply(f, rewrite('query_modify','request', search_name='Q',search_value='o',replacement_value='X',case_sensitive=False,replace_all=False), 'request')
    assert list(f.request.query.items(multi=True)) == [('q','Xne'),('q','two'),('keep','a+b')]
    apply(f, rewrite('query_modify','request', search_name='q',search_value=r't(w)o',replacement_name='renamed',replacement_value='$1',regex=True), 'request')
    assert list(f.request.query.items(multi=True)) == [('q','Xne'),('renamed','w'),('keep','a+b')]
    apply(f, rewrite('query_add','request',replacement_name='q',replacement_value='space + slash/'), 'request')
    assert f.request.query.get_all('q') == ['Xne','space + slash/']
    apply(f, rewrite('query_remove','request',search_name='q',search_value='space'), 'request')
    assert f.request.query.get_all('q') == ['Xne'] and f.request.query['keep'] == 'a+b'


def test_header_rename_remove_and_duplicate_set_cookie():
    f=flow()
    f.response.headers.add('Set-Cookie','a=1')
    f.response.headers.add('Set-Cookie','b=2')
    apply(f, rewrite('header_modify',search_name='set-cookie',search_value='a=1',replacement_value='a=3',whole_value=True))
    assert f.response.headers.get_all('set-cookie') == ['a=3','b=2']
    apply(f, rewrite('header_add',replacement_name='Set-Cookie',replacement_value='c=4'))
    assert f.response.headers.get_all('set-cookie') == ['a=3','b=2','c=4']
    apply(f, rewrite('header_remove',search_name='Set-Cookie',replace_all=False))
    assert f.response.headers.get_all('set-cookie') == ['b=2','c=4']
    apply(f, rewrite('header_modify',search_name='(content)-(type)',replacement_name='X-$1-$2',regex=True))
    assert f.response.headers['X-content-type'] == 'text/plain'


def test_host_path_url_and_original_location_for_following_rules():
    f=flow()
    host = rewrite('host','request',search_value='api.',replacement_value='staging.')
    host.host = 'api.example.com'
    path = rewrite('path','request',search_value='/v1/',replacement_value='/v2/')
    path.host = 'api.example.com'
    apply_rules(f,[host,path], 'request',1024)
    assert f.request.host == 'staging.example.com'
    assert f.request.host_header == 'staging.example.com'
    assert f.request.path == '/v2/items?q=one&q=two&keep=a%2Bb'
    response = rewrite('status', search_value='200',replacement_value='404')
    response.host = 'api.example.com'
    apply(f,response)
    assert f.response.status_code == 404
    apply(f,rewrite('url','request',search_value=r'https://(.*?)/v2',replacement_value='http://$1:8080/new',regex=True),'request')
    assert f.request.host == 'staging.example.com' and f.request.port == 8080
    assert f.request.url.startswith('http://staging.example.com:8080/new/items?')


def test_both_phases_and_existing_rules_keep_their_behavior():
    f=flow()
    r=rewrite('header_add','both',replacement_name='X-Test',replacement_value='yes')
    apply(f,r,'request'); apply(f,r,'response')
    assert f.request.headers['X-Test'] == f.response.headers['X-Test'] == 'yes'
    legacy=Rule(id='legacy',name='old body',kind='rewrite',phase='response',action='body',key='Hello',value='')
    apply(f,legacy)
    assert f.response.text == ' HELLO hello'
    legacy_header=Rule(id='old-header',name='old header',kind='rewrite',phase='response',action='header',key='X-Legacy',value='ok')
    apply(f,legacy_header)
    assert f.response.headers['X-Legacy']=='ok'


@pytest.mark.parametrize('action,phase,spec',[
 ('status','request',{'replacement_value':'404'}),
 ('query_modify','both',{'replacement_value':'x'}),
 ('body','response',{'regex':True,'search_value':'[','replacement_value':'x'}),
 ('body','response',{'regex':True,'search_value':'(x)','replacement_value':'$2'}),
 ('header_add','response',{'replacement_name':'X-Test','replacement_value':'x\r\nInjected: yes'}),
])
def test_invalid_rewrite_rejected_at_save(action,phase,spec):
    with pytest.raises(ValidationError):
        rewrite(action,phase,**spec)


def test_bad_status_and_header_substitutions_are_atomic_and_reported():
    f=flow()
    apply_rules(f,[rewrite('status',replacement_value='oops')],'response',1024)
    assert f.response.status_code == 200 and f.metadata['rules'][-1]['error']
    apply_rules(f,[rewrite('header_modify',search_name='(.*)',replacement_name='$1 bad',regex=True)],'response',1024)
    assert f.response.headers['Content-Type']=='text/plain'
    assert f.metadata['rules'][-1]['error']
