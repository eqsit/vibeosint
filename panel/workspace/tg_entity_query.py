#!/usr/bin/python3
"""
Telegram Direct Entity / Phone OSINT Tool.
Uses the flagship / designated account to query Telegram MTProto directly:
- Resolve phone number to Telegram User Profile (ID, Name, Username)
- Resolve username or User ID to Profile info (bio, name, status, flags)
- Search public chats / channels / messages
"""

import sys
import os
import json
import asyncio
import argparse
from telethon import TelegramClient
from telethon.errors import UsernameNotOccupiedError
from tg_pool_runtime import RUNTIME_DIR, load_state, run_pool, finish_cleanup
from telethon.tl.functions.contacts import ImportContactsRequest, DeleteContactsRequest
from telethon.tl.types import InputPhoneContact
from telethon.tl.functions.users import GetFullUserRequest

def get_base_dir():
    workspace = os.path.dirname(os.path.abspath(__file__))
    if workspace == '/workspace':
        return '/root/tg_accounts'
    # Fail closed on the host: never fall back to its shared account pool.
    return os.path.join(os.path.dirname(workspace), 'tg_accounts')

BASE_DIR = get_base_dir()
API_ID = int(os.environ.get("TELEGRAM_API_ID", "0") or "0")
API_HASH = os.environ.get("TELEGRAM_API_HASH", "").strip()
FLAGSHIP_SESSION = os.path.join(BASE_DIR, os.environ.get("TELEGRAM_PRIMARY_ACCOUNT_ID", "0"))

async def resolve_phone_internal(client: TelegramClient, phone: str) -> dict:
    clean_phone = ''.join(c for c in phone if c.isdigit())
    if clean_phone.startswith('8') and len(clean_phone) == 11:
        clean_phone = '7' + clean_phone[1:]

    contact = InputPhoneContact(client_id=0, phone=clean_phone, first_name='Target', last_name='')
    try:
        res = await client(ImportContactsRequest([contact]))
        if not res.users:
            return {'found': False, 'phone': clean_phone, 'message': 'No registered Telegram user for this phone or privacy settings restrict lookup.'}

        user = res.users[0]
        # Clean up temporary contact
        await client(DeleteContactsRequest(id=[user.id]))

        # Try to get full user details
        bio = None
        try:
            full = await client(GetFullUserRequest(user.id))
            bio = full.full_user.about
        except Exception:
            pass

        return {
            'found': True,
            'user_id': user.id,
            'phone': getattr(user, 'phone', clean_phone),
            'first_name': user.first_name,
            'last_name': user.last_name,
            'username': user.username,
            'is_bot': user.bot,
            'is_scam': getattr(user, 'scam', False),
            'is_fake': getattr(user, 'fake', False),
            'is_premium': getattr(user, 'premium', False),
            'bio': bio,
            'tg_link': f'https://t.me/{user.username}' if user.username else f'tg://user?id={user.id}'
        }
    except Exception as e:
        return {'found': False, 'phone': clean_phone, 'error': str(e)}

async def resolve_entity_internal(client: TelegramClient, query: str) -> dict:
    clean_q = query.strip()
    if clean_q.startswith('@'):
        clean_q = clean_q[1:]
    if clean_q.isdigit():
        clean_q = int(clean_q)

    try:
        entity = await client.get_entity(clean_q)
        bio = None
        is_channel = getattr(entity, 'broadcast', False) or getattr(entity, 'megagroup', False)

        if not is_channel and hasattr(entity, 'id'):
            try:
                full = await client(GetFullUserRequest(entity.id))
                bio = full.full_user.about
            except Exception:
                pass

        return {
            'found': True,
            'id': entity.id,
            'type': 'channel_or_group' if is_channel else 'user',
            'title_or_name': getattr(entity, 'title', f"{getattr(entity, 'first_name', '')} {getattr(entity, 'last_name', '') or ''}".strip()),
            'username': getattr(entity, 'username', None),
            'phone': getattr(entity, 'phone', None),
            'is_scam': getattr(entity, 'scam', False),
            'is_fake': getattr(entity, 'fake', False),
            'is_premium': getattr(entity, 'premium', False),
            'bio': bio,
            'tg_link': f"https://t.me/{entity.username}" if getattr(entity, 'username', None) else None
        }
    except UsernameNotOccupiedError as e:
        return {'found': False, 'status': 'not_found', 'query': str(query), 'error': str(e)}
    except Exception as e:
        # Timeouts, RPC failures and missing account-local access hashes do not
        # prove absence. Let the project pool try a different account.
        return {'found': False, 'status': 'unavailable', 'query': str(query), 'error': str(e)}

def load_accounts():
    return load_state(os.path.join(BASE_DIR, 'accounts_state.json'))


async def execute_tg_query(query: str, query_type: str = 'auto', *, lock_timeout=5) -> dict:
    async def operation(account):
        result = await _execute_tg_locked(account, query, query_type)
        result['account_id'] = account['user_id']
        return result
    try:
        return await run_pool(os.path.join(BASE_DIR, 'accounts_state.json'), BASE_DIR, operation,
                              runtime_dir=RUNTIME_DIR, busy_timeout=lock_timeout, respect_quota=False)
    except (OSError, ValueError) as exc:
        return {'status': 'error', 'error': str(exc)}


async def _execute_tg_locked(account, query, query_type):
    client = TelegramClient(os.path.join(BASE_DIR, str(account['user_id'])), API_ID, API_HASH)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            account['authorized'] = False
            return {'status': 'error', 'error': 'Project account not authorized'}

        q = query.strip()
        digits = ''.join(c for c in q if c.isdigit())

        # Decide search type
        if query_type == 'phone' or (query_type == 'auto' and q.startswith('+') and len(digits) >= 10):
            res = await resolve_phone_internal(client, q)
            if 'error' in res:
                return {'status': 'unavailable', 'query_type': 'phone', 'result': res,
                        'error': res['error']}
            return {'status': 'success', 'query_type': 'phone', 'result': res}
        elif query_type == 'entity' or query_type == 'auto':
            # Check if username or digits
            res = await resolve_entity_internal(client, q)
            if res.get('found'):
                return {'status': 'success', 'query_type': 'entity', 'result': res}
            # If entity failed and looks like phone, try phone lookup
            if len(digits) in (10, 11, 12):
                res_phone = await resolve_phone_internal(client, q)
                if 'error' in res_phone:
                    return {'status': 'unavailable', 'query_type': 'phone', 'result': res_phone,
                            'error': res_phone['error']}
                # An empty phone response may be privacy-restricted, not proof
                # of absence. Keep it distinct from the failed entity lookup.
                return {'status': 'success', 'query_type': 'phone', 'result': res_phone}
            return {'status': res.get('status', 'unavailable'), 'query': q,
                    'error': res.get('error', 'Entity lookup unavailable')}
        else:
            return {'status': 'error', 'error': f'Unknown query type {query_type}'}
    finally:
        try:
            await finish_cleanup(client.disconnect())
        except Exception:
            pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Query Telegram direct MTProto entity / phone resolver')
    parser.add_argument('--query', '-q', required=True, help='Phone number, @username, channel, or TG ID')
    parser.add_argument('--type', choices=['auto', 'phone', 'entity'], default='auto')
    parser.add_argument('--json', action='store_true', help='Output JSON')
    args = parser.parse_args()

    res = asyncio.run(execute_tg_query(args.query, args.type))
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(res, ensure_ascii=False, indent=2))
