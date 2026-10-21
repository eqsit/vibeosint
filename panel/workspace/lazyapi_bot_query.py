#!/usr/bin/python3
"""
LazyAPI / DepSearch Telegram Bot Query Tool (@configured_lazyapi_bot).
Operator-configured project account pool with limit tracking
and full report link extraction.
"""

import sys
import os
import re
import json
import time
import asyncio
import argparse
from telethon import TelegramClient
from tg_pool_runtime import RUNTIME_DIR, PoolBusy, account_lock, load_state, merge_state, run_pool, begin_dialog, finish_dialog, finish_cleanup, bot_terminal_status

def get_base_dir():
    workspace = os.path.dirname(os.path.abspath(__file__))
    if workspace == '/workspace':
        return '/root/tg_accounts'
    # Fail closed on the host: never fall back to its shared account pool.
    return os.path.join(os.path.dirname(workspace), 'tg_accounts')

BASE_DIR = get_base_dir()
STATE_FILE = os.path.join(BASE_DIR, 'lazyapi_state.json')
API_ID = int(os.environ.get("TELEGRAM_API_ID", "0") or "0")
API_HASH = os.environ.get("TELEGRAM_API_HASH", "").strip()
TARGET_BOT = os.environ.get("LAZYAPI_BOT_USERNAME", "").strip().lstrip("@")

def load_accounts():
    return load_state(STATE_FILE)


def save_accounts(updates):
    """Merge per-account field patches; do not pass a stale whole-pool snapshot."""
    merge_state(STATE_FILE, updates)

def normalize_query(query: str) -> str:
    q = query.strip()
    if q.startswith('/'):
        return q
    # Check INN (10 or 12 digits)
    if re.fullmatch(r'\d{10}', q) or re.fullmatch(r'\d{12}', q):
        return f'/inn {q}'
    # Explicitly formatted SNILS wins; bare 7/8-prefixed numbers are phones.
    if re.fullmatch(r'\d{3}-\d{3}-\d{3}[ -]?\d{2}', q):
        return '/snils ' + re.sub(r'[\s\-]', '', q)
    if re.fullmatch(r'[78]\d{10}', q):
        return '+7' + q[1:]
    # Other eleven-digit identifiers retain the SNILS interpretation.
    snils_digits = re.sub(r'[\s\-]', '', q)
    if len(snils_digits) == 11 and snils_digits.isdigit() and not q.startswith('+'):
        return f'/snils {snils_digits}'
    # Check address
    lower_q = q.lower()
    if any(lower_q.startswith(p) for p in ['г.', 'город ', 'ул.', 'улица ', 'обл.', 'область ']):
        return f'/addr {q}'
    # Phone numbers
    phone_clean = re.sub(r'[\s\-\(\)]', '', q)
    if re.fullmatch(r'^\+?7\d{10}$', phone_clean) or re.fullmatch(r'^8\d{10}$', phone_clean):
        if phone_clean.startswith('8'):
            phone_clean = '+7' + phone_clean[1:]
        elif not phone_clean.startswith('+'):
            phone_clean = '+' + phone_clean
        return phone_clean
    return q

def parse_lazyapi_response(text: str, button_urls: list) -> dict:
    data = {
        'names': [],
        'birth_dates': [],
        'phones': [],
        'emails': [],
        'addresses': [],
        'passports': [],
        'cards': [],
        'vehicles': [],
        'inns': [],
        'snils': [],
        'socials': [],
        'operator_region': [],
        'ip_info': {},
        'report_links': list(set(button_urls)),
        'raw_facts': []
    }

    # Extract any embedded URLs in text
    embedded = re.findall(r'https?://[^\s\n\)\"\'\>]+', text)
    for u in embedded:
        if 'renveil' not in u and u not in data['report_links']:
            data['report_links'].append(u)

    lines = [l.strip() for l in text.split('\n') if l.strip()]
    for line in lines:
        if 'тут могла быть ваша реклама' in line.lower() or 'заказать размещение' in line.lower():
            continue
        line_clean = re.sub(r'^[├└📌⚠️📣📍🏙📮🕒📶🏢🔗🛡☁️📲👤🎂🏠🪪💳🔹🆔👑🌐🔍💰🪙]\s*', '', line).strip()
        line_clean = re.sub(r'[*_`]', '', line_clean).strip()
        if not line_clean:
            continue

        lower = line_clean.lower()
        if lower.startswith('фио:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['names']:
                data['names'].append(val)
        elif lower.startswith('дата рождения:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['birth_dates']:
                data['birth_dates'].append(val)
        elif lower.startswith('номер телефона:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['phones']:
                data['phones'].append(val)
        elif lower.startswith('адрес:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['addresses']:
                data['addresses'].append(val)
        elif lower.startswith('паспорт:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['passports']:
                data['passports'].append(val)
        elif lower.startswith('карта:'):
            val = line_clean.split(':', 1)[1].strip()
            if val and val not in data['cards']:
                data['cards'].append(val)
        elif lower.startswith('оператор:') or lower.startswith('регион:') or lower.startswith('страна:'):
            data['operator_region'].append(line_clean)
        elif lower.startswith('провайдер:') or lower.startswith('организация:') or lower.startswith('hostname:'):
            k, v = line_clean.split(':', 1)
            data['ip_info'][k.strip()] = v.strip()
        elif 'инн' in lower:
            data['inns'].append(line_clean)
        elif 'снилс' in lower:
            data['snils'].append(line_clean)
        else:
            data['raw_facts'].append(line_clean)

    return data

async def query_lazyapi_client(account: dict, query: str, timeout: int = 25, *, lock_timeout=5) -> dict:
    try:
        async with account_lock(RUNTIME_DIR, account['user_id'], timeout=lock_timeout):
            return await _query_lazyapi_locked(account, query, timeout)
    except PoolBusy as exc:
        return {'status': 'busy', 'error': str(exc)}


async def _query_lazyapi_locked(account: dict, query: str, timeout: int = 25) -> dict:
    uid = account['user_id']
    session_file = os.path.join(BASE_DIR, str(uid))
    client = TelegramClient(session_file, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            account['authorized'] = False
            return {'status': 'error', 'error': f'Account {uid} not authorized'}

        bot_entity = await client.get_entity(TARGET_BOT)

        # Get last message id to filter only new messages
        prev_msgs = await client.get_messages(bot_entity, limit=1)
        last_id = prev_msgs[0].id if prev_msgs else 0

        target_cmd = normalize_query(query)
        begin_dialog(RUNTIME_DIR, uid, timeout)
        await client.send_message(bot_entity, target_cmd)

        collected_texts = []
        collected_urls = []
        terminal_received = False
        terminal_status = None
        start_time = time.time()

        while time.time() - start_time < timeout:
            await asyncio.sleep(2)
            msgs = await client.get_messages(bot_entity, limit=6)
            new_msgs = [m for m in msgs if m.id > last_id and not m.out]

            for m in reversed(new_msgs):
                text = m.text or ''
                # Filter out loading indicator
                if 'ищу информацию' in text.lower() and len(text) < 40:
                    continue
                if text and text not in collected_texts:
                    collected_texts.append(text)
                    last_id = max(last_id, m.id)

                if m.buttons:
                    for row in m.buttons:
                        for b in row:
                            url = getattr(b, 'url', None)
                            if url and url not in collected_urls:
                                collected_urls.append(url)

            terminal_status = bot_terminal_status('\n'.join(collected_texts))
            if terminal_status is not None:
                terminal_received = True
                # Wait 1 extra second for any trailing message/button
                await asyncio.sleep(1)
                break

        account['last_used'] = int(time.time())
        if terminal_status == 'limit_reached':
            finish_dialog(RUNTIME_DIR, uid)
            account['searches_left'] = 0
            account['quota_observed_at'] = time.time()
            return {'status': 'limit_reached', 'error': f'Account {uid} daily limit reached'}

        if not terminal_received:
            return {'status': 'incomplete' if collected_texts else 'no_response',
                    'error': 'Bot did not send a recognized terminal response within timeout'}

        result_text = '\n\n'.join(collected_texts)
        parsed = parse_lazyapi_response(result_text, collected_urls)
        finish_dialog(RUNTIME_DIR, uid)

        return {
            'status': 'success',
            'account_id': uid,
            'bot_used': TARGET_BOT,
            'query': query,
            'sent_cmd': target_cmd,
            'raw_text': result_text,
            'report_links': parsed['report_links'],
            'parsed': parsed
        }

    except Exception as e:
        return {'status': 'error', 'error': str(e)}
    finally:
        try:
            await finish_cleanup(client.disconnect())
        except Exception:
            pass

def execute_lazyapi_search(query: str, *, lock_timeout=5) -> dict:
    async def operation(account):
        result = await _query_lazyapi_locked(account, query)
        raw = result.get('raw_text', '').lower()
        if result.get('status') == 'success' and any(term in raw for term in
                ['подпишись на основной канал', 'заявку во все приватные', 'обязательные каналы']):
            return {'status': 'unavailable', 'error': 'Bot requires channel subscription'}
        return result
    try:
        return asyncio.run(run_pool(STATE_FILE, BASE_DIR, operation,
                                    runtime_dir=RUNTIME_DIR, busy_timeout=lock_timeout))
    except (OSError, ValueError) as exc:
        return {'status': 'error', 'error': str(exc)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Query LazyAPI bot (@configured_lazyapi_bot) across the isolated 10-account project pool')
    parser.add_argument('--query', '-q', required=True, help='Phone, FIO, INN, SNILS, VIN, car plate, or IP')
    parser.add_argument('--json', action='store_true', help='Output JSON only')
    args = parser.parse_args()

    result = execute_lazyapi_search(args.query)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get('status') == 'success':
            print(f"=== РЕЗУЛЬТАТ LAZYAPI (@{result.get('bot_used')}) ДЛЯ: {args.query} ===")
            print(f"Использован аккаунт: {result.get('account_id')}\n")
            print(result.get('raw_text'))
            if result.get('report_links'):
                print("\n🔗 Ссылки на полные отчеты:")
                for link in result['report_links']:
                    print(f"  - {link}")
        else:
            print(f"Ошибка поиска: {result.get('error')}")
            sys.exit(1)
