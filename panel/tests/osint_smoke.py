"""Offline smoke test. Stubs optional runtime dependencies; does not access credentials or APIs."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for name in ('phonenumbers', 'whois'):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
for name in ('carrier','geocoder','timezone'):
    setattr(sys.modules['phonenumbers'],name,types.ModuleType(name))
modmcp = types.ModuleType('mcp')
modsrv = types.ModuleType('mcp.server')
modfast = types.ModuleType('mcp.server.fastmcp')
class FastMCP:
    def __init__(self, name): self.name=name
    def tool(self): return lambda function: function
modfast.FastMCP = FastMCP
sys.modules.update({'mcp':modmcp,'mcp.server':modsrv,'mcp.server.fastmcp':modfast})

def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

e=load('osint_engine',ROOT/'workspace/osint_engine.py')
class FakeResponse:
    def __init__(self,data):self.data=json.dumps(data).encode()
    def __enter__(self):return self
    def __exit__(self,*_):pass
    def read(self,*_):return self.data

original_open=e.urllib.request.urlopen
e._serper_key=lambda:'TEST-NOT-A-REAL-KEY'
queries=[]
def fake_open(req,timeout=0):
    queries.append(req)
    return FakeResponse({'organic':[{'title':'Result','link':'https://example.org/fact','snippet':'Snippet'}]})
e.urllib.request.urlopen=fake_open
res=e.search_web('site:example.org "fact"',1)
assert res['primary_engine']=='serper-google' and res['count']==1
assert res['results'][0]['verification']=='search-result-only'
assert len(queries)==1 and queries[0].full_url=='https://google.serper.dev/search'
assert 'TEST-NOT-A-REAL-KEY' not in json.dumps(res)

e.urllib.request.urlopen=original_open
with tempfile.TemporaryDirectory() as tmp:
    os.environ['OSINT_DATA_DIR']=tmp
    m=load('mcp_osint',ROOT/'server/mcp_osint.py')
    sid='ses_abcdef1234'
    (Path(tmp)/f'{sid}.json').write_text(json.dumps({'id':sid,'sessionId':sid,'title':'Test','messages':[],'logs':[],'report':''}))
    failures=[]
    def write(i):
        try:
            result=m.osint_report_add(session_id=sid,section='Sources',columns=['Item','Link'],
                  facts=[[f'item{i}',f'https://example.org/{i}']])
            assert result.startswith('Добавлено строк: 1.'), result
        except BaseException as err:failures.append(str(err))
    threads=[threading.Thread(target=write,args=(i,)) for i in range(12)]
    for th in threads:th.start()
    for th in threads:th.join()
    assert not failures,failures
    session=json.loads((Path(tmp)/f'{sid}.json').read_text())
    assert len(session['reportState']['sections'][0]['rows'])==12
    assert len(session['reportState']['sections'][0]['rowEvidence'])==12
    result=m.osint_report_add(session_id=sid,section='Sources',facts=[['unsourced','value']])
    assert 'Ничего не добавлено' in result
    try:m._session_path('../../etc/passwd');raise AssertionError('unsafe id accepted')
    except ValueError:pass
    try:m._fetch_image_bytes('/etc/hosts');raise AssertionError('unsafe path accepted')
    except ValueError:pass
print('PASS: Serper-first, provenance enforcement, 12 concurrent report writes, path confinement')
