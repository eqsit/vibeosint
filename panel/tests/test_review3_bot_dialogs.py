"""Offline regressions for incomplete bot replies; no real sessions or network."""
import asyncio
from contextlib import contextmanager
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKSPACE = Path(__file__).resolve().parents[1] / 'workspace'
sys.path.insert(0, str(WORKSPACE))
import lazyapi_bot_query as lazy
import osint_bot_query as osint


def message(identifier, text):
    return SimpleNamespace(id=identifier, text=text, out=False, buttons=None)


class BotDialogRegressionTests(unittest.TestCase):
    def setUp(self):
        def denied(*args, **kwargs):
            raise AssertionError('Network forbidden in bot dialog regressions')
        self.enterContext(patch.object(socket.socket, 'connect', denied))
        self.enterContext(patch.object(socket, 'getaddrinfo', denied))

    @contextmanager
    def dialog(self, module, responses):
        clock = SimpleNamespace(now=1000.0)
        stream = SimpleNamespace(opened=[], sent=[], polls=0, delayed=False)
        acknowledgement = message(1, responses[0])
        terminal = message(2, 'Основная информация: id: FIXTURE_A')

        async def sleep(seconds):
            clock.now += seconds

        class Client:
            def __init__(self, session, *_):
                stream.opened.append(Path(session).name)
            async def connect(self): pass
            async def disconnect(self): pass
            async def is_user_authorized(self): return True
            async def get_entity(self, bot): return bot
            async def send_message(self, bot, query): stream.sent.append(query)
            async def get_messages(self, bot, limit):
                if limit == 1:
                    return [acknowledgement] if stream.sent else []
                stream.polls += 1
                if stream.delayed:
                    # A's terminal arrives only after A's timeout, during B.
                    return [terminal]
                index = min(stream.polls - 1, len(responses) - 1)
                return [message(index + 1, responses[index])]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stream.root = root
            with patch.multiple(module, BASE_DIR=directory, RUNTIME_DIR=root / 'locks',
                                TelegramClient=Client,
                                time=SimpleNamespace(time=lambda: clock.now),
                                asyncio=SimpleNamespace(sleep=sleep)):
                yield stream

    def query(self, module, text, timeout=4):
        if module is lazy:
            return asyncio.run(module.query_lazyapi_client({'user_id': 101}, text,
                                                           timeout=timeout, lock_timeout=0))
        return asyncio.run(module.query_with_client({'user_id': 101}, text,
                                                     timeout=timeout, lock_timeout=0))

    def test_processing_ack_keywords_are_not_terminal_markers(self):
        acknowledgements = [
            'Проверяю телефон и паспорт, лимит запросов пока проверяется.',
            'Запрос принят: основная информация собирается, полный отчёт формируется.',
            'Ищу информацию об IP, данные ещё обрабатываются.',
            'Запрос принят. ID: FIXTURE_A; поиск продолжается.',
            'Проверка: данные не найдены в кеше; продолжаю поиск.',
            'Основная информация: собирается, ожидайте.',
        ]
        for module in (lazy, osint):
            for acknowledgement in acknowledgements:
                with self.subTest(bot=module.__name__, ack=acknowledgement), self.dialog(module, [acknowledgement]) as stream:
                    result = self.query(module, 'FIXTURE_A')
                    self.assertIn(result['status'], ('no_response', 'timeout', 'incomplete'))
                    self.assertTrue((stream.root / 'locks/account-101.cooldown').exists())

    def test_success_waits_for_recognized_terminal_and_clears_quarantine(self):
        for module in (lazy, osint):
            for terminal in ('Основная информация: id: FIXTURE_A',
                             'Данные не найдены.',
                             'Полный отчёт: https://example.invalid/fixture-report'):
                with self.subTest(bot=module.__name__, terminal=terminal), self.dialog(module, ['Запрос принят, обработка...', terminal]) as stream:
                    result = self.query(module, 'FIXTURE_A', timeout=6)
                    self.assertEqual(result['status'], 'success')
                    self.assertEqual(stream.polls, 2, 'Acknowledgement ended polling before terminal')
                    self.assertIn(terminal, result['raw_text'])
                    self.assertFalse((stream.root / 'locks/account-101.cooldown').exists())

    def test_ack_timeout_quarantines_a_and_blocks_b_delayed_a_terminal(self):
        for module in (lazy, osint):
            with self.subTest(bot=module.__name__), self.dialog(module, ['Запрос принят, обработка...']) as stream:
                result_a = self.query(module, 'FIXTURE_A')
                quarantined = (stream.root / 'locks/account-101.cooldown').exists()
                stream.delayed = True
                result_b = self.query(module, 'FIXTURE_B')
                self.assertEqual(result_b['status'], 'busy',
                                 f'B consumed delayed A terminal: {result_b}')
                self.assertIn(result_a['status'], ('no_response', 'timeout', 'incomplete'))
                self.assertTrue(quarantined, 'Acknowledgement must not clear quarantine')
                self.assertEqual(stream.opened, ['101'], 'B must not open SQLite for quarantined UID')
                self.assertEqual(stream.sent, ['FIXTURE_A'])


if __name__ == '__main__':
    unittest.main()
