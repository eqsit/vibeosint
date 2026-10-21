"""Daily Telegram quota expiry must not disable an allocated account forever."""
import asyncio
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'workspace'))
import tg_entity_query as entity
import lazyapi_bot_query as lazy
import osint_bot_query as osint
spec = importlib.util.spec_from_file_location('quota_runtime', ROOT / 'workspace/tg_pool_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class QuotaRecoveryTests(unittest.TestCase):
    def setUp(self):
        def denied(*args, **kwargs):
            raise AssertionError('Network forbidden in quota regressions')
        self.enterContext(patch.object(socket.socket, 'connect', denied))
        self.enterContext(patch.object(socket, 'getaddrinfo', denied))

    def test_quota_timestamp_takes_precedence_over_lru_in_both_directions(self):
        now = time.time()
        for observed_at, last_used, expected in ((now - 90000, now, 'success'),
                                                  (now, now - 90000, 'limit_reached')):
            with self.subTest(observed_at=observed_at), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                (base / '123.session').touch()
                state = base / 'state.json'
                state.write_text(json.dumps([{'user_id': 123, 'searches_left': 0,
                                              'quota_observed_at': observed_at, 'last_used': last_used}]))
                seen = []
                async def operation(account):
                    seen.append(account.get('searches_left'))
                    return {'status': 'success'}
                result = asyncio.run(runtime.run_pool(state, base, operation,
                                                      runtime_dir=base / 'locks', busy_timeout=0))
                self.assertEqual(result['status'], expected)
                self.assertEqual(seen, [None] if expected == 'success' else [])

    def test_missing_legacy_quota_timestamp_is_not_created_by_entity_lru(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / '123.session').touch()
            state = base / 'state.json'
            state.write_text(json.dumps([{'user_id': 123, 'searches_left': 0}]))
            async def operation(account): return {'status': 'success'}
            asyncio.run(runtime.run_pool(state, base, operation, respect_quota=False,
                                         runtime_dir=base / 'locks', busy_timeout=0))
            saved = json.loads(state.read_text())[0]
            self.assertIsNone(saved['quota_observed_at'])
            self.assertEqual(saved['searches_left'], 0)
            saved['last_used'] = time.time() - 90000
            state.write_text(json.dumps([saved]))
            async def forbidden(account): self.fail('LRU use fabricated a quota observation')
            result = asyncio.run(runtime.run_pool(state, base, forbidden,
                                                  runtime_dir=base / 'locks', busy_timeout=0))
            self.assertEqual(result['status'], 'limit_reached')

    def test_reobserved_bot_limit_starts_its_own_retry_window(self):
        for module, filename, search in ((lazy, 'lazyapi_state.json', lazy.execute_lazyapi_search),
                                         (osint, 'accounts_state.json', osint.execute_search)):
            with self.subTest(bot=module.__name__), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                (base / '123.session').touch()
                observed_at = time.time() - 90000
                state = base / filename
                state.write_text(json.dumps([{'user_id': 123, 'searches_left': 0,
                                              'quota_observed_at': observed_at, 'last_used': time.time()}]))
                opened, sent = [], []
                class Client:
                    def __init__(self, *_): opened.append(True)
                    async def connect(self): pass
                    async def disconnect(self): pass
                    async def is_user_authorized(self): return True
                    async def get_entity(self, bot): return bot
                    async def send_message(self, bot, query): sent.append(bot)
                    async def get_messages(self, bot, limit):
                        if limit == 1: return []
                        return [SimpleNamespace(id=len(sent), text='Лимит исчерпан', out=False, buttons=None)]
                async def sleep(seconds): pass
                started = time.time()
                with patch.multiple(module, BASE_DIR=directory, STATE_FILE=str(state),
                                    RUNTIME_DIR=base / 'locks', TelegramClient=Client,
                                    asyncio=SimpleNamespace(run=asyncio.run, sleep=sleep)):
                    self.assertEqual(search('FIXTURE', lock_timeout=0)['status'], 'limit_reached')
                    saved = json.loads(state.read_text())[0]
                    self.assertGreaterEqual(saved['quota_observed_at'], started)
                    self.assertEqual(saved['searches_left'], 0)
                    self.assertEqual(search('FIXTURE', lock_timeout=0)['status'], 'limit_reached')
                    self.assertEqual(len(opened), 1, 'New limit observation was retried immediately')

    def test_expired_legacy_zero_survives_repeated_entity_success_before_bot_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / '123.session').touch()
            observed_at = time.time() - 90000
            state = base / 'accounts_state.json'
            state.write_text(json.dumps([{'user_id': 123, 'authorized': True,
                                          'searches_left': 0, 'last_used': observed_at}]))
            class Client:
                def __init__(self, *_): pass
                async def connect(self): pass
                async def disconnect(self): pass
                async def is_user_authorized(self): return True
                async def get_entity(self, query):
                    return SimpleNamespace(id=42, broadcast=True, title='FIXTURE')
            seen = []
            async def bot_operation(account):
                seen.append(dict(account))
                return {'status': 'success', 'account_id': account['user_id']}
            with patch.multiple(entity, BASE_DIR=directory, RUNTIME_DIR=base / 'locks', TelegramClient=Client):
                for _ in range(3):
                    result = asyncio.run(entity.execute_tg_query('@fixture', lock_timeout=0))
                    self.assertEqual(result['status'], 'success')
            after_entity = json.loads(state.read_text())[0]
            result = asyncio.run(runtime.run_pool(state, base, bot_operation,
                                                  runtime_dir=base / 'locks', busy_timeout=0))
            self.assertEqual(result['status'], 'success', 'Entity LRU use postponed expired bot quota')
            self.assertEqual(len(seen), 1)
            self.assertGreater(after_entity['last_used'], observed_at)
            self.assertEqual(after_entity['searches_left'], 0)
            self.assertEqual(after_entity['quota_observed_at'], observed_at)
            self.assertIsNone(seen[0]['searches_left'])
            self.assertIsNone(json.loads(state.read_text())[0]['searches_left'])

    def test_expired_zero_quota_is_retried_without_fabricating_balance(self):
        scratch = ROOT / '.test-tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            base = Path(directory)
            (base / '123.session').touch()  # No Telegram client is opened.
            state = base / 'state.json'
            state.write_text(json.dumps([{'user_id': 123, 'authorized': True,
                                          'searches_left': 0, 'last_used': time.time() - 90000}]))
            seen = []
            async def operation(account):
                seen.append(dict(account))
                return {'status': 'success', 'account_id': account['user_id']}
            result = asyncio.run(runtime.run_pool(state, base, operation,
                                                  runtime_dir=base / 'locks', busy_timeout=0))
            self.assertEqual(result['status'], 'success')
            self.assertEqual(len(seen), 1)
            self.assertIsNone(seen[0]['searches_left'])
            self.assertIsNone(json.loads(state.read_text())[0]['searches_left'])

    def test_recent_zero_quota_stays_exhausted(self):
        scratch = ROOT / '.test-tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            base = Path(directory)
            (base / '123.session').touch()
            state = base / 'state.json'
            state.write_text(json.dumps([{'user_id': 123, 'authorized': True,
                                          'searches_left': 0, 'last_used': time.time()}]))
            async def forbidden(account):
                self.fail('Recently exhausted account must not be queried')
            result = asyncio.run(runtime.run_pool(state, base, forbidden,
                                                  runtime_dir=base / 'locks', busy_timeout=0))
            self.assertEqual(result['status'], 'limit_reached')


if __name__ == '__main__':
    unittest.main()
