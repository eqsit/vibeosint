"""Offline contract test for the Hermes Serper plugin. No real API keys used."""
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

class BaseWebSearchProvider:
    def is_available(self): return bool(provider_env(self.KEY_ENV))
    def supports_search(self): return True
    def supports_extract(self): return False

key = 'FAKE-SERPER-KEY-NOT-A-SECRET'
def provider_env(k): return key if k == 'SERPER_API_KEY' else ''
def search_ok(rows): return {'success':True,'data':{'web':rows}}
def search_fail(err): return {'success':False,'error':err}
def setup_schema(*args, **kwargs): return {'name': args[0]}
common = types.ModuleType('plugins.web._common')
for name in ('BaseWebSearchProvider','provider_env','search_ok','search_fail','setup_schema'):
    setattr(common,name,globals()[name])
sys.modules['plugins.web._common']=common

project = Path(__file__).resolve().parents[1]
staged_plugin = project / 'home-plugins/web/serper/provider.py'
p = Path(os.environ['VIBEOSINT_SERPER_PLUGIN']) if os.environ.get('VIBEOSINT_SERPER_PLUGIN') else (
    staged_plugin if staged_plugin.exists() else
    project.parent / 'vibeosint-hermes-home/plugins/web/serper/provider.py')
spec=importlib.util.spec_from_file_location('serper_provider_under_test',p)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
provider=module.SerperWebSearchProvider()
assert provider.is_available() and provider.supports_search() and not provider.supports_extract()
calls=[]
class FakeResponse:
    def raise_for_status(self): pass
    def json(self): return {'organic': [
        {'title':'Valid','link':'https://example.com/a','snippet':'Snippet'},
        {'title':'No URL','snippet':'Invalid'},
    ]}
def fake_post(url,**kwargs):
    calls.append((url,kwargs))
    return FakeResponse()
original_post=module.httpx.post
module.httpx.post=fake_post
try:
    results=provider.search('site:example.com intitle:test',5)
finally:
    module.httpx.post=original_post
assert results['success'] is True and len(results['data']['web'])==1
assert results['data']['web'][0]['url']=='https://example.com/a'
assert calls[0][0]=='https://google.serper.dev/search'
assert calls[0][1]['json']['q']=='site:example.com intitle:test'
assert results['data']['web'][0]['position']==1
assert key not in json.dumps(results)
print('PASS: Hermes Serper provider format, API protocol, operator forwarding, safe result shaping')
