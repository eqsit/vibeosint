"""Exercise review fixtures' actual temporary-directory calls without imports."""
import ast
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class FixtureTemporaryDirectoryTests(unittest.TestCase):
    def test_review_fixture_directories_honor_writable_tmpdir(self):
        tests = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='fixture-tmpdir-') as directory:
            with patch.dict(os.environ, {'TMPDIR': directory}), patch.object(tempfile, 'tempdir', None):
                for filename in ('test_mcp_reliability.py', 'test_review_phone_failover.py'):
                    with self.subTest(filename=filename):
                        tree = ast.parse((tests / filename).read_text())
                        scope = {'Path': Path, 'tempfile': tempfile}
                        for node in tree.body:
                            if isinstance(node, ast.Assign) and any(
                                isinstance(target, ast.Name) and target.id == 'SCRATCH'
                                for target in node.targets
                            ):
                                exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), scope)
                        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                                 and isinstance(node.func, ast.Attribute)
                                 and isinstance(node.func.value, ast.Name)
                                 and node.func.value.id == 'tempfile'
                                 and node.func.attr == 'TemporaryDirectory']
                        self.assertTrue(calls, 'probe must exercise real fixture directory creation')
                        for call in calls:
                            with eval(compile(ast.Expression(call), filename, 'eval'), scope) as created:
                                self.assertEqual(Path(created).parent.resolve(), Path(directory).resolve())
                                probe = Path(created) / 'writable-fixture'
                                probe.write_text('synthetic')
                                self.assertEqual(probe.read_text(), 'synthetic')
                            self.assertFalse(Path(created).exists())


if __name__ == '__main__':
    unittest.main()
