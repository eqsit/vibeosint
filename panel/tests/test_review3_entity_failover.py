"""Entity failover must distinguish account/transport failures from absence."""
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from telethon.errors import FloodWaitError, ServerError, UsernameNotOccupiedError

WORKSPACE = Path(__file__).resolve().parents[1] / 'workspace'
sys.path.insert(0, str(WORKSPACE))
import tg_entity_query as entity


class EntityFailoverRegressionTests(unittest.TestCase):
    def setUp(self):
        def denied(*args, **kwargs):
            raise AssertionError('Network forbidden in entity failover regressions')
        self.enterContext(patch.object(socket.socket, 'connect', denied))
        self.enterContext(patch.object(socket, 'getaddrinfo', denied))

    @contextmanager
    def pool(self, failures):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'accounts_state.json').write_text(json.dumps([{'user_id': 101}, {'user_id': 102}]))
            for uid in (101, 102):
                (base / f'{uid}.session').touch()
            seen = SimpleNamespace(called=[], disconnected=[])
            class Client:
                def __init__(self, session, *_): self.uid = int(Path(session).name)
                async def connect(self): pass
                async def disconnect(self): seen.disconnected.append(self.uid)
                async def is_user_authorized(self): return True
                async def get_entity(self, query):
                    seen.called.append(self.uid)
                    if self.uid in failures:
                        raise failures[self.uid]
                    return SimpleNamespace(id=42, broadcast=True, title='FIXTURE_HEALTHY')
            with patch.multiple(entity, BASE_DIR=directory, RUNTIME_DIR=base / 'locks', TelegramClient=Client), \
                 patch.dict(os.environ, {'OSINT_SESSION_ID': ''}):
                yield seen

    def test_first_account_transport_timeout_tries_second_healthy_account(self):
        with self.pool({101: TimeoutError('fixture transport timeout')}) as seen:
            result = asyncio.run(entity.execute_tg_query('@fixture', 'entity', lock_timeout=0))
            self.assertEqual(result['status'], 'success', f'Account-local timeout became terminal: {result}')
            self.assertEqual(result['account_id'], 102)
            self.assertEqual(result['result']['title_or_name'], 'FIXTURE_HEALTHY')
            self.assertEqual(seen.called, [101, 102])
            self.assertEqual(seen.disconnected, [101, 102])

    def test_all_transport_errors_are_unavailable_not_authoritative_not_found(self):
        with self.pool({101: TimeoutError('fixture timeout'), 102: ConnectionError('fixture disconnected')}) as seen:
            result = asyncio.run(entity.execute_tg_query('@fixture', 'entity', lock_timeout=0))
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(seen.called, [101, 102])
            self.assertEqual(seen.disconnected, [101, 102])
            self.assertEqual([row['status'] for row in result['attempts']], ['unavailable', 'unavailable'])

    def test_account_local_cache_and_rpc_errors_allow_failover(self):
        errors = [ValueError('Could not find the input entity for fixture'),
                  ServerError(None, 'FIXTURE_SERVER_ERROR', code=500),
                  FloodWaitError(None, capture=30)]
        for error in errors:
            with self.subTest(error=type(error).__name__), self.pool({101: error}) as seen:
                result = asyncio.run(entity.execute_tg_query('@fixture', 'entity', lock_timeout=0))
                self.assertEqual(result['status'], 'success')
                self.assertEqual(result['account_id'], 102)
                self.assertEqual(seen.called, [101, 102])

    def test_definitive_username_absence_remains_terminal_not_found(self):
        with self.pool({101: UsernameNotOccupiedError(None)}) as seen:
            result = asyncio.run(entity.execute_tg_query('@fixture', 'entity', lock_timeout=0))
            self.assertEqual(result['status'], 'not_found')
            self.assertEqual(seen.called, [101], 'Definitive absence must not query another account')
            self.assertEqual(seen.disconnected, [101])


if __name__ == '__main__':
    unittest.main()
