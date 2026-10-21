"""Offline regression: VibeOSINT must never select the shared host TG pool."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'workspace'))
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[1] / 'workspace'


class TelegramAccountIsolationTest(unittest.TestCase):
    def test_project_scripts_use_only_their_own_pool(self):
        for name in ('tg_entity_query', 'osint_bot_query', 'lazyapi_bot_query'):
            spec = importlib.util.spec_from_file_location(name, WORKSPACE / f'{name}.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            for script, expected in (
                (f'/opt/vibeosint/workspace/{name}.py', '/opt/vibeosint/tg_accounts'),
                (f'/workspace/{name}.py', '/root/tg_accounts'),
                (f'/missing-project/workspace/{name}.py', '/missing-project/tg_accounts'),
            ):
                with self.subTest(module=name, script=script):
                    with patch.object(module, '__file__', script):
                        self.assertEqual(module.get_base_dir(), expected)


if __name__ == '__main__':
    unittest.main()
