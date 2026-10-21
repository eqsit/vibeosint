"""Offline regressions through the public phone API and real pool runtime."""
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

from telethon.errors import FloodWaitError, PhoneNumberInvalidError, RPCError, ServerError, UsernameNotOccupiedError
from telethon.tl.functions.contacts import DeleteContactsRequest, ImportContactsRequest
from telethon.tl.functions.users import GetFullUserRequest

WORKSPACE = Path(__file__).resolve().parents[1] / 'workspace'
sys.path.insert(0, str(WORKSPACE))
import tg_entity_query as entity

# Explicit synthetic data, not a repaired/redacted token from review evidence.
SYNTHETIC_PHONE = '+12025550123'
SYNTHETIC_PHONE_DIGITS = '12025550123'


class PhoneFailoverRegressionTests(unittest.TestCase):
    def setUp(self):
        def denied(*args, **kwargs):
            raise AssertionError('Network forbidden in phone failover regressions')
        for target, name in ((socket.socket, 'connect'), (socket.socket, 'connect_ex'),
                             (socket, 'create_connection'), (socket, 'getaddrinfo')):
            self.enterContext(patch.object(target, name, denied))

    @contextmanager
    def pool(self, failures=None, *, empty_accounts=(), entity_failures=None):
        failures = failures or {}
        entity_failures = entity_failures or {}
        with tempfile.TemporaryDirectory(prefix='review-phone-') as directory:
            base = Path(directory)
            (base / 'accounts_state.json').write_text(json.dumps([
                {'user_id': 101, 'authorized': True},
                {'user_id': 102, 'authorized': True},
            ]))
            for uid in (101, 102):
                (base / f'{uid}.session').touch()
            seen = SimpleNamespace(opened=[], imported=[], deleted=[], entities=[], disconnected=[])

            class Client:
                def __init__(self, session, *_):
                    self.uid = int(Path(session).name)
                    seen.opened.append(self.uid)

                async def connect(self):
                    pass

                async def disconnect(self):
                    seen.disconnected.append(self.uid)

                async def is_user_authorized(self):
                    return True

                async def get_entity(self, query):
                    seen.entities.append((self.uid, query))
                    raise entity_failures.get(self.uid, ValueError('FIXTURE: entity not cached'))

                async def __call__(self, request):
                    if isinstance(request, ImportContactsRequest):
                        seen.imported.append((self.uid, request.contacts[0].phone))
                        if self.uid in failures:
                            raise failures[self.uid]
                        users = [] if self.uid in empty_accounts else [SimpleNamespace(
                            id=42, phone=SYNTHETIC_PHONE_DIGITS, first_name='FIXTURE',
                            last_name=None, username=None, bot=False,
                        )]
                        return SimpleNamespace(users=users)
                    if isinstance(request, DeleteContactsRequest):
                        seen.deleted.append((self.uid, request.id))
                        return None
                    if isinstance(request, GetFullUserRequest):
                        return SimpleNamespace(full_user=SimpleNamespace(about='FIXTURE'))
                    raise AssertionError(f'Unexpected fixture request: {type(request).__name__}')

            with patch.multiple(entity, BASE_DIR=directory, RUNTIME_DIR=base / 'locks', TelegramClient=Client), \
                 patch.dict(os.environ, {'OSINT_SESSION_ID': ''}):
                yield seen

    def assert_healthy_second_account(self, result, seen):
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['account_id'], 102, f'Phone error stopped public pool failover: {result}')
        self.assertEqual(result['query_type'], 'phone')
        self.assertEqual(result['result'], {
            'found': True, 'user_id': 42, 'phone': SYNTHETIC_PHONE_DIGITS,
            'first_name': 'FIXTURE', 'last_name': None, 'username': None,
            'is_bot': False, 'is_scam': False, 'is_fake': False, 'is_premium': False,
            'bio': 'FIXTURE', 'tg_link': 'tg://user?id=42',
        })
        self.assertEqual(seen.opened, [101, 102])
        self.assertEqual(seen.imported, [(101, SYNTHETIC_PHONE_DIGITS), (102, SYNTHETIC_PHONE_DIGITS)])
        self.assertEqual(seen.deleted, [(102, [42])])
        self.assertEqual(seen.disconnected, [101, 102])

    def test_auto_phone_timeout_retries_second_account(self):
        with self.pool({101: TimeoutError('FIXTURE: phone transport timeout')}) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'auto', lock_timeout=0))
            self.assert_healthy_second_account(result, seen)
            self.assertEqual(seen.entities, [])

    def test_explicit_phone_timeout_retries_second_account(self):
        with self.pool({101: TimeoutError('FIXTURE: phone transport timeout')}) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'phone', lock_timeout=0))
            self.assert_healthy_second_account(result, seen)
            self.assertEqual(seen.entities, [])

    def test_numeric_auto_phone_timeout_overrides_entity_not_found(self):
        absent = {uid: UsernameNotOccupiedError(None) for uid in (101, 102)}
        with self.pool({101: TimeoutError('FIXTURE: phone timeout')}, entity_failures=absent) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE_DIGITS, 'auto', lock_timeout=0))
            self.assert_healthy_second_account(result, seen)
            self.assertEqual(seen.entities, [(101, int(SYNTHETIC_PHONE_DIGITS)), (102, int(SYNTHETIC_PHONE_DIGITS))])

    def test_numeric_entity_phone_timeout_overrides_entity_not_found(self):
        absent = {uid: UsernameNotOccupiedError(None) for uid in (101, 102)}
        with self.pool({101: TimeoutError('FIXTURE: phone timeout')}, entity_failures=absent) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE_DIGITS, 'entity', lock_timeout=0))
            self.assert_healthy_second_account(result, seen)
            self.assertEqual(seen.entities, [(101, int(SYNTHETIC_PHONE_DIGITS)), (102, int(SYNTHETIC_PHONE_DIGITS))])

    def test_numeric_fallback_all_phone_failures_are_unavailable(self):
        for mode in ('auto', 'entity'):
            for entity_error in (UsernameNotOccupiedError(None), ValueError('FIXTURE: entity cache miss')):
                with self.subTest(mode=mode, entity_error=type(entity_error).__name__), self.pool(
                    {101: TimeoutError('FIXTURE: first phone timeout'),
                     102: ConnectionError('FIXTURE: second phone disconnected')},
                    entity_failures={101: entity_error, 102: entity_error},
                ) as seen:
                    result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE_DIGITS, mode, lock_timeout=0))
                    self.assertEqual(result['status'], 'unavailable', result)
                    self.assertEqual(seen.opened, [101, 102])
                    self.assertEqual(seen.imported, [(101, SYNTHETIC_PHONE_DIGITS), (102, SYNTHETIC_PHONE_DIGITS)])
                    self.assertEqual(seen.disconnected, [101, 102])
                    self.assertEqual(result['attempts'], [
                        {'account_id': 101, 'status': 'unavailable', 'error': 'FIXTURE: first phone timeout'},
                        {'account_id': 102, 'status': 'unavailable', 'error': 'FIXTURE: second phone disconnected'},
                    ])

    def test_numeric_fallback_empty_is_success_without_claiming_absence(self):
        for mode in ('auto', 'entity'):
            with self.subTest(mode=mode), self.pool(
                empty_accounts=(101,), entity_failures={101: UsernameNotOccupiedError(None)},
            ) as seen:
                result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE_DIGITS, mode, lock_timeout=0))
                self.assertEqual(result['status'], 'success', result)
                self.assertEqual(result['query_type'], 'phone')
                self.assertEqual(result['result'], {
                    'found': False, 'phone': SYNTHETIC_PHONE_DIGITS,
                    'message': 'No registered Telegram user for this phone or privacy settings restrict lookup.',
                })
                self.assertEqual(seen.opened, [101])
                self.assertEqual(seen.disconnected, [101])
                self.assertEqual(seen.deleted, [])

    def assert_all_unavailable(self, result, seen, errors):
        self.assertEqual(result['status'], 'unavailable', result)
        self.assertEqual(result['account_id'], 102)
        self.assertEqual(result['error'], str(errors[102]))
        self.assertEqual(result['attempts'], [
            {'account_id': uid, 'status': 'unavailable', 'error': str(errors[uid])}
            for uid in (101, 102)
        ])
        self.assertEqual(seen.opened, [101, 102])
        self.assertEqual(seen.imported, [(101, SYNTHETIC_PHONE_DIGITS), (102, SYNTHETIC_PHONE_DIGITS)])
        self.assertEqual(seen.disconnected, [101, 102])
        self.assertEqual(seen.deleted, [])

    def assert_empty_first_account(self, result, seen):
        self.assertEqual(result, {
            'status': 'success', 'query_type': 'phone', 'account_id': 101,
            'result': {
                'found': False, 'phone': SYNTHETIC_PHONE_DIGITS,
                'message': 'No registered Telegram user for this phone or privacy settings restrict lookup.',
            },
        })
        self.assertEqual(seen.opened, [101])
        self.assertEqual(seen.imported, [(101, SYNTHETIC_PHONE_DIGITS)])
        self.assertEqual(seen.disconnected, [101])
        self.assertEqual(seen.deleted, [])

    def test_auto_phone_all_transport_failures_are_unavailable(self):
        errors = {101: TimeoutError('FIXTURE: first phone timeout'),
                  102: ConnectionError('FIXTURE: second phone disconnected')}
        with self.pool(errors) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'auto', lock_timeout=0))
            self.assert_all_unavailable(result, seen, errors)
            self.assertEqual(seen.entities, [])

    def test_explicit_phone_all_transport_failures_are_unavailable(self):
        errors = {101: TimeoutError('FIXTURE: first phone timeout'),
                  102: OSError('FIXTURE: second transport unavailable')}
        with self.pool(errors) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'phone', lock_timeout=0))
            self.assert_all_unavailable(result, seen, errors)
            self.assertEqual(seen.entities, [])

    def test_phone_unknown_rpc_failures_allow_failover(self):
        for error in (ServerError(None, 'FIXTURE_SERVER_FAILURE', code=500),
                      RPCError(None, 'FIXTURE_UNKNOWN_RPC_FAILURE', code=400),
                      FloodWaitError(None, capture=30)):
            for mode, query in (('auto', SYNTHETIC_PHONE), ('phone', SYNTHETIC_PHONE),
                                ('auto', SYNTHETIC_PHONE_DIGITS), ('entity', SYNTHETIC_PHONE_DIGITS)):
                with self.subTest(error=type(error).__name__, mode=mode, query=query), self.pool({101: error}) as seen:
                    result = asyncio.run(entity.execute_tg_query(query, mode, lock_timeout=0))
                    self.assert_healthy_second_account(result, seen)

    def test_phone_nontransport_failure_is_not_a_success_or_absence(self):
        errors = {uid: PhoneNumberInvalidError(None) for uid in (101, 102)}
        for mode, query in (('auto', SYNTHETIC_PHONE), ('phone', SYNTHETIC_PHONE),
                            ('auto', SYNTHETIC_PHONE_DIGITS), ('entity', SYNTHETIC_PHONE_DIGITS)):
            with self.subTest(mode=mode, query=query), self.pool(errors) as seen:
                result = asyncio.run(entity.execute_tg_query(query, mode, lock_timeout=0))
                self.assert_all_unavailable(result, seen, errors)

    def test_auto_phone_empty_preserves_existing_envelope(self):
        with self.pool(empty_accounts=(101,)) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'auto', lock_timeout=0))
            self.assert_empty_first_account(result, seen)
            self.assertEqual(seen.entities, [])

    def test_explicit_phone_empty_preserves_existing_envelope(self):
        with self.pool(empty_accounts=(101,)) as seen:
            result = asyncio.run(entity.execute_tg_query(SYNTHETIC_PHONE, 'phone', lock_timeout=0))
            self.assert_empty_first_account(result, seen)
            self.assertEqual(seen.entities, [])

    def test_phone_timeout_then_real_empty_keeps_privacy_qualified_result(self):
        for mode, query in (('auto', SYNTHETIC_PHONE), ('phone', SYNTHETIC_PHONE),
                            ('auto', SYNTHETIC_PHONE_DIGITS), ('entity', SYNTHETIC_PHONE_DIGITS)):
            with self.subTest(mode=mode, query=query), self.pool(
                {101: TimeoutError('FIXTURE: phone timeout')}, empty_accounts=(102,),
            ) as seen:
                result = asyncio.run(entity.execute_tg_query(query, mode, lock_timeout=0))
                self.assertEqual(result['status'], 'success')
                self.assertEqual(result['account_id'], 102)
                self.assertEqual(result['query_type'], 'phone')
                self.assertFalse(result['result']['found'])
                self.assertNotIn('error', result['result'])
                self.assertIn('privacy settings restrict lookup', result['result']['message'])
                self.assertEqual(seen.opened, [101, 102])
                self.assertEqual(seen.imported, [(101, SYNTHETIC_PHONE_DIGITS), (102, SYNTHETIC_PHONE_DIGITS)])
                self.assertEqual(seen.disconnected, [101, 102])
                self.assertEqual(seen.deleted, [])

    def test_phone_timeout_without_message_retries_second_account(self):
        for mode, query in (('auto', SYNTHETIC_PHONE), ('phone', SYNTHETIC_PHONE),
                            ('auto', SYNTHETIC_PHONE_DIGITS), ('entity', SYNTHETIC_PHONE_DIGITS)):
            with self.subTest(mode=mode, query=query), self.pool({101: TimeoutError()}) as seen:
                result = asyncio.run(entity.execute_tg_query(query, mode, lock_timeout=0))
                self.assert_healthy_second_account(result, seen)

    def test_all_phone_timeouts_without_message_are_unavailable(self):
        errors = {uid: TimeoutError() for uid in (101, 102)}
        for mode, query in (('auto', SYNTHETIC_PHONE), ('phone', SYNTHETIC_PHONE),
                            ('auto', SYNTHETIC_PHONE_DIGITS), ('entity', SYNTHETIC_PHONE_DIGITS)):
            with self.subTest(mode=mode, query=query), self.pool(errors) as seen:
                result = asyncio.run(entity.execute_tg_query(query, mode, lock_timeout=0))
                self.assert_all_unavailable(result, seen, errors)

    def test_username_definitive_absence_does_not_trigger_phone_fallback(self):
        for mode in ('auto', 'entity'):
            with self.subTest(mode=mode), self.pool(
                entity_failures={101: UsernameNotOccupiedError(None)},
            ) as seen:
                result = asyncio.run(entity.execute_tg_query('@fixture_missing', mode, lock_timeout=0))
                self.assertEqual(result['status'], 'not_found')
                self.assertEqual(result['account_id'], 101)
                self.assertEqual(result['query'], '@fixture_missing')
                self.assertEqual(seen.opened, [101])
                self.assertEqual(seen.entities, [(101, 'fixture_missing')])
                self.assertEqual(seen.imported, [])
                self.assertEqual(seen.disconnected, [101])


if __name__ == '__main__':
    unittest.main()
