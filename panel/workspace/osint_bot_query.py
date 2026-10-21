#!/usr/bin/python3
"""
OSINT Telegram Bot Query Tool (operator-configured project account pool).
Supports:
- Individual mirror bot per account (saved in accounts_state.json)
- Dynamic mirror discovery (captures new mirror when bot reports rotation)
- Automatic account rotation upon daily/temporary limits
- Report links and structured fact extraction
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
STATE_FILE = os.path.join(BASE_DIR, 'accounts_state.json')
API_ID = int(os.environ.get("TELEGRAM_API_ID", "0") or "0")
API_HASH = os.environ.get("TELEGRAM_API_HASH", "").strip()

DEFAULT_PRIMARY_BOT = os.environ.get("OSINT_PRIMARY_BOT_USERNAME", "").strip().lstrip("@")
DEFAULT_FALLBACK_BOT = os.environ.get("OSINT_FALLBACK_BOT_USERNAME", "").strip().lstrip("@")
FLAGSHIP_UID = int(os.environ.get("TELEGRAM_PRIMARY_ACCOUNT_ID", "0") or "0")

def load_accounts():
    return load_state(STATE_FILE)


def save_accounts(updates):
    """Merge per-account field patches; do not pass a stale whole-pool snapshot."""
    merge_state(STATE_FILE, updates)

def parse_bot_response(text, button_urls):
    """Extract structured OSINT facts and report links from bot message."""
    data = {
        'names': [],
        'phones': [],
        'emails': [],
        'usernames': [],
        'addresses': [],
        'vehicles': [],
        'inns': [],
        'documents': [],
        'socials': [],
        'report_links': list(set(button_urls)),
        'other': []
    }

    # Extract any embedded HTTP(S) links in text
    embedded_urls = re.findall(r'https?://[^\s\n\)\"\'\>]+', text)
    for u in embedded_urls:
        if u not in data['report_links']:
            data['report_links'].append(u)

    lines = text.split('\n')
    for line in lines:
        line_clean = line.strip()
        if not line_clean:
            continue

        # INN / OGRN
        if 'инн' in line_clean.lower() or 'огрн' in line_clean.lower():
            data['inns'].append(line_clean)
        # Phones
        elif re.search(r'(\+?7|8)[\s\-(]?\d{3}[\s\-)]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}', line_clean):
            data['phones'].append(line_clean)
        # Emails
        elif '@' in line_clean and re.search(r'[\w\.-]+@[\w\.-]+\.\w+', line_clean):
            data['emails'].append(line_clean)
        # Addresses
        elif 'адрес' in line_clean.lower() or 'г.' in line_clean or 'ул.' in line_clean or 'обл.' in line_clean:
            data['addresses'].append(line_clean)
        # Vehicles
        elif 'вин' in line_clean.lower() or 'vin' in line_clean.lower() or 'авто' in line_clean.lower() or 'госномер' in line_clean.lower():
            data['vehicles'].append(line_clean)
        # Telegram / Social
        elif '@' in line_clean or 't.me/' in line_clean or 'vk.com/' in line_clean:
            data['socials'].append(line_clean)
        # FIO / Names
        elif 'фио' in line_clean.lower() or 'директор' in line_clean.lower() or 'личность' in line_clean.lower():
            data['names'].append(line_clean)
        elif 'паспорт' in line_clean.lower() or 'снилс' in line_clean.lower() or 'права' in line_clean.lower():
            data['documents'].append(line_clean)
        else:
            data['other'].append(line_clean)

    return data

async def query_with_client(account, query, target_bot=None, timeout=25, *, lock_timeout=5):
    try:
        async with account_lock(RUNTIME_DIR, account['user_id'], timeout=lock_timeout):
            return await _query_with_client_locked(account, query, target_bot, timeout)
    except PoolBusy as exc:
        return {'status': 'busy', 'error': str(exc)}


async def _query_with_client_locked(account, query, target_bot=None, timeout=25):
    uid = account['user_id']
    client = TelegramClient(os.path.join(BASE_DIR, str(uid)), API_ID, API_HASH)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            account['authorized'] = False
            return {'status': 'error', 'error': f'Account {uid} not authorized'}
        pending = [target_bot or account.get('mirror_bot') or DEFAULT_PRIMARY_BOT]
        tried = set()
        while pending:
            bot = pending.pop(0)
            if bot.lower() in tried:
                continue
            tried.add(bot.lower())
            result = await _query_bot_connected(account, query, client, bot, timeout)
            if result.get('status') != 'limit_reached':
                return result
            # Reuse this connection and its UID lock; never recursively open SQLite.
            mirror = account.get('mirror_bot')
            if mirror and mirror.lower() not in tried and len(tried) < 3:
                pending.append(mirror)
            if DEFAULT_FALLBACK_BOT.lower() not in tried:
                pending.append(DEFAULT_FALLBACK_BOT)
        account['searches_left'] = 0  # Every attempted mirror explicitly reported a limit.
        account['quota_observed_at'] = time.time()
        return {'status': 'limit_reached', 'error': 'All account bot mirrors reported a limit'}
    except Exception as exc:
        return {'status': 'error', 'error': str(exc)}
    finally:
        try:
            await finish_cleanup(client.disconnect())
        except Exception:
            pass


async def _query_bot_connected(account, query, client, bot_to_query, timeout):
    uid = account['user_id']
    try:
        bot_entity = await client.get_entity(bot_to_query)

        # Get last message id
        prev_msgs = await client.get_messages(bot_entity, limit=1)
        last_id = prev_msgs[0].id if prev_msgs else 0

        # Normalize query
        clean_q = query.strip()
        if re.match(r'^\+?\d{10,12}$', clean_q):
            clean_q = clean_q.replace('+', '')
            if clean_q.startswith('8') and len(clean_q) == 11:
                clean_q = '7' + clean_q[1:]

        begin_dialog(RUNTIME_DIR, uid, timeout)
        await client.send_message(bot_entity, clean_q)

        collected_texts = []
        collected_urls = []
        terminal_received = False
        terminal_status = None
        start_time = time.time()

        while time.time() - start_time < timeout:
            await asyncio.sleep(2)
            msgs = await client.get_messages(bot_entity, limit=5)
            new_msgs = [m for m in msgs if m.id > last_id and not m.out]

            clicked = False
            for m in reversed(new_msgs):
                text = m.text or ''
                if text and text not in collected_texts:
                    collected_texts.append(text)
                    last_id = max(last_id, m.id)

                # Collect button URLs and auto-click navigation buttons
                if m.buttons:
                    for row in m.buttons:
                        for b in row:
                            url = getattr(b, 'url', None)
                            if url and url not in collected_urls:
                                collected_urls.append(url)

                            # Auto-click navigation or selection buttons
                            if not clicked and b.data:
                                if b.data.startswith(b'W/t.me/') or b.data.startswith(b'W//inn') or b.data.startswith(b'W/vk.com') or b.data.startswith(b'PERSON/RU') or b'report' in b.data.lower() or b'full' in b.data.lower():
                                    try:
                                        await b.click()
                                        clicked = True
                                        await asyncio.sleep(2)
                                    except Exception:
                                        pass
                                    break

            # If we received final dossier/data or report
            terminal_status = bot_terminal_status('\n'.join(collected_texts))
            if terminal_status is not None:
                terminal_received = True
                break

        account['last_used'] = int(time.time())

        # Check for suggested mirror in text
        suggested = re.findall(r'@([a-zA-Z0-9_]+bot)', '\n'.join(collected_texts))
        if suggested:
            for sb in suggested:
                if sb.lower() not in ['botfather', 'spambot', bot_to_query.lower()]:
                    account['mirror_bot'] = sb
                    break

        if terminal_status == 'limit_reached':
            finish_dialog(RUNTIME_DIR, uid)
            return {'status': 'limit_reached', 'error': 'Bot mirror limit reached'}

        if not terminal_received:
            return {'status': 'incomplete' if collected_texts else 'no_response',
                    'error': 'Bot did not send a recognized terminal response within timeout'}

        result_text = '\n\n'.join(collected_texts)
        parsed = parse_bot_response(result_text, collected_urls)
        finish_dialog(RUNTIME_DIR, uid)

        return {
            'status': 'success',
            'account_id': uid,
            'is_flagship': (uid == FLAGSHIP_UID),
            'bot_used': bot_to_query,
            'query': query,
            'raw_text': result_text,
            'report_links': parsed['report_links'],
            'parsed': parsed
        }

    except Exception as e:
        return {'status': 'error', 'error': str(e)}


def execute_search(query, target_bot=None, *, lock_timeout=5):
    async def operation(account):
        return await _query_with_client_locked(account, query, target_bot)
    try:
        return asyncio.run(run_pool(STATE_FILE, BASE_DIR, operation,
                                    runtime_dir=RUNTIME_DIR, busy_timeout=lock_timeout))
    except (OSError, ValueError) as exc:
        return {'status': 'error', 'error': str(exc)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Query OSINT bot across TG account pool with individual mirror support')
    parser.add_argument('--query', '-q', required=True, help='Phone, username, INN, VIN, or name')
    parser.add_argument('--bot', default=None, help='Target bot username override')
    parser.add_argument('--json', action='store_true', help='Output raw JSON only')
    args = parser.parse_args()

    result = execute_search(args.query, target_bot=args.bot)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get('status') == 'success':
            print(f"=== РЕЗУЛЬТАТ ПОИСКА ПО: {args.query} ===")
            print(f"Использован бот: @{result.get('bot_used')}")
            print(f"Использован аккаунт: {result.get('account_id')} (Флагман: {result.get('is_flagship')})\n")
            print(result.get('raw_text'))
            if result.get('report_links'):
                print("\n🔗 Ссылки на полные отчеты:")
                for link in result['report_links']:
                    print(f"  - {link}")
        else:
            print(f"Ошибка поиска: {result.get('error')}")
            sys.exit(1)
