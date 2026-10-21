"""Offline pool regressions. Synthetic sessions only; no Telegram/network I/O."""
import asyncio
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[1] / 'workspace'
sys.path.insert(0, str(WORKSPACE))
import lazyapi_bot_query as lazy
import osint_bot_query as osint
import tg_entity_query as entity


class NormalizationTests(unittest.TestCase):
    def test_bare_phones_precede_snils_without_changing_explicit_commands(self):
        for query in ('79000000000', '89000000000', '+79000000000', '8 (900) 000-00-00'):
            with self.subTest(query=query):
                self.assertEqual(lazy.normalize_query(query), '+79000000000')
        for query in ('790-000-000 00', '890-000-000 00', '12345678901'):
            self.assertEqual(lazy.normalize_query(query), '/snils ' + query.replace('-', '').replace(' ', ''))
        for query in ('/snils 79000000000', '/phone 89000000000', '/custom@bot keep  exact'):
            self.assertEqual(lazy.normalize_query(query), query)
        self.assertEqual(lazy.normalize_query('1234567890'), '/inn 1234567890')


class BotOperationTests(unittest.TestCase):
    def test_public_entrypoints_use_fair_project_pool_instead_of_flagship(self):
        self.assertNotRegex(osint.__doc__ or '', r'\d{6,}')
        import json
        import types
        runtime = importlib.import_module('tg_pool_runtime')
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(osint, 'FLAGSHIP_UID', 900001), \
             patch.dict(os.environ, {'OSINT_SESSION_ID': ''}):
            root = Path(directory)
            rows = [{'user_id':103}, {'user_id':900001, 'last_used':9e12}]
            for filename in ['accounts_state.json', 'lazyapi_state.json']:
                (root/filename).write_text(json.dumps(rows))
            for row in rows: (root/f"{row['user_id']}.session").touch()
            async def bot_operation(account, *_):
                self.assertEqual(account['user_id'], 103, 'public entrypoint still forces flagship')
                with self.assertRaises(runtime.PoolBusy):
                    async with runtime.account_lock(root/'.tg-runtime', 103, timeout=0): pass
                return {'status':'success', 'account_id':103}
            class Client:
                def __init__(self, session, *_):
                    self_uid = int(Path(session).name)
                    if self_uid != 103: raise AssertionError('entity still forces flagship')
                async def connect(self): pass
                async def disconnect(self): pass
                async def is_user_authorized(self): return True
                async def get_entity(self, query): return types.SimpleNamespace(id=42, first_name='FIXTURE', username=None)
                async def __call__(self, request): return types.SimpleNamespace(full_user=types.SimpleNamespace(about='fixture'))
            for module, state, function, helper in [(lazy,'lazyapi_state.json',lazy.execute_lazyapi_search,'_query_lazyapi_locked'),
                                                     (osint,'accounts_state.json',osint.execute_search,'_query_with_client_locked')]:
                with patch.multiple(module, BASE_DIR=directory, STATE_FILE=str(root/state), RUNTIME_DIR=root/'.tg-runtime'), \
                     patch.object(module, helper, bot_operation):
                    self.assertEqual(function('FIXTURE')['status'], 'success')
            with patch.multiple(entity, BASE_DIR=directory, RUNTIME_DIR=root/'.tg-runtime', TelegramClient=Client, create=True):
                result = asyncio.run(entity.execute_tg_query('@fixture'))
            self.assertEqual(result['status'], 'success')
            self.assertEqual(result['account_id'], 103)

    def test_timeout_quarantines_uid_and_other_account_remains_available(self):
        import json
        import types
        import tg_pool_runtime as runtime
        opened = []
        class Client:
            def __init__(self, session, *_): opened.append(int(Path(session).name))
            async def connect(self): pass
            async def disconnect(self): pass
            async def is_user_authorized(self): return True
            async def get_entity(self, bot): return bot
            async def send_message(self, bot, query): return types.SimpleNamespace(id=100)
            async def get_messages(self, bot, limit): return []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for uid in [101,102]: (root/f'{uid}.session').touch()
            state = root/'lazyapi_state.json'
            state.write_text(json.dumps([{'user_id':101}, {'user_id':102}]))
            with patch.multiple(lazy, BASE_DIR=directory, STATE_FILE=str(state), RUNTIME_DIR=root/'.tg-runtime', TelegramClient=Client):
                first = asyncio.run(lazy.query_lazyapi_client({'user_id':101}, 'FIXTURE_A', timeout=.01))
                self.assertIn(first['status'], ['timeout', 'no_response'])
                second = asyncio.run(lazy.query_lazyapi_client({'user_id':101}, 'FIXTURE_B', timeout=.01, lock_timeout=.01))
                self.assertEqual(second['status'], 'busy', 'late uncorrelated reply could leak into the next investigation')
                self.assertEqual(opened, [101], 'cooldown must be checked before SQLite opens')
                async def operation(account): return {'status':'success', 'account_id':account['user_id']}
                result = asyncio.run(runtime.run_pool(state, root, operation, runtime_dir=root/'.tg-runtime', busy_timeout=.01))
                self.assertEqual(result['account_id'], 102)

    def test_repeated_cancellation_keeps_uid_locked_until_disconnect_finishes(self):
        import fcntl
        import json
        for module in [lazy, osint, entity]:
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/'101.session').touch()
                (root/'accounts_state.json').write_text(json.dumps([{'user_id':101}]))
                async def check():
                    connecting, disconnecting, finish = asyncio.Event(), asyncio.Event(), asyncio.Event()
                    closed = []
                    class Client:
                        def __init__(self, *_): pass
                        async def connect(self):
                            connecting.set()
                            await asyncio.Event().wait()
                        async def disconnect(self):
                            disconnecting.set()
                            await finish.wait()
                            closed.append(True)
                    with patch.multiple(module, BASE_DIR=directory, RUNTIME_DIR=root/'.tg-runtime', TelegramClient=Client):
                        if module is entity: operation = module.execute_tg_query('@fixture')
                        elif module is lazy: operation = module.query_lazyapi_client({'user_id':101}, 'fixture')
                        else: operation = module.query_with_client({'user_id':101}, 'fixture')
                        task = asyncio.create_task(operation)
                        await connecting.wait()
                        task.cancel()
                        await disconnecting.wait()
                        task.cancel()
                        await asyncio.sleep(.01)
                        fd = os.open(root/'.tg-runtime/account-101.lock', os.O_RDWR)
                        try:
                            try:
                                with self.assertRaises(BlockingIOError, msg='UID was released before SQLite disconnect completed'):
                                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            finally:
                                finish.set()
                                with self.assertRaises(asyncio.CancelledError): await task
                            self.assertEqual(closed, [True])
                        finally:
                            os.close(fd)
                asyncio.run(check())

    def test_fallback_reuses_one_locked_client_without_false_account_quota(self):
        import types
        clients, sent = [], []
        class Client:
            def __init__(self, *_): clients.append(self)
            async def connect(self): pass
            async def disconnect(self): pass
            async def is_user_authorized(self): return True
            async def get_entity(self, bot): return bot
            async def send_message(self, bot, query): sent.append(bot)
            async def get_messages(self, bot, limit):
                if limit == 1: return []
                text = 'лимит исчерпан @fixture_mirrorbot' if len(sent) == 1 else 'id: FIXTURE'
                return [types.SimpleNamespace(id=len(sent), text=text, out=False, buttons=None)]
        account = {'user_id': 101}
        with tempfile.TemporaryDirectory() as directory, \
             patch.multiple(osint, BASE_DIR=directory, RUNTIME_DIR=Path(directory)/'.tg-runtime', TelegramClient=Client):
            Path(directory, '101.session').touch()
            result = asyncio.run(osint.query_with_client(account, 'FIXTURE', timeout=.5))
        self.assertEqual(result['status'], 'success')
        self.assertEqual(len(clients), 1, 'fallback must not open another SQLite client')
        self.assertEqual(sent, [osint.DEFAULT_PRIMARY_BOT, 'fixture_mirrorbot'])
        self.assertNotIn('searches_left', account, 'one mirror limit is not an account-wide known quota')

    def test_every_bot_locks_before_client_open_and_keeps_replies_isolated(self):
        import sqlite3
        import types
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sqlite3.connect(root / '101.session').close()
            runtime_dir = root / '.tg-runtime'
            sent, clients = [], []
            active = set()
            overlap = []
            class Client:
                def __init__(self, session, *_):
                    # Opening the same physical SQLite file is itself protected.
                    self.db = sqlite3.connect(session + '.session')
                    self.token = len(clients)
                    clients.append(self)
                    if active:
                        overlap.append(True)
                    active.add(self.token)
                async def connect(self):
                    await asyncio.sleep(.01)
                async def disconnect(self):
                    await asyncio.sleep(.01)
                    active.remove(self.token)
                    self.db.close()
                async def is_user_authorized(self): return True
                async def get_entity(self, bot): return bot
                async def send_message(self, bot, text):
                    sent.append((len(sent) + 1, text))
                async def get_messages(self, bot, limit):
                    if limit == 1:
                        await asyncio.sleep(.02)
                        return [types.SimpleNamespace(id=len(sent))]
                    return [types.SimpleNamespace(id=i, text='основная информация: id: ' + text,
                                                  out=False, buttons=None) for i, text in reversed(sent)]
            async def check():
                return await asyncio.gather(lazy.query_lazyapi_client({'user_id': 101}, 'FIXTURE_A'),
                                            osint.query_with_client({'user_id': 101}, 'FIXTURE_B'))
            with patch.multiple(lazy, BASE_DIR=directory, RUNTIME_DIR=runtime_dir, TelegramClient=Client, create=True), \
                 patch.multiple(osint, BASE_DIR=directory, RUNTIME_DIR=runtime_dir, TelegramClient=Client, create=True):
                results = asyncio.run(check())
            self.assertFalse(overlap, 'TelegramClient opened while the same account was in use')
            self.assertFalse(active)
            for result, own, other in zip(results, ['FIXTURE_A', 'FIXTURE_B'], ['FIXTURE_B', 'FIXTURE_A']):
                self.assertEqual(result['status'], 'success')
                self.assertIn(own, result['raw_text'])
                self.assertNotIn(other, result['raw_text'])


class RuntimeTests(unittest.TestCase):
    def runtime(self):
        self.assertTrue((WORKSPACE / 'tg_pool_runtime.py').exists(), 'shared account runtime is missing')
        return importlib.import_module('tg_pool_runtime')

    def test_pool_chooses_free_accounts_fairly_and_merges_only_used_account(self):
        import json
        runtime = self.runtime()
        self.assertTrue(hasattr(runtime, 'run_pool'), 'fair free-account selection is missing')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root/'accounts_state.json'
            rows = [{'user_id':uid, 'authorized':True, **({'searches_left':0} if uid == 101 else {})}
                    for uid in range(101, 111)]
            state.write_text(json.dumps(rows))
            for row in rows: (root/f"{row['user_id']}.session").touch()
            called = []
            async def operation(account):
                uid = account['user_id']
                with self.assertRaises(runtime.PoolBusy):
                    async with runtime.account_lock(root/'.tg-runtime', uid, timeout=0): pass
                called.append(uid)
                account['observed'] = 'fixture'
                return {'status':'success', 'account_id':uid}
            async def check():
                async with runtime.account_lock(root/'.tg-runtime', 102, timeout=0):
                    for _ in range(3):
                        result = await runtime.run_pool(state, root, operation, runtime_dir=root/'.tg-runtime', busy_timeout=.1)
                        self.assertEqual(result['status'], 'success')
            asyncio.run(check())
            self.assertEqual(called, [103,104,105])
            saved = {row['user_id']:row for row in json.loads(state.read_text())}
            self.assertEqual(saved[101], rows[0])
            self.assertEqual(saved[102], rows[1])
            for uid in called:
                self.assertEqual(saved[uid]['observed'], 'fixture')
                self.assertNotIn('searches_left', saved[uid], 'unknown quota must not be fabricated')

    def test_session_preference_is_stable_but_never_steals_busy_uid(self):
        import json
        runtime = self.runtime()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root/'accounts_state.json'
            state.write_text(json.dumps([{'user_id':uid} for uid in range(101,111)]))
            for uid in range(101,111): (root/f'{uid}.session').touch()
            async def operation(account): return {'status':'success', 'account_id':account['user_id']}
            async def check():
                async def search():
                    return await runtime.run_pool(state, root, operation, runtime_dir=root/'.tg-runtime', busy_timeout=.02)
                first = await search()
                second = await search()
                self.assertEqual(first['account_id'], second['account_id'], 'OSINT_SESSION_ID preference is not stable')
                async with runtime.account_lock(root/'.tg-runtime', first['account_id'], timeout=0):
                    other = await search()
                    self.assertNotEqual(other['account_id'], first['account_id'])
            with patch.dict(os.environ, {'OSINT_SESSION_ID':'synthetic-investigation-A'}):
                asyncio.run(check())

    def test_state_updates_merge_atomically_across_processes(self):
        import json
        import subprocess
        import time
        child_code = '''
import sys, time
sys.path.insert(0, sys.argv[1])
import osint_bot_query as bot
from pathlib import Path
bot.STATE_FILE = sys.argv[2]
while not Path(sys.argv[3]).exists(): time.sleep(.001)
for i in range(30):
    bot.save_accounts([{'user_id': int(sys.argv[4]), sys.argv[5]: i}])
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root/'accounts_state.json'
            state.write_text(json.dumps([{'user_id':101, 'identity':'A'}, {'user_id':102, 'identity':'B', 'searches_left':0}]))
            children = [subprocess.Popen([sys.executable, '-B', '-c', child_code, str(WORKSPACE), str(state), str(root/'go'), str(uid), field])
                        for uid, field in [(101, 'left_seen'), (102, 'right_seen')]]
            (root/'go').touch()
            try:
                while any(child.poll() is None for child in children):
                    try:
                        json.loads(state.read_text())
                    except json.JSONDecodeError as exc:
                        self.fail('reader observed a partial JSON state: ' + str(exc))
                    time.sleep(.001)
            finally:
                for child in children:
                    child.wait(timeout=10)
            rows = {row['user_id']:row for row in json.loads(state.read_text())}
            self.assertEqual(set(rows), {101,102})
            self.assertEqual(rows[101], {'user_id':101, 'identity':'A', 'left_seen':29})
            self.assertEqual(rows[102], {'user_id':102, 'identity':'B', 'searches_left':0, 'right_seen':29})
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)

    def test_cross_process_lock_wait_is_async_and_cancellation_releases(self):
        import subprocess
        runtime = self.runtime()
        child_code = '''
import asyncio, sys
sys.path.insert(0, sys.argv[1])
from tg_pool_runtime import account_lock
async def main():
    async with account_lock(sys.argv[2], 101, timeout=1):
        print('HELD', flush=True)
        await asyncio.sleep(60)
asyncio.run(main())
'''
        with tempfile.TemporaryDirectory() as directory:
            child = subprocess.Popen([sys.executable, '-B', '-c', child_code, str(WORKSPACE), directory], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'HELD')
                async def check():
                    ticks = []
                    async def tick():
                        for _ in range(8):
                            await asyncio.sleep(.01)
                            ticks.append(1)
                    async def waiter():
                        async with runtime.account_lock(directory, 101, timeout=.12):
                            self.fail('same UID was acquired by two processes')
                    with self.assertRaises(runtime.PoolBusy):
                        await asyncio.gather(waiter(), tick())
                    self.assertGreaterEqual(len(ticks), 5)
                    async def cancelled():
                        async with runtime.account_lock(directory, 101, timeout=30):
                            self.fail('busy UID was acquired')
                    task = asyncio.create_task(cancelled())
                    await asyncio.sleep(.02)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                asyncio.run(check())
            finally:
                child.terminate()
                child.wait(timeout=5)
                child.stdout.close()
            async def reacquire():
                with self.assertRaisesRegex(RuntimeError, 'fixture'):
                    async with runtime.account_lock(directory, 101, timeout=.1):
                        raise RuntimeError('fixture')
                async with runtime.account_lock(directory, 101, timeout=.1):
                    pass
            asyncio.run(reacquire())


if __name__ == '__main__':
    unittest.main()
