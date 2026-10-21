"""Public export must obtain operator credentials from the environment only."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]

def assignment(module,name):
    tree=ast.parse((ROOT/'workspace'/module).read_text())
    node=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
    scope={'os':os,'BASE_DIR':'/fixture'}
    exec(compile(ast.Module(body=[node],type_ignores=[]),'<configuration-assignment>','exec'),scope)
    return scope[name]

class PublicConfiguration(unittest.TestCase):
    def test_telegram_credentials_are_explicit_environment_values(self):
        with patch.dict(os.environ,{'TELEGRAM_API_ID':'1234567','TELEGRAM_API_HASH':'fixture-hash'},clear=True):
            for module in ('tg_entity_query.py','lazyapi_bot_query.py','osint_bot_query.py'):
                with self.subTest(module=module):
                    self.assertTrue(assignment(module,'API_ID')==1234567,'API ID must use operator environment')
                    self.assertTrue(assignment(module,'API_HASH')=='fixture-hash','API hash must use operator environment')

    def test_telegram_credentials_have_no_embedded_defaults(self):
        with patch.dict(os.environ,{},clear=True):
            for module in ('tg_entity_query.py','lazyapi_bot_query.py','osint_bot_query.py'):
                with self.subTest(module=module):
                    self.assertTrue(assignment(module,'API_ID')==0,'Unconfigured API ID must be empty')
                    self.assertTrue(assignment(module,'API_HASH')=='','Unconfigured API hash must be empty')

    def test_private_bot_routes_are_not_published_as_defaults(self):
        with patch.dict(os.environ,{},clear=True):
            for module,name in [('lazyapi_bot_query.py','TARGET_BOT'),('osint_bot_query.py','DEFAULT_PRIMARY_BOT'),('osint_bot_query.py','DEFAULT_FALLBACK_BOT')]:
                with self.subTest(module=module,name=name):
                    self.assertTrue(assignment(module,name)=='','Configure your own authorized bot')
            self.assertTrue(assignment('osint_bot_query.py','FLAGSHIP_UID')==0,'No real account UID in source defaults')

    def test_vision_does_not_probe_operator_private_files(self):
        tree=ast.parse((ROOT/'server/mcp_osint.py').read_text())
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_vision_api_key')
        scope={'os':os,'Path':Path}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<vision-configuration>','exec'),scope)
        with patch.dict(os.environ,{},clear=True),patch.object(Path,'read_text',side_effect=AssertionError('must not read private files')) as read:
            self.assertTrue(scope['_vision_api_key']()=='')
            self.assertEqual(read.call_count,0,'Vision may only use explicit OSINT_VISION_KEY')

if __name__=='__main__':unittest.main()
