"""stdio MCP entry; explicitly reads only this checkout's ignored .env."""
import os
from pathlib import Path
import runpy
from dotenv import load_dotenv
ROOT=Path(__file__).resolve().parents[1]
load_dotenv(ROOT/'.env',override=False)
def path_setting(name,default):
    value=Path(os.environ.get(name) or default).expanduser()
    os.environ[name]=str((ROOT/value).resolve() if not value.is_absolute() else value.resolve())
path_setting('PANEL_WORKSPACE_DIR','workspace')
path_setting('PANEL_DATA_DIR','data/sessions')
path_setting('PANEL_UPLOADS_DIR','data/uploads')
path_setting('OSINT_DATA_DIR',os.environ['PANEL_DATA_DIR'])
path_setting('OSINT_UPLOADS_DIR',os.environ['PANEL_UPLOADS_DIR'])
path_setting('OSINT_ENGINE_SCRIPT','workspace/osint_engine.py')
path_setting('OSINT_FRAMEWORK_PATH','server/osint_framework.json')
path_setting('HERMES_HOME','.hermes-home')
path_setting('HERMES_RUNTIME_DIR',str(Path(os.environ['HERMES_HOME'])/'tools'))
runpy.run_path(str(ROOT/'server/mcp_osint.py'),run_name='__main__')
