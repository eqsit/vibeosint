"""VibeOSINT MCP server — OSINT tools for Hermes Agent.

Exposes the OSINT tools plus the live-report toolkit:
  osint_search / osint_fetch_page / osint_check_phone / osint_check_username /
  osint_check_email / osint_check_domain / osint_check_ip /
  osint_lazyapi_query / osint_framework_search / osint_framework_categories
  osint_report_get / osint_report_add / osint_report_replace /
  osint_report_remove / osint_report_delete_section / osint_report_set_title

All tools take `session_id` explicitly so live activity logs and the live
report are written into the session JSON for real-time frontend updates.

Run:  python3 /opt/vibeosint/server/mcp_osint.py   (stdio transport)
"""

import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
import socket
import ipaddress
import urllib.parse
import contextlib
import copy
import functools
import hashlib
import tempfile
from pathlib import Path
from typing import List, Optional

from mcp.server.fastmcp import FastMCP

DATA_DIR = Path(os.environ.get("OSINT_DATA_DIR", "/opt/vibeosint/data/sessions"))
UPLOADS_DIR = Path(os.environ.get("OSINT_UPLOADS_DIR", str(DATA_DIR.parent / "uploads")))

# Vision (image analysis) backend: OmniRoute OpenAI-compatible endpoint.
VISION_BASE = os.environ.get("OSINT_VISION_BASE", "http://127.0.0.1:20128/v1")
VISION_MODEL = os.environ.get("OSINT_VISION_MODEL", "agy/gemini-3.8-flash-high")


def _vision_api_key() -> str:
    """Use only an explicitly configured operator key; no private-file fallback."""
    return os.environ.get("OSINT_VISION_KEY", "").strip()
ENGINE_SCRIPT = os.environ.get(
    "OSINT_ENGINE_SCRIPT", "/opt/vibeosint/workspace/osint_engine.py"
)
FRAMEWORK_PATH = os.environ.get(
    "OSINT_FRAMEWORK_PATH", "/opt/vibeosint/server/osint_framework.json"
)

DATA_DIR.mkdir(parents=True, exist_ok=True)

mcp = FastMCP("osint")

_FRAMEWORK_CACHE: list | None = None


# ---------- session log helpers ----------

_VALID_SESSION = re.compile(r"^ses_[A-Za-z0-9_-]{1,80}$")

def _safe_id(session_id: str) -> str:
    if not isinstance(session_id, str) or not _VALID_SESSION.fullmatch(session_id):
        raise ValueError("Invalid session ID")
    return session_id


def _session_path(session_id: str) -> Path:
    return DATA_DIR / f"{_safe_id(session_id)}.json"


@contextlib.contextmanager
def _session_lock(session_id: str):
    _safe_id(session_id)
    lock_root = DATA_DIR / ".locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    lock = lock_root / f"{session_id}.lock"
    deadline = time.monotonic() + 6.0
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 300:
                    lock.rmdir()
                    continue
            except (OSError, FileNotFoundError):
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Session is busy")
            time.sleep(.025)
    try:
        yield
    finally:
        try: lock.rmdir()
        except OSError: pass


def _load_session(session_id: str) -> dict:
    p = _session_path(session_id)
    return json.loads(p.read_text(encoding="utf-8"))


def _save_session(session_id: str, data: dict) -> None:
    """Called under _session_lock by all mutating MCP paths."""
    data["updatedAt"] = int(time.time() * 1000)
    target = _session_path(session_id)
    fd, tmp = tempfile.mkstemp(prefix=f".{session_id}.", suffix=".tmp", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def _locked_mutation(func):
    """Hold a cross-process lock across load-edit-save report transactions."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        import inspect
        bound = inspect.signature(func).bind_partial(*args, **kwargs)
        sid = bound.arguments.get("session_id", "")
        if not sid or not _VALID_SESSION.fullmatch(str(sid)):
            return "Ошибка: корректный session_id обязателен."
        with _session_lock(str(sid)):
            return func(*args, **kwargs)
    return wrapper


def _log_event(session_id: str, event_type: str, title: str, detail: str = "") -> None:
    if not session_id or not _VALID_SESSION.fullmatch(session_id):
        return
    try:
        with _session_lock(session_id):
            if not _session_path(session_id).exists():
                return
            session = _load_session(session_id)
            logs = session.setdefault("logs", [])
            logs.append({"time": int(time.time() * 1000), "type": event_type,
                         "title": title, "detail": str(detail)[:300]})
            session["logs"] = logs[-120:]
            session["currentStep"] = f"{title}: {detail}"[:300] if detail else title
            _save_session(session_id, session)
    except Exception:
        pass


_ENGINE_TIMEOUT_SECONDS = 65
_ENGINE_OUTPUT_LIMIT = 15000


def _engine_preview(value, string_limit: int, item_limit: int, depth: int = 6):
    if depth <= 0:
        return "[preview depth limit; see full_result]"
    if isinstance(value, str):
        return value if len(value) <= string_limit else value[:string_limit] + "…[trimmed]"
    if isinstance(value, list):
        result = [_engine_preview(v, string_limit, item_limit, depth - 1) for v in value[:item_limit]]
        if len(value) > item_limit:
            result.append({"_omitted_items": len(value) - item_limit})
        return result
    if isinstance(value, dict):
        result = {k[:200]: _engine_preview(v, string_limit, item_limit, depth - 1)
                  for k, v in list(value.items())[:item_limit]}
        if len(value) > item_limit:
            result["_omitted_keys"] = len(value) - item_limit
        return result
    return value


def _large_engine_result(out: str, result) -> str:
    """Keep the full JSON in the shared project workspace; return a valid preview."""
    workspace = Path(os.environ.get("PANEL_WORKSPACE_DIR", "/opt/vibeosint/workspace")).resolve()
    directory = (workspace / "reports" / "engine-results").resolve()
    if not directory.is_relative_to(workspace):
        raise ValueError("engine result storage escapes project workspace")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix="engine-", suffix=".tmp", dir=directory)
    path = Path(name).with_suffix(".json")
    payload = out.encode("utf-8")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    metadata = {"path": str(path), "sandbox_path": "/workspace/" + path.relative_to(workspace).as_posix(),
                "bytes": len(payload), "chars": len(out), "sha256": hashlib.sha256(payload).hexdigest()}
    for string_limit, item_limit in ((1000, 12), (500, 8), (250, 5), (100, 3), (40, 1), (0, 0)):
        response = json.dumps({"truncated": True, "full_result": metadata,
                               "result": _engine_preview(result, string_limit, item_limit)}, ensure_ascii=False)
        if len(response) <= _ENGINE_OUTPUT_LIMIT:
            return response
    raise ValueError("engine result metadata exceeds output limit")


def _scrub_engine_stderr(stderr) -> str:
    text = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else str(stderr or "")
    for name, value in os.environ.items():
        if value and len(value) >= 4 and re.search(r"KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH|API_HASH", name, re.I):
            text = text.replace(value, "[REDACTED]")
    text = re.sub(r"(?i)(bearer\s+)[^\s,;\"']+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|token|password|secret|api_hash)\s*[=:]\s*)[^\s,;\"']+", r"\1[REDACTED]", text)
    text = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", text)
    return text[:1500]


def _run_engine(action: str, arg: str, extra: str = "", engines: str = "", session_id: str = "") -> str:
    try:
        if session_id:
            _safe_id(session_id)
        # Use the SAME interpreter that runs this MCP server: bare "python3" in
        # the service PATH resolves to the Hermes venv, which lacks the engine
        # deps (phonenumbers/whois/dns/bs4) → empty stdout → "empty engine output".
        args = [sys.executable or "/usr/bin/python3", ENGINE_SCRIPT, action, str(arg)]
        if (extra is not None and extra != "") or engines:
            args.append(str(extra) if extra is not None else "")
        if engines:
            args.append(engines)
        env = dict(os.environ)
        env["OSINT_SESSION_ID"] = session_id or ""
        process = subprocess.run(args, capture_output=True, text=True, timeout=_ENGINE_TIMEOUT_SECONDS, env=env)
        if process.returncode != 0:
            return json.dumps({"error": "engine exited unsuccessfully", "returncode": process.returncode,
                               "stderr": _scrub_engine_stderr(process.stderr)}, ensure_ascii=False)
        out = process.stdout.strip()
        if not out:
            return json.dumps({"error": "empty engine output", "stderr": _scrub_engine_stderr(process.stderr)}, ensure_ascii=False)
        try:
            result = json.loads(out)
        except (ValueError, TypeError):
            return json.dumps({"error": "malformed engine JSON", "stderr": _scrub_engine_stderr(process.stderr)}, ensure_ascii=False)
        if len(out) > _ENGINE_OUTPUT_LIMIT:
            return _large_engine_result(out, result)
        return out
    except subprocess.TimeoutExpired as exc:
        return json.dumps({"error": "engine process timeout", "timeout_seconds": _ENGINE_TIMEOUT_SECONDS,
                           "stderr": _scrub_engine_stderr(exc.stderr)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": "engine execution failed", "detail": _scrub_engine_stderr(type(exc).__name__ + ": " + str(exc))}, ensure_ascii=False)


# ---------- live report helpers ----------

_MAX_ROWS_PER_CALL = 40
_MAX_CELLS_PER_ROW = 10
_MAX_CELL_CHARS = 800


def _norm_cell(x) -> str:
    return str(x if x is not None else "").replace("|", "\\|").replace("\n", " ").strip()


def _section_name(s) -> str:
    return str((s or {}).get("name", "")).strip()


def _inline_sources(row: list) -> list:
    return re.findall(r"https?://[^\s|)]+", " ".join(str(c) for c in row), re.I)


def _evidence_binding(row: list, source: str) -> dict:
    """Integrity binding, not independent source verification or authentication."""
    payload = json.dumps({"row": row, "source": source}, ensure_ascii=False, separators=(",", ":"))
    return {"version": 1, "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest()}


def _row_evidence(row: list, source: str, **metadata) -> dict:
    return {**metadata, "source": source, "binding": _evidence_binding(row, source),
            "status": "source-provided-not-independently-verified" if source else "missing-source"}


def _align_evidence(sec: dict) -> list:
    """Trust versioned row+source bindings; infer legacy sources only inline."""
    rows = sec.get("rows") or []
    old = sec.get("rowEvidence")
    evidence = []
    used = set()
    for row in rows:
        for i, item in enumerate(old if isinstance(old, list) else []):
            if (i not in used and isinstance(item, dict) and isinstance(item.get("source"), str)
                    and isinstance(item.get("binding"), dict)
                    and type(item["binding"].get("version")) is int
                    and item["binding"] == _evidence_binding(row, item["source"])):
                evidence.append(dict(item))
                used.add(i)
                break
        else:
            urls = _inline_sources(row)
            evidence.append(_row_evidence(row, urls[0] if urls else ""))
    if old and (not isinstance(old, list) or len(used) < len(old)):
        # Non-rendered quarantine: retain raw metadata, not an asserted row link.
        # Never read this archive back as active evidence.
        sec.setdefault("unboundRowEvidence", []).append(copy.deepcopy({"rows": rows, "rowEvidence": old}))
    sec["rowEvidence"] = evidence
    return evidence


def _find_section(state: dict, name: str):
    name_l = str(name or "").strip().lower()
    for sec in state.get("sections", []):
        if _section_name(sec).lower() == name_l:
            return sec
    return None


_IMG_EXT_BY_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _ext_for_image(ctype: str, src: str, data: bytes) -> str:
    # Never trust Content-Type or extension; an SVG/HTML script is not an image.
    for magic, ext in _IMG_EXT_BY_MAGIC:
        if data.startswith(magic): return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "webp"
    raise ValueError("unsupported image signature (PNG/JPEG/GIF/WebP only)")


_MAX_IMAGE_BYTES = 12 * 1024 * 1024


def _image_url_public(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or not parsed.hostname:
        raise ValueError("invalid image URL")
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    if not addresses or any(not ipaddress.ip_address(a[4][0].split("%")[0]).is_global for a in addresses):
        raise ValueError("private/internal image URL blocked")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _local_image_path(src: str) -> Path:
    workspace = Path(os.environ.get("PANEL_WORKSPACE_DIR", "/opt/vibeosint/workspace")).resolve()
    original = Path(os.path.expanduser(src)).absolute()
    if ".." in original.parts:
        raise ValueError("image path traversal blocked")
    mappings = [(Path("/workspace"), workspace)]
    # Verified panel sandbox bind mounts, NOT an arbitrary /root/.hermes bridge.
    # /root/.hermes/uploads is not mounted; never guess a host path for it.
    home = Path(os.environ.get("HERMES_HOME", "/opt/vibeosint-hermes-home")).resolve()
    for relative in ("attachments", "images", "cache/images"):
        mappings.append((Path("/root/.hermes") / relative, (home / relative).resolve()))
    roots = [UPLOADS_DIR.resolve(), workspace] + [root for _, root in mappings[1:]]
    for alias, root in mappings:
        if original.is_relative_to(alias):
            candidate = (root / original.relative_to(alias)).resolve()
            if not candidate.is_relative_to(root):
                raise ValueError("image symlink escapes mounted root")
            return candidate
    for root in roots:
        if original.is_relative_to(root):
            candidate = original.resolve()
            if not candidate.is_relative_to(root):
                raise ValueError("image symlink escapes allowed root")
            return candidate
    raise ValueError("локальные изображения разрешены только из workspace/uploads")


def _fetch_image_bytes(src: str):
    """Bounded public image fetch; local images only from workspace and uploaded files."""
    src = str(src or "").strip()
    if not src:
        raise ValueError("пустое значение image")
    if src.startswith("http://") or src.startswith("https://"):
        opener = urllib.request.build_opener(_NoRedirect)
        url = src
        for _ in range(6):
            _image_url_public(url)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; VibeOSINT/1.1)"})
            try:
                response = opener.open(req, timeout=18)
            except urllib.error.HTTPError as exc:
                if exc.code in (301, 302, 303, 307, 308):
                    nxt = exc.headers.get("Location")
                    if not nxt: raise ValueError("redirect without location")
                    url = urllib.parse.urljoin(url, nxt)
                    continue
                raise
            with response as resp:
                data = resp.read(_MAX_IMAGE_BYTES + 1)
            if len(data) > _MAX_IMAGE_BYTES:
                raise ValueError("файл больше 12 МБ")
            return data, _ext_for_image("", url, data)
        raise ValueError("too many image redirects")
    p = _local_image_path(src)
    if not p.is_file():
        raise ValueError("локальный файл не найден")
    if p.stat().st_size > _MAX_IMAGE_BYTES:
        raise ValueError("файл больше 12 МБ")
    data = p.read_bytes()
    return data, _ext_for_image("", src, data)


def _parse_report_md(md: str) -> dict:
    """Best-effort parse of an existing report Markdown into a reportState dict."""
    state = {"title": "", "sections": []}
    cur = None
    separator_pending = False
    for raw in str(md or "").splitlines():
        ln = raw.strip()
        if ln.startswith("## "):
            cur = {"name": ln[3:].strip(), "columns": [], "rows": []}
            separator_pending = False
            state["sections"].append(cur)
        elif ln.startswith("# ") and not state["title"]:
            state["title"] = ln[2:].strip()
        elif cur is not None and ln.startswith("!["):
            m = re.match(r"^!\[(.*?)\]\((.*?)\)\s*$", ln)
            if m:
                if cur.get("type") != "images":
                    cur["type"] = "images"
                    cur.setdefault("items", [])
                cur["items"].append({"url": m.group(2).strip(), "caption": m.group(1).strip(), "source": ""})
        elif cur is not None and ln.startswith("Источник:") and cur.get("type") == "images" and cur.get("items"):
            cur["items"][-1]["source"] = ln[len("Источник:"):].strip()
        elif cur is not None and ln.startswith("- Источник строки "):
            match = re.fullmatch(r"- Источник строки (\d+): (.*?) \(не проверен независимо\)(?: <!-- osint-evidence:v(\d+):([0-9a-f]{64}) -->)?", ln)
            if match:
                item = {"source": match[2].replace("\\|", "|"), "status": "source-provided-not-independently-verified"}
                if match[3]:
                    item["binding"] = {"version": int(match[3]), "sha256": match[4]}
                else:
                    item["legacyMarkdown"] = ln
                # Row numbers are presentation only; alignment validates the hash.
                cur.setdefault("rowEvidence", []).append(item)
            else:
                cur.setdefault("unboundRowEvidence", []).append({"markdown": ln})
        elif cur is not None and ln.startswith("|"):
            cells = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", ln.strip("|"))]
            if not cells or all(c == "" for c in cells):
                continue
            if not cur["columns"]:
                cur["columns"] = cells
                separator_pending = True
            elif separator_pending and all(set(c) <= {"-", ":", " "} and c != "" for c in cells):
                separator_pending = False  # Only the first row after the header is structural.
            else:
                separator_pending = False
                cur["rows"].append(cells)
    state["sections"] = [s for s in state["sections"] if s.get("rows") or s.get("items")]
    for sec in state["sections"]:
        if sec.get("type") != "images":
            _align_evidence(sec)
    return state


def _load_state(session_id: str) -> dict:
    session = _load_session(session_id)
    st = session.get("reportState")
    if isinstance(st, dict) and isinstance(st.get("sections"), list):
        return st
    md = session.get("report") or ""
    if str(md).strip():
        return _parse_report_md(md)
    return {"title": session.get("title", ""), "sections": []}


def _compose_report_md(state: dict, fallback_title: str) -> str:
    title = str(state.get("title") or "").strip() or str(fallback_title or "").strip() or "Досье"
    lines = [f"# {title}", ""]
    for sec in state.get("sections", []):
        if sec.get("type") == "images":
            items = sec.get("items") or []
            if not items:
                continue
            lines.append(f"## {_section_name(sec)}")
            for it in items:
                lines.append(f"![{_norm_cell(it.get('caption') or 'изображение')}]({it.get('url', '')})")
                if it.get("source"):
                    lines.append(f"Источник: {_norm_cell(it['source'])}")
                lines.append("")
            continue
        rows = sec.get("rows") or []
        cols = sec.get("columns") or []
        if not rows or not cols:
            continue
        lines.append(f"## {_section_name(sec)}")
        lines.append("| " + " | ".join(_norm_cell(c) for c in cols) + " |")
        lines.append("|" + "|".join(["---"] * len(cols)) + "|")
        for r in rows:
            cells = [_norm_cell(r[i]) if i < len(r) else "" for i in range(len(cols))]
            lines.append("| " + " | ".join(cells) + " |")
        for i, evidence in enumerate(_align_evidence(sec)):
            if i < len(rows) and isinstance(evidence, dict) and evidence.get("source"):
                lines.append(f"- Источник строки {i + 1}: {_norm_cell(evidence['source'])} (не проверен независимо) "
                             f"<!-- osint-evidence:v1:{evidence['binding']['sha256']} -->")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _save_report(session_id: str, state: dict, note: str) -> None:
    """Persist reportState + recomposed Markdown + a live-log event in one write."""
    state["updatedAt"] = int(time.time() * 1000)
    session = _load_session(session_id)
    session["reportState"] = state
    session["report"] = _compose_report_md(state, session.get("title", ""))
    logs = session.setdefault("logs", [])
    logs.append({
        "time": int(time.time() * 1000),
        "type": "report",
        "title": "Отчёт обновлён",
        "detail": str(note)[:300],
    })
    if len(logs) > 120:
        session["logs"] = logs[-120:]
    session["currentStep"] = f"Отчёт обновлён: {note}"[:300]
    _save_session(session_id, session)


def _require_session(session_id: str) -> Optional[str]:
    if not session_id or not str(session_id).strip():
        return "Ошибка: передай session_id (как в остальных mcp_osint_* вызовах), иначе отчёт не сохранится."
    if not _VALID_SESSION.fullmatch(str(session_id)) or not _session_path(session_id).exists():
        return "Ошибка: сессия не найдена — проверь session_id."
    return None


def _rows_preview(rows: list, limit: int = 8) -> List[str]:
    out = []
    for r in rows[:limit]:
        out.append("- " + " | ".join(_norm_cell(x) for x in r))
    if len(rows) > limit:
        out.append(f"... и ещё {len(rows) - limit}")
    return out


def _section_summary(sec: dict) -> str:
    rows = sec.get("rows") or []
    cols = sec.get("columns") or []
    head = "Сейчас в разделе «" + _section_name(sec) + "» (" + str(len(rows)) + " строк):"
    return "\n".join([head] + (_rows_preview([r for r in rows[-6:]], 6) if cols else []))


# ---------- OSINT tools ----------

@mcp.tool()
def osint_search(query: str, limit: int = 10, session_id: str = "", engines: str = "") -> str:
    """Search the open web: Serper Google FIRST by default; SearXNG and DuckDuckGo provide independent secondary/fallback results. Returns titles, URLs and real content snippets. Use exact search operators and dorks. Select engines="serper" for Serper only or engines="google" for SearXNG Google (or comma-separated engine names); empty preserves the default aggregate. Explicit selection never complements with DuckDuckGo. Inspect requested_engines, returned_engines and errors: CAPTCHA/timeouts are tool failures, not evidence that a source has no results. Always pass session_id so the search shows up in the panel's live activity log."""
    _log_event(session_id, "search", "Поиск в поисковиках", query)
    if engines:
        return _run_engine("search", query, limit, engines, session_id=session_id)
    return _run_engine("search", query, limit, session_id=session_id)


@mcp.tool()
def osint_fetch_page(url: str, session_id: str = "", network: str = "direct") -> str:
    """Fetch readable text from HTTP(S). network=direct (default) stays server-side; explicitly choose residential for the home IP. Residential forbids local/private targets and never falls back to direct if the PC/proxy is offline. Pass session_id for live activity."""
    if network not in ("direct", "residential"):
        return json.dumps({"error": "network must be direct or residential", "network": network})
    _log_event(session_id, "fetch", "Загрузка страницы", f"[{network}] {url}")
    return _run_engine("fetch", url, network, session_id=session_id)


@mcp.tool()
def osint_residential_status(session_id: str = "") -> str:
    """Check home residential proxy end-to-end using Cloudflare trace. Returns available, exit_ip, country, proxy and an explicit error when PC/tunnel/proxy is offline. Never tries direct."""
    _log_event(session_id, "fetch", "Проверка домашнего прокси", "residential")
    try:
        result = json.loads(_run_engine("residential_status", "", session_id=session_id))
        if not isinstance(result, dict):
            raise ValueError("expected an engine JSON object")
    except (ValueError, TypeError) as exc:
        result = {"error": f"Residential health engine output invalid; no direct fallback. {exc}"}
    trace = dict(line.split("=", 1) for line in result.get("text", "").splitlines() if "=" in line)
    available = result.get("status") == 200 and bool(trace.get("ip"))
    status = {"network": "residential", "proxy": "http://127.0.0.1:31313", "available": available}
    if available:
        status.update(exit_ip=trace["ip"], country=trace.get("loc", ""))
    else:
        status["error"] = result.get("error") or "Residential health probe failed; home PC/proxy may be offline; no direct fallback."
    return json.dumps(status, ensure_ascii=False)


@mcp.tool()
def osint_check_phone(phone: str, session_id: str = "") -> str:
    """Deep RU/CIS/international phone intelligence: E.164 validation, DEF code, carrier, region, timezone, WhatsApp/Telegram/Viber direct links, web footprint. Always pass session_id so this shows up in the panel's live activity log."""
    _log_event(session_id, "phone", "Анализ номера телефона", phone)
    return _run_engine("phone", phone, session_id=session_id)


@mcp.tool()
def osint_check_username(username: str, session_id: str = "") -> str:
    """Check username existence across major networks (GitHub, Telegram, VK, Reddit, Habr, Steam, GitLab, YouTube, etc.) + web footprint. Always pass session_id so this shows up in the panel's live activity log."""
    _log_event(session_id, "username", "Поиск по никнейму", username)
    return _run_engine("username", username, session_id=session_id)


@mcp.tool()
def osint_check_email(email: str, session_id: str = "") -> str:
    """Analyze email: domain MX validity, platform registrations via Holehe, web footprint. Always pass session_id so this shows up in the panel's live activity log."""
    _log_event(session_id, "email", "Проверка email", email)
    return _run_engine("email", email, session_id=session_id)


@mcp.tool()
def osint_check_domain(domain: str, session_id: str = "") -> str:
    """Investigate domain: WHOIS registrar, creation/expiry dates, DNS records (A, MX, TXT, NS, SOA), web footprint. Always pass session_id so this shows up in the panel's live activity log."""
    _log_event(session_id, "domain", "Проверка домена и WHOIS", domain)
    return _run_engine("domain", domain, session_id=session_id)


@mcp.tool()
def osint_check_ip(ip: str, session_id: str = "") -> str:
    """Investigate IP: reverse DNS, GeoIP (country, city, ISP, ASN, org). Always pass session_id so this shows up in the panel's live activity log."""
    _log_event(session_id, "ip", "Геолокация и WHOIS IP", ip)
    return _run_engine("ip", ip, session_id=session_id)


@mcp.tool()
def osint_lazyapi_query(query: str, session_id: str = "") -> str:
    """Query LazyAPI / DepSearch bot (@configured_lazyapi_bot) using an isolated project pool of 10 accounts with per-account cross-process serialization. Never uses a shared host pool; busy and uncertain reply cooldowns are explicit. Supports phone, FIO with birth date/city, /inn, /snils, /addr, /company, car plate, VIN, email, IP, VK, TG ID. Returns detailed dossiers and web report links. Always pass the current investigation session_id for account preference and live activity."""
    _log_event(session_id, "bot", "Запрос к LazyAPI (@configured_lazyapi_bot)", query)
    return _run_engine("lazyapi", query, session_id=session_id)


@mcp.tool()
def osint_framework_search(query: str = "", category: str = "", limit: int = 40, session_id: str = "") -> str:
    """Search the full OSINT Framework catalog (1132 curated OSINT tools/sites in 33 categories and 182 subcategories: usernames, emails, phones, domains, IP, social networks, people search, public/business records, geolocation, transport, crypto, dark web, archives, threat intel etc.). Use it to discover WHICH external resource to use for the current target, then open the chosen URL with osint_fetch_page or curl. `query` matches tool name/category; `category` narrows to a category or subcategory."""
    data = _load_framework()
    if not data:
        return "OSINT Framework catalog is unavailable."
    q = (query or "").strip().lower()
    c = (category or "").strip().lower()
    res = []
    for e in data:
        hay_cat = f"{e.get('cat','')} {e.get('sub','')} {e.get('sub2','')}".lower()
        if c and c not in hay_cat:
            continue
        if q and q not in f"{e.get('name','')} {hay_cat}".lower():
            continue
        res.append(e)
    _log_event(session_id, "search", "Поиск инструмента в OSINT Framework",
               f"{query or category} → найдено {len(res)}")
    if not res:
        return "Ничего не найдено. Проверь категории через osint_framework_categories()."
    out = res[: max(1, min(limit, 120))]
    head = f"Найдено {len(res)} инструментов (показано {len(out)}):"
    return head + "\n" + "\n".join(_fmt_entry(e) for e in out)


@mcp.tool()
def osint_framework_categories(category: str = "", session_id: str = "") -> str:
    """List OSINT Framework categories with tool counts. Without arguments returns all 33 top-level categories; with `category` returns its subcategories. Use it to see what directions exist before picking tools via osint_framework_search."""
    data = _load_framework()
    if not data:
        return "OSINT Framework catalog is unavailable."
    c = (category or "").strip().lower()
    counts: dict = {}
    if not c:
        for e in data:
            counts[e.get("cat", "?")] = counts.get(e.get("cat", "?"), 0) + 1
        lines = [f"- {k} ({v})" for k, v in sorted(counts.items(), key=lambda x: -x[1])]
        return f"Категории OSINT Framework ({len(counts)}):\n" + "\n".join(lines)
    for e in data:
        if c in f"{e.get('cat','')}".lower():
            key = e.get("sub") or "(без подкатегории)"
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return f"Категория '{category}' не найдена."
    lines = [f"- {k} ({v})" for k, v in sorted(counts.items(), key=lambda x: -x[1])]
    return f"Подкатегории «{category}»:\n" + "\n".join(lines)


# ---------- live report tools ----------

@mcp.tool()
def osint_report_get(session_id: str = "") -> str:
    """Живой отчёт расследования. Верни текущее содержимое отчёта (Markdown) и сводку по разделам. Вызывай в начале работы (чтобы не дублировать уже найденное) и перед финальным ответом."""
    err = _require_session(session_id)
    if err:
        return err
    state = _load_state(session_id)
    ses = _load_session(session_id)
    md = _compose_report_md(state, ses.get("title", ""))
    sections = [s for s in state.get("sections", []) if (s.get("rows") or s.get("items"))]
    if not sections:
        return "Отчёт пока пуст. Добавляй подтверждённые факты через osint_report_add по мере нахождения."
    counts = []
    for s0 in sections:
        if s0.get("type") == "images":
            counts.append(f"- {_section_name(s0)}: {len(s0.get('items') or [])} изображений")
        else:
            counts.append(f"- {_section_name(s0)}: {len(s0.get('rows') or [])} строк")
    return "Текущий отчёт:\n\n" + md + "\nРазделы:\n" + "\n".join(counts)


@mcp.tool()
@_locked_mutation
def osint_report_add(session_id: str = "", section: str = "", facts: Optional[List[List[str]]] = None, columns: Optional[List[str]] = None, sources: Optional[List[str]] = None) -> str:
    """Живой отчёт: добавь строки фактов в раздел (панель обновит отчёт сразу). При создании НОВОГО раздела обязателен columns — список колонок (например ["Сервис","Имя","Ссылка"]). facts — список строк, каждая строка — список ячеек. Дубликаты пропускаются. Вызывай сразу, как подтвердил факт. Состав раздела: «Сводка» (Параметр|Значение), «Профили в интернете» (Сервис|Имя|Ссылка), «Имена и псевдонимы» (Имя|Источник), «Адреса и геолокация» (Адрес|Источник), «Организации и связи» (Объект|Роль / связь|Источник), «Регистрации на сайтах» (Сайт|Данные|Ссылка)."""
    err = _require_session(session_id)
    if err:
        return err
    section = str(section or "").strip()
    if not section:
        return "Ошибка: укажи section (например «Профили в интернете»)."
    facts = facts or []
    if not isinstance(facts, list) or not facts:
        return "Ошибка: facts должен быть непустым списком (каждая строка — список ячеек)."
    if len(facts) > _MAX_ROWS_PER_CALL:
        return f"Ошибка: максимум {_MAX_ROWS_PER_CALL} строк за вызов, у тебя {len(facts)}. Разбей на несколько вызовов."
    state = _load_state(session_id)
    sec = _find_section(state, section)
    if sec is not None and sec.get("type") == "images":
        return "Раздел «" + section + "» — визуальный: он пополняется через osint_report_attach_image."
    cols_in = [str(c).strip() for c in columns] if isinstance(columns, list) and columns else []
    if sec is None:
        if not cols_in:
            return (f"Ошибка: раздела «{section}» ещё нет. Передай columns — список колонок "
                    f"(например для строки из 3 ячеек: [\"Сервис\",\"Имя\",\"Ссылка\"]).")
        sec = {"name": section, "columns": cols_in, "rows": []}
        state.setdefault("sections", []).append(sec)
    elif cols_in and len(cols_in) != len(sec.get("columns") or []):
        return (f"Ошибка: у раздела «{section}» уже есть колонки: "
                f"{sec.get('columns')}. Приведи строки к ним (или используй другой раздел).")
    eff_cols = sec.get("columns") or []
    _align_evidence(sec)
    added, skipped = 0, 0
    problems = []
    existing = {tuple(_norm_cell(c).lower() for c in (r or [])) for r in sec.get("rows", [])}
    if sources is not None and (not isinstance(sources, list) or len(sources) != len(facts)):
        return "Ошибка: sources должен содержать источник для каждой строки facts."
    for idx, f in enumerate(facts):
        row = list(f) if isinstance(f, list) else [f]
        if len(row) > _MAX_CELLS_PER_ROW:
            problems.append("слишком много ячеек в строке")
            continue
        row = [_norm_cell(x) for x in row]
        if not any(row):
            problems.append("пустая строка — пропущена")
            continue
        if any(len(c) > _MAX_CELL_CHARS for c in row):
            problems.append("ячейка длиннее " + str(_MAX_CELL_CHARS) + " символов — сократи")
            continue
        if len(row) > len(eff_cols):
            if all(not x for x in row[len(eff_cols):]):
                row = row[:len(eff_cols)]
            else:
                problems.append("в строке " + str(len(row)) + " ячеек, а в разделе " + str(len(eff_cols)) +
                                " колонок: " + " | ".join(row[:5]))
                continue
        row = row + [""] * (len(eff_cols) - len(row))
        source = str(sources[idx] if sources else "").strip()
        inline_urls = re.findall(r"https?://[^\s|)]+", " ".join(row), re.I)
        if not inline_urls and not source:
            problems.append("строка без источника (укажи URL в ячейке или sources=[...]): " + " | ".join(row[:3])[:150])
            continue
        if source and not (re.match(r"^https?://[^\s]+$", source, re.I) or source.lower() in ("со слов пользователя", "user-provided", "входные данные пользователя")):
            problems.append("неверный источник: нужен URL либо 'со слов пользователя'")
            continue
        key = tuple(c.lower() for c in row)
        if key in existing:
            skipped += 1
            continue
        sec.setdefault("rows", []).append(row)
        sec.setdefault("rowEvidence", []).append(_row_evidence(row, source or inline_urls[0], recordedAt=int(time.time() * 1000)))
        existing.add(key)
        added += 1
    if added == 0 and skipped == 0 and problems:
        return "Ничего не добавлено:\n- " + "\n- ".join(problems)
    note = f"+{added} × «{section}»" + (f", дублей пропущено: {skipped}" if skipped else "")
    _save_report(session_id, state, note)
    out = [f"Добавлено строк: {added}." + (f" Дубликаты пропущены: {skipped}." if skipped else "")]
    if problems:
        out.append("Не добавлены:\n- " + "\n- ".join(problems))
    out.append(_section_summary(sec))
    return "\n".join(out)


@mcp.tool()
@_locked_mutation
def osint_report_replace(session_id: str = "", section: str = "", match: str = "", row: Optional[List[str]] = None, sources: Optional[List[str]] = None) -> str:
    """Замени первую строку с match. row — ячейки по колонкам; sources — один НОВЫЙ URL либо 'со слов пользователя'. Без sources новая строка обязана содержать URL. Старый источник не переиспользуется."""
    err = _require_session(session_id)
    if err:
        return err
    section = str(section or "").strip()
    m = str(match or "").strip().lower()
    if not section or not m:
        return "Ошибка: нужны section и match (подстрока для поиска строки)."
    if not isinstance(row, list) or not row:
        return "Ошибка: row — новая строка (список ячеек по числу колонок раздела)."
    state = _load_state(session_id)
    sec = _find_section(state, section)
    if sec is None:
        return f"Раздел «{section}» не найден. Проверь отчёт через osint_report_get."
    if sec.get("type") == "images":
        return "Раздел «Изображения» — визуальный: лишнее убери через osint_report_remove, новое добавь через osint_report_attach_image."
    eff_cols = sec.get("columns") or []
    new_row = [_norm_cell(x) for x in row]
    if len(new_row) != len(eff_cols):
        return f"Ошибка: в разделе {len(eff_cols)} колонок ({eff_cols}), а в row {len(new_row)} ячеек."
    if any(len(c) > _MAX_CELL_CHARS for c in new_row):
        return "Ошибка: ячейка длиннее " + str(_MAX_CELL_CHARS) + " символов — сократи."
    inline_urls = _inline_sources(new_row)
    if sources is not None and (not isinstance(sources, list) or len(sources) != 1):
        return "Ошибка: sources должен содержать один источник для новой строки."
    source = str(sources[0] if sources else "").strip()
    if source and not (re.match(r"^https?://[^\s]+$", source, re.I) or source.lower() in ("со слов пользователя", "user-provided", "входные данные пользователя")):
        return "Ошибка: неверный источник — нужен URL либо 'со слов пользователя'."
    if not source and not inline_urls:
        return "Ошибка: новая строка без источника — укажи URL в ячейке или sources=[...]."
    rows = sec.get("rows") or []
    for i, r in enumerate(rows):
        if any(m in _norm_cell(x).lower() for x in r):
            old = list(r)
            evidence = _align_evidence(sec)
            rows[i] = new_row
            evidence[i] = _row_evidence(new_row, source or inline_urls[0], recordedAt=int(time.time() * 1000))
            _save_report(session_id, state, f"~1 × «{section}»")
            return ("Заменено: «" + " | ".join(old) + "» → «" + " | ".join(new_row) + "». \n"
                    + _section_summary(sec))
    return f"Ничего не заменено: в разделе «{section}» нет строк с «{match}». Проверь через osint_report_get."


@mcp.tool()
@_locked_mutation
def osint_report_remove(session_id: str = "", section: str = "", match: str = "") -> str:
    """Живой отчёт: удали из раздела ВСЕ строки, где любая ячейка содержит подстроку match (регистронезависимо). Используй, когда факт опровергнут, устарел или оказался неверным."""
    err = _require_session(session_id)
    if err:
        return err
    section = str(section or "").strip()
    m = str(match or "").strip().lower()
    if not section or not m:
        return "Ошибка: нужны section и match (подстрока удаляемых строк)."
    state = _load_state(session_id)
    sec = _find_section(state, section)
    if sec is None:
        return f"Раздел «{section}» не найден. Проверь отчёт через osint_report_get."
    if sec.get("type") == "images":
        items = sec.get("items") or []
        keep_items = [it for it in items if not any(m in str(it.get(k, '')).lower() for k in ("caption", "url", "source"))]
        removed_i = len(items) - len(keep_items)
        if removed_i == 0:
            return f"Ничего не удалено: в разделе «{section}» нет изображений с «{match}»."
        sec["items"] = keep_items
        _save_report(session_id, state, f"−{removed_i} × «{section}»")
        return f"Удалено изображений: {removed_i}. Осталось: {len(keep_items)}."
    rows = sec.get("rows") or []
    keep_indices = [i for i, r in enumerate(rows) if not any(m in _norm_cell(x).lower() for x in r)]
    keep = [rows[i] for i in keep_indices]
    removed = len(rows) - len(keep)
    if removed == 0:
        return f"Ничего не удалено: в разделе «{section}» нет строк с «{match}»."
    evidence = _align_evidence(sec)
    sec["rows"] = keep
    sec["rowEvidence"] = [evidence[i] for i in keep_indices]
    _save_report(session_id, state, f"−{removed} × «{section}»")
    out = [f"Удалено строк: {removed}."]
    if keep:
        out.append(_section_summary(sec))
    else:
        out.append(f"Раздел «{section}» остался пустым (в отчёт не выводится).")
    return "\n".join(out)


@mcp.tool()
@_locked_mutation
def osint_report_delete_section(session_id: str = "", section: str = "") -> str:
    """Живой отчёт: удали раздел целиком (вместе со строками). Используй, когда весь раздел ошибочен или неактуален."""
    err = _require_session(session_id)
    if err:
        return err
    section = str(section or "").strip()
    if not section:
        return "Ошибка: укажи section."
    state = _load_state(session_id)
    sec = _find_section(state, section)
    if sec is None:
        return f"Раздел «{section}» не найден. Проверь отчёт через osint_report_get."
    state["sections"] = [s for s in state.get("sections", []) if s is not sec]
    _save_report(session_id, state, f"секция удалена: «{section}»")
    return f"Раздел «{section}» удалён (строк было: {len(sec.get('rows') or [])})."


@mcp.tool()
@_locked_mutation
def osint_report_set_title(session_id: str = "", title: str = "") -> str:
    """Живой отчёт: задай заголовок отчёта (H1), например «+7 9XX XXX-XX-XX — полное досье». Вызывай один раз в начале, если хочешь конкретный заголовок."""
    err = _require_session(session_id)
    if err:
        return err
    title = str(title or "").strip()
    if not title:
        return "Ошибка: укажи title."
    state = _load_state(session_id)
    state["title"] = title[:200]
    _save_report(session_id, state, "заголовок обновлён")
    return f"Заголовок отчёта: «{state['title']}»."


@mcp.tool()
def osint_report_attach_image(session_id: str = "", image: str = "", caption: str = "", source: str = "") -> str:
    """Живой отчёт: прикрепи изображение в досье (раздел «Изображения»). image — URL (http/https) или локальный путь к файлу; файл скачается/скопируется в хранилище панели и сразу появится в отчёте с подписью caption. source — исходная страница/ссылка, откуда изображение (попадёт как источник). Используй для найденных фото профилей, аватарок, скриншотов, фото мест и любого подтверждающего изображения."""
    err = _require_session(session_id)
    if err:
        return err
    image = str(image or "").strip()
    caption = str(caption or "").strip() or "изображение"
    source = str(source or "").strip()
    if not image:
        return "Ошибка: укажи image — URL или локальный путь к файлу."
    try:
        data, ext = _fetch_image_bytes(image)
    except Exception as e:
        return f"Не удалось получить изображение ({e}). Проверь URL/путь или скачай файл через terminal и передай локальный путь."
    return _attach_report_image(session_id, data, ext, caption, source)


@_locked_mutation
def _attach_report_image(session_id: str, data: bytes, ext: str, caption: str, source: str) -> str:
    """Only the load/mutate/save transaction is serialized, never remote I/O."""
    err = _require_session(session_id)
    if err:
        return err
    state = _load_state(session_id)
    sec = _find_section(state, "Изображения")
    if sec is None:
        sec = {"name": "Изображения", "type": "images", "items": []}
        state.setdefault("sections", []).append(sec)
    elif sec.get("type") != "images":
        if not (sec.get("rows") or []):
            sec.clear()
            sec.update({"name": "Изображения", "type": "images", "items": []})
        else:
            sec = {"name": "Изображения (доп.)", "type": "images", "items": []}
            state["sections"].append(sec)
    try:
        sess_dir = UPLOADS_DIR / str(session_id)
        sess_dir.mkdir(parents=True, exist_ok=True)
        fname = f"{int(time.time() * 1000)}_attached_{len(sec.get('items') or []) + 1}.{ext}"
        (sess_dir / fname).write_bytes(data)
    except Exception as e:
        return f"Не удалось сохранить изображение на диск: {e}"
    url = f"/api/uploads/{session_id}/{fname}"
    sec.setdefault("items", []).append({"url": url, "caption": caption[:200], "source": source[:300]})
    _save_report(session_id, state, "🖼 +1 изображение · «Изображения»")
    return (f"Изображение добавлено в досье: ![{caption}]({url})\n"
            f"Раздел «{_section_name(sec)}»: {len(sec['items'])} шт. Панель покажет изображение сразу."
            + (f" Источник: {source}" if source else ""))


@mcp.tool()
def osint_analyze_image(image: str = "", question: str = "", session_id: str = "") -> str:
    """Проанализируй изображение (фото) через vision-модель: люди и приметы, текст и документы (OCR), объекты, места, детали, любые зацепки для OSINT. image — URL (http/https) или локальный путь к файлу; question — что именно нужно узнать (пусто = подробное описание). Возвращает текст анализа. Используй для присланных пользователем и найденных в сети изображений."""
    image = str(image or "").strip()
    if not image:
        return "Ошибка: укажи image — URL или локальный путь к файлу."
    q = str(question or "").strip() or (
        "Опиши всё, что видно на изображении, подробно: люди и их приметы, текст (прочитай дословно), "
        "документы и их данные, объекты, обстановка, место, любые зацепки для OSINT (ники, имена, адреса, номера, логотипы)."
    )
    try:
        data, ext = _fetch_image_bytes(image)
    except Exception as e:
        return f"Не удалось получить изображение ({e}). Проверь URL/путь."
    key = _vision_api_key()
    if not key:
        return "Ошибка: не найден ключ визуального анализа (OSINT_VISION_KEY или /opt/vibeosint/.omnikey)."
    _log_event(session_id, "vision", "Анализ изображения", image)
    mime = "jpeg" if ext in ("jpg", "jpeg") else ext
    data_url = f"data:image/{mime};base64,{base64.b64encode(data).decode()}"
    payload = {
        "model": VISION_MODEL,
        "max_tokens": 1200,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": q},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
    }
    try:
        req = urllib.request.Request(
            VISION_BASE.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        if not content:
            return "Модель вернула пустой ответ. Попробуй ещё раз или уточни question."
        return ("Анализ изображения (" + image + "):\n\n" + str(content))[:8000]
    except Exception as e:
        return f"Ошибка визуального анализа: {e}"


# ---------- framework loader ----------

def _load_framework():
    global _FRAMEWORK_CACHE
    if _FRAMEWORK_CACHE is None:
        try:
            _FRAMEWORK_CACHE = json.loads(Path(FRAMEWORK_PATH).read_text(encoding="utf-8"))
        except Exception:
            _FRAMEWORK_CACHE = []
    return _FRAMEWORK_CACHE


def _fmt_entry(e: dict) -> str:
    parts = [p for p in [e.get("cat"), e.get("sub"), e.get("sub2")] if p]
    return f"- {e.get('name','?')} — {e.get('url','')} [{' / '.join(parts)}]"


if __name__ == "__main__":
    mcp.run()
