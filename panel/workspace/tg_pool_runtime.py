"""Project-local Telegram leases shared by host MCP and the Docker workspace.

Lock files live next to scripts, never in the separate SQLite session pools.
Do not unlink flock files: replacing their inode defeats mutual exclusion.
"""
import asyncio
from contextlib import asynccontextmanager
import fcntl
import os
from pathlib import Path
import re
import time

import json
import tempfile


def load_state(path):
    try:
        with open(path, encoding='utf-8') as handle:
            rows = json.load(handle)
    except FileNotFoundError:
        return []
    if not isinstance(rows, list) or any(not isinstance(row, dict) or 'user_id' not in row for row in rows):
        raise ValueError('Invalid Telegram account state')
    return rows


def merge_state(path, updates):
    """Atomically merge *field patches*, never stale whole-pool snapshots.

    This synchronous helper must be called via asyncio.to_thread in async paths.
    Lock the stable sidecar inode, not the JSON inode replaced by os.replace.
    Unknown quotas stay unknown; no inferred/decremented quota is written here.
    """
    path = Path(path)
    lock = path.with_name('.' + path.name + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    temporary = None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        rows = load_state(path)
        by_uid = {account_uid(row['user_id']): row for row in rows}
        for update in updates:
            uid = account_uid(update['user_id'])
            if uid not in by_uid:
                by_uid[uid] = {'user_id': int(uid)}
                rows.append(by_uid[uid])
            by_uid[uid].update(update)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.' + path.name + '-', delete=False) as handle:
            temporary = handle.name
            os.fchmod(handle.fileno(), 0o600)
            json.dump(rows, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.close(fd)


RUNTIME_DIR = Path(__file__).resolve().parent / '.tg-runtime'


def bot_terminal_status(text):
    """Recognize response lines, not keywords mentioned in processing acks.

    Unknown formats fail closed: keep the reply stream quarantined on timeout.
    """
    for raw in text.splitlines():
        line = re.sub(r'[*`_]', '', raw.lower()).strip()
        line = re.sub(r'^[\W_]+', '', line)
        if re.search(r'\b(?:ожидайте|ищу|проверяю|собирается|формируется|'
                     r'обрабатывается|продолжается)\b', line):
            continue
        if re.match(r'^(?:(?:дневной|суточный|ежедневный)\s+)?лимит'
                    r'(?:\s+(?:запросов|поисков|поиска))?\s*[:—-]?\s*'
                    r'(?:исчерпан\b|достигнут\b|0\s*/\s*3\b)', line):
            return 'limit_reached'
        if re.fullmatch(r'(?:данные не найдены|ничего не найдено|не найдено)[.!]?', line):
            return 'success'
        if re.fullmatch(r'(?:основная информация|информация об ip|история изменения имени)'
                        r'(?:\s*:\s*\S.*)?', line):
            return 'success'
        if re.match(r'^(?:id|инн|огрн|адрес|телефон|паспорт)\s*:\s*\S', line):
            return 'success'
        if re.match(r'^полный отч[её]т\s*:\s*https?://\S+', line):
            return 'success'
    return None


class PoolBusy(Exception):
    """No eligible account lock became free before the deadline."""


def account_uid(uid):
    value = str(uid)
    if not value.isascii() or not value.isdecimal() or int(value) <= 0:
        raise ValueError('Invalid Telegram account UID')
    return str(int(value))


def _quota_retry_due(account):
    """An observed zero is not permanent; retry after a conservative full day.

    Do not guess the bot's remaining balance or midnight timezone. Missing
    timestamps stay exhausted until an explicit refresh supplies evidence.
    """
    # Legacy rows used last_used for both purposes. Freeze that value under the
    # UID lock before any operation can update the LRU timestamp.
    observed_at = account.get('quota_observed_at', account.get('last_used'))
    return (isinstance(observed_at, (int, float)) and observed_at > 0
            and time.time() - observed_at >= 86400)


def _eligible(account, base_dir, respect_quota):
    quota = account.get('searches_left')
    return (account.get('authorized', True)
            and (not respect_quota or quota is None or quota > 0 or _quota_retry_due(account))
            and (Path(base_dir) / (account_uid(account['user_id']) + '.session')).is_file())


def _last_claim(account, runtime_dir):
    path = Path(runtime_dir) / ('account-' + account_uid(account['user_id']) + '.lock')
    try:
        return path.stat().st_mtime_ns
    except FileNotFoundError:
        return int(account.get('last_used', 0) * 1_000_000_000)


async def run_pool(state_file, base_dir, operation, *, runtime_dir=RUNTIME_DIR,
                   busy_timeout=5, respect_quota=True):
    """Run operation(account) under one UID lease, skipping busy accounts.

    The callback owns connection/disconnect and must not acquire a second UID
    lease. Only changed fields of the selected account are persisted, under the
    state-sidecar lock, before releasing the UID lock.
    """
    deadline = time.monotonic() + max(0, busy_timeout)
    attempted = set()
    failures = []
    while True:
        accounts = load_state(state_file)
        available = [a for a in accounts if _eligible(a, base_dir, respect_quota)
                     and account_uid(a['user_id']) not in attempted]
        session_id = os.environ.get('OSINT_SESSION_ID', '')
        preferred = None
        if session_id and accounts:
            import hashlib
            identities = sorted({account_uid(a['user_id']) for a in accounts}, key=int)
            index = int.from_bytes(hashlib.sha256(session_id.encode()).digest()[:8], 'big') % len(identities)
            preferred = identities[index]
        available.sort(key=lambda a: (account_uid(a['user_id']) != preferred,
                                      _last_claim(a, runtime_dir), int(a['user_id'])))
        busy = False
        for candidate in available:
            uid = account_uid(candidate['user_id'])
            try:
                async with account_lock(runtime_dir, uid, timeout=0):
                    # Another process may have exhausted this account while we waited.
                    fresh = next((a for a in load_state(state_file)
                                  if account_uid(a['user_id']) == uid), None)
                    if fresh is None or not _eligible(fresh, base_dir, respect_quota):
                        continue
                    attempted.add(uid)
                    original = dict(fresh)
                    if fresh.get('searches_left') is not None and 'quota_observed_at' not in fresh:
                        legacy = fresh.get('last_used')
                        fresh['quota_observed_at'] = (legacy if isinstance(legacy, (int, float))
                                                     and legacy > 0 else None)
                    if (respect_quota and fresh.get('searches_left') is not None
                            and fresh['searches_left'] <= 0 and _quota_retry_due(fresh)):
                        # The old observation expired; the new balance is unknown.
                        fresh['searches_left'] = None
                    os.utime(Path(runtime_dir) / ('account-' + uid + '.lock'), None)
                    fresh['last_used'] = time.time()
                    try:
                        result = await operation(fresh)
                    except Exception as exc:
                        result = {'status': 'error', 'error': str(exc), 'account_id': int(uid)}
                    finally:
                        changed = {key: value for key, value in fresh.items()
                                   if key not in original or original[key] != value}
                        if changed:
                            await asyncio.to_thread(merge_state, state_file,
                                                    [dict(changed, user_id=int(uid))])
                    if result.get('status') in ('success', 'not_found'):
                        return result
                    failures.append(dict(account_id=int(uid), status=result.get('status', 'error'),
                                         error=result.get('error', 'Account operation failed')))
            except PoolBusy:
                busy = True
        if busy and time.monotonic() < deadline:
            await asyncio.sleep(min(.05, max(0, deadline - time.monotonic())))
            continue
        if busy:
            return {'status': 'busy', 'error': 'Telegram pool busy; account wait timed out', 'attempts': failures}
        if failures:
            return dict(failures[-1], attempts=failures)
        if accounts and any(a.get('authorized', True) and a.get('searches_left') is not None
                            and a['searches_left'] <= 0 for a in accounts):
            return {'status': 'limit_reached', 'error': 'Telegram pool quotas exhausted'}
        return {'status': 'error', 'error': 'No authorized project accounts with session files'}


async def finish_cleanup(awaitable):
    """Finish cleanup before propagating even repeated task cancellation.

    asyncio.shield alone leaves cleanup running after its caller releases the
    UID flock. Keep awaiting the task, then re-raise cancellation to the caller.
    """
    task = asyncio.ensure_future(awaitable)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break
    if cancelled:
        # Retrieve failures to avoid an unobserved task exception.
        if not task.cancelled():
            task.exception()
        raise asyncio.CancelledError
    return task.result()


def begin_dialog(runtime_dir, uid, timeout):
    """Quarantine an uncertain reply stream, including if the process is killed.

    Only the UID lock holder calls this. No query/account identity is stored.
    A successful terminal reply clears it; timeout/error/cancellation leaves a
    bounded cooldown so another investigation cannot immediately reuse the UID.
    """
    path = Path(runtime_dir) / ('account-' + account_uid(uid) + '.cooldown')
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.cooldown-', delete=False) as handle:
        temporary = handle.name
        try:
            handle.write(str(time.time() + max(0, timeout) + 120))
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def finish_dialog(runtime_dir, uid):
    path = Path(runtime_dir) / ('account-' + account_uid(uid) + '.cooldown')
    path.unlink(missing_ok=True)


def _cooldown_remaining(runtime_dir, uid):
    path = Path(runtime_dir) / ('account-' + account_uid(uid) + '.cooldown')
    try:
        remaining = float(path.read_text()) - time.time()
    except FileNotFoundError:
        return 0
    except ValueError:
        raise PoolBusy('Telegram account cooldown is invalid; refusing reuse')
    if remaining <= 0:
        path.unlink(missing_ok=True)
    return max(0, remaining)


@asynccontextmanager
async def account_lock(runtime_dir, uid, timeout=5):
    """Acquire a UID-wide flock without blocking the asyncio event loop."""
    directory = Path(runtime_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / ('account-' + account_uid(uid) + '.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + max(0, timeout)
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if not _cooldown_remaining(directory, uid):
                    break
                fcntl.flock(fd, fcntl.LOCK_UN)
                raise BlockingIOError('Account is cooling down after an uncertain bot reply')
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PoolBusy('Telegram account busy; lock wait timed out')
                await asyncio.sleep(min(.05, remaining))
        yield account_uid(uid)
    finally:
        # close also releases the lock on cancellation, exceptions and process exit.
        os.close(fd)
