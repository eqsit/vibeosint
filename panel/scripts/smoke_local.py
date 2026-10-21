"""Local-only package smoke: UI auth and MCP discovery, no LLM/TG/search calls."""
import asyncio,json,os,socket,subprocess,sys,tempfile,time
from pathlib import Path
import requests
from mcp import ClientSession,StdioServerParameters
from mcp.client.stdio import stdio_client
ROOT=Path(__file__).resolve().parents[1]

async def mcp_probe(temp):
    records=temp/'mcp-data'
    records.mkdir()
    (records/'ses_fixture_package.json').write_text(json.dumps({'id':'ses_fixture_package','messages':[],'report':'PACKAGE_REPORT_READBACK','reportState':{'title':'PACKAGE_REPORT_READBACK','sections':[{'name':'Smoke','type':'table','columns':['Fact','Source'],'rows':[['PACKAGE_REPORT_READBACK','https://example.org/']],'rowEvidence':[]}]}}))
    params=StdioServerParameters(command=sys.executable,args=[str(ROOT/'scripts/run_mcp.py')],env={
        'PANEL_DATA_DIR':str(records),'PANEL_WORKSPACE_DIR':str(ROOT/'workspace'),
        'HERMES_HOME':str(temp/'mcp-home'),'PYTHONDONTWRITEBYTECODE':'1'})
    async with stdio_client(params) as (reader,writer):
        async with ClientSession(reader,writer) as session:
            await session.initialize()
            tools=await session.list_tools()
            names={tool.name for tool in tools.tools}
            assert len(names)==19 and {'osint_report_add','osint_analyze_image','osint_lazyapi_query'}<=names
            report=await session.call_tool('osint_report_get',{'session_id':'ses_fixture_package'})
            assert 'PACKAGE_REPORT_READBACK' in str(report), 'MCP must read the panel-selected data directory'
            return len(names)

with tempfile.TemporaryDirectory(prefix='vibeosint-package-smoke-') as directory:
    temp=Path(directory)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    password='synthetic-local-smoke-password'
    env={k:os.environ[k] for k in ('PATH','HOME','TMPDIR','LANG') if k in os.environ}
    env.update(PANEL_PASSWORD=password,PANEL_PORT=str(port),PANEL_DATA_DIR=str(temp/'sessions'),PANEL_UPLOADS_DIR=str(temp/'uploads'),HERMES_HOME=str(temp/'profile'),HERMES_BIN=str(temp/'no-model-launcher'))
    process=subprocess.Popen(['node',str(ROOT/'server/standalone.mjs')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        c=requests.Session();c.trust_env=False;base=f'http://127.0.0.1:{port}'
        deadline=time.monotonic()+12
        while True:
            try:
                r=c.get(base+'/',timeout=1);r.raise_for_status();break
            except requests.RequestException:
                if process.poll() is not None:raise RuntimeError('Standalone panel exited before readiness')
                if time.monotonic()>deadline:raise
                time.sleep(.1)
        assert 'VibeOSINT' in r.text
        r=c.post(base+'/api/auth/login',json={'password':password},timeout=3);r.raise_for_status();assert r.json()['success']
        r=c.get(base+'/api/health',timeout=3);r.raise_for_status();assert r.json()['activeRuns']==0
        count=asyncio.run(asyncio.wait_for(mcp_probe(temp),timeout=20))
    finally:
        process.terminate()
        try:process.communicate(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.communicate(timeout=5)
print(json.dumps({'standalone_http_auth':'ok','project_paths_isolated':True,'mcp_tools_discovered':count,'model_calls':0,'telegram_queries':0}))
