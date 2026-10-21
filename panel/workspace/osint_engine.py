import sys
import os
import json
import urllib.parse
import urllib.request
import re
import socket
import ipaddress
import subprocess
import phonenumbers
from phonenumbers import carrier, geocoder, timezone
import whois
import dns.resolver
import requests
from bs4 import BeautifulSoup

def _serper_key():
    """Look up the existing Serper key without logging it or embedding it in responses."""
    import os
    key = os.environ.get("SERPER_API_KEY", "").strip()
    if key:
        return key
    home = os.environ.get("HERMES_HOME", "/opt/vibeosint-hermes-home")
    try:
        for line in open(os.path.join(home, ".env"), encoding="utf-8"):
            if line.startswith("SERPER_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return ""


def _serper_search(query, limit):
    key = _serper_key()
    if not key:
        raise RuntimeError("SERPER_API_KEY unavailable (configure in Hermes .env)")
    body = json.dumps({"q": query, "num": min(limit, 20)}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("https://google.serper.dev/search", data=body, headers={
        "X-API-KEY": key, "Content-Type": "application/json", "Accept": "application/json"
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.load(resp)
    if (not isinstance(payload, dict) or payload.get("error")
            or int(payload.get("statusCode") or 200) >= 400
            or not isinstance(payload.get("organic", []), list)):
        raise RuntimeError("Serper returned an error or invalid search payload")
    return [{"title": str(x.get("title") or "").strip(),
             "url": str(x.get("link") or "").strip(),
             "snippet": str(x.get("snippet") or "").strip(),
             "source": "serper-google", "verification": "search-result-only"}
            for x in payload.get("organic", []) if x.get("link")]


def search_web(query, limit=12, engines=None):
    """Serper (Google) first; SearXNG + DDG additional engines/fallbacks.
    Explicit engines never fall back to other providers; snippets are not evidence.
    """
    if engines is not None and not isinstance(engines, str):
        raise ValueError("engines must be comma-separated text")
    selected = list(dict.fromkeys(e.strip().lower() for e in (engines or "").split(",") if e.strip()))
    if engines is not None and not selected:
        raise ValueError("engines selection cannot be empty")
    if (isinstance(limit, bool) or not isinstance(limit, (int, str))
            or not re.fullmatch(r"[0-9]+", str(limit)) or int(limit) < 1):
        raise ValueError("limit must be a positive integer")
    limit = min(int(limit), 30)
    results, errors, seen = [], [], set()
    def extend(rows):
        for item in rows:
            url = item.get("url", "")
            if not url or url in seen:
                continue
            seen.add(url)
            results.append(item)
            if len(results) >= limit:
                break
    use_serper = not selected or "serper" in selected or "serper-google" in selected
    use_searx = not selected or any(x not in ("serper", "serper-google", "duckduckgo") for x in selected)
    use_ddg = not selected or "duckduckgo" in selected
    if use_serper:
        try: extend(_serper_search(query, limit))
        except Exception as exc: errors.append(["serper-google", f"{type(exc).__name__}: {exc}"])
    if use_searx and (selected or len(results) < limit):
        try:
            url = (os.environ.get("OSINT_SEARXNG_URL", "http://127.0.0.1:8888/search")
                   + "?q=" + urllib.parse.quote(query) + "&format=json")
            searx_engines = []
            for e in selected:
                if e in ("serper", "serper-google", "duckduckgo"): continue
                searx_engines.extend(["google cse", "google"] if e == "google" else [e])
            if searx_engines:
                url += "&engines=" + urllib.parse.quote(",".join(dict.fromkeys(searx_engines)))
            req = urllib.request.Request(url, headers={"User-Agent": "VibeOSINT/1.1"})
            with urllib.request.urlopen(req, timeout=18) as resp:
                data = json.load(resp)
            errors.extend(data.get("unresponsive_engines", []))
            extend([{"title": x.get("title", "").strip(), "url": x.get("url", "").strip(),
                     "snippet": x.get("content", "").strip(), "source": x.get("engine", "searxng"),
                     "verification": "search-result-only"} for x in data.get("results", [])])
        except Exception as exc: errors.append(["searxng", f"{type(exc).__name__}: {exc}"])
    if use_ddg and (selected or len(results) < min(5, limit)):
        try:
            req = urllib.request.Request("https://lite.duckduckgo.com/lite/",
                  urllib.parse.urlencode({"q": query}).encode(), headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                soup = BeautifulSoup(resp.read().decode("utf-8", "ignore"), "html.parser")
            links = soup.find_all("a", class_="result-link")
            page_text = soup.get_text(" ").lower()
            if (soup.select_one('#challenge-form, #anomaly-form, input[name*="captcha"], form[action*="anomaly.js"]')
                    or "bots use duckduckgo too" in page_text
                    or (not links and any(marker in page_text for marker in (
                        "captcha", "verify you are human", "select all squares containing a duck",
                        "please complete the following challenge")))):
                raise RuntimeError("DuckDuckGo challenge/CAPTCHA; search unavailable")
            snippets = soup.find_all("td", class_="result-snippet")
            extend([{"title": x.get_text().strip(), "url": x.get("href", ""),
                     "snippet": snippets[i].get_text().strip() if i < len(snippets) else "",
                     "source": "duckduckgo", "verification": "search-result-only"}
                    for i, x in enumerate(links)])
        except Exception as exc: errors.append(["duckduckgo", f"{type(exc).__name__}: {exc}"])
    return {"query": query, "status": _component_status(results[:limit], errors),
            "primary_engine": "serper-google", "count": len(results[:limit]),
            "results": results[:limit], "requested_engines": selected or ["serper", "searxng", "duckduckgo"],
            "returned_engines": sorted({r["source"] for r in results[:limit]}), "errors": errors}


RESIDENTIAL_PROXY = "http://127.0.0.1:31313"
MAX_FETCH_BYTES = 2 * 1024 * 1024  # Decoded bytes; Content-Length may be absent/compressed.


def _validate_fetch_url(url, network):
    if network not in ("direct", "residential"):
        raise ValueError("network must be direct or residential")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL must use http or https with a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL credentials are not allowed")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if network == "residential":
        host = parsed.hostname.rstrip(".").lower()
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            raise ValueError("Residential mode forbids local/private destinations")
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0].split("%")[0]).is_global for a in addresses):
            raise ValueError("Residential mode forbids local/private destinations")


def fetch_page(url, max_chars=8000, network="direct"):
    r = None
    current_url, status = url, None
    try:
        _validate_fetch_url(url, network)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
        }
        with requests.Session() as session:
            session.trust_env = False
            proxies = {"http": RESIDENTIAL_PROXY, "https": RESIDENTIAL_PROXY} if network == "residential" else {}
            current_url = url
            for hop in range(6):
                status = None
                _validate_fetch_url(current_url, network)
                r = session.get(current_url, headers=headers, timeout=10, allow_redirects=False, proxies=proxies, stream=True)
                current_url = r.url or current_url
                status = r.status_code
                if r.status_code not in (301, 302, 303, 307, 308) or not r.headers.get("Location"):
                    break
                next_url = urllib.parse.urljoin(current_url, r.headers["Location"])
                r.close()
                current_url = next_url
            else:
                raise ValueError("Too many redirects (maximum 5)")
            if not 200 <= status < 300:
                raise ValueError("HTTP " + str(status) + ": page unavailable")
            body = bytearray()
            for chunk in r.iter_content(chunk_size=min(65536, MAX_FETCH_BYTES + 1)):
                body.extend(chunk[:MAX_FETCH_BYTES + 1 - len(body)])
                if len(body) > MAX_FETCH_BYTES:
                    break
            response_truncated = len(body) > MAX_FETCH_BYTES
            body = body[:MAX_FETCH_BYTES]
        soup = BeautifulSoup(bytes(body).decode(r.encoding or "utf-8", errors="replace"), "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "svg", "noscript", "aside"]):
            tag.decompose()
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        text = soup.get_text(separator="\n")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        clean_text = "\n".join(lines)
        truncated = response_truncated or len(clean_text) > max_chars
        return {
            "url": current_url,
            "requested_url": url,
            "network": network,
            "status": r.status_code,
            "title": title,
            "text": clean_text[:max_chars],
            "truncated": truncated,
            "original_length": None if response_truncated else len(clean_text),
            "response_truncated": response_truncated,
            "bytes_read": len(body),
            "max_response_bytes": MAX_FETCH_BYTES,
            "limited": truncated,
            "full_text_available": not truncated,
            "limitation": ("Response size limit reached; original text length unknown; full text not retained"
                           if response_truncated else "Text limited to max_chars; full text not retained" if truncated else None)
        }
    except Exception as e:
        detail = str(e)
        if network == "residential" and isinstance(e, requests.exceptions.RequestException):
            detail = "Residential request failed: home PC/proxy may be offline or destination unreachable; no direct fallback. " + detail
        return {"url": current_url, "requested_url": url, "status": status,
                "network": network, "error": detail}
    finally:
        if r is not None:
            r.close()

DEF_MAP = {
    "900": ("Tele2 / СберМобайл / Т-Мобайл", "РФ (виртуальные)"),
    "901": ("Tele2", "РФ"),
    "902": ("Tele2 / Волгателеком", "РФ"),
    "903": ("Билайн (ПАО ВымпелКом)", "Москва и регионы РФ"),
    "904": ("Tele2 / Мотив", "Регионы РФ"),
    "905": ("Билайн (ПАО ВымпелКом)", "Москва и регионы РФ"),
    "906": ("Билайн (ПАО ВымпелКом)", "Москва и регионы РФ"),
    "908": ("Tele2 / Мотив", "Регионы РФ"),
    "909": ("Билайн (ПАО ВымпелКом)", "Москва и регионы РФ"),
    "910": ("МТС (ПАО Мобильные ТелеСистемы)", "Центральный ФО"),
    "911": ("МТС (ПАО Мобильные ТелеСистемы)", "Северо-Западный ФО"),
    "912": ("МТС (ПАО Мобильные ТелеСистемы)", "Уральский / Приволжский ФО"),
    "913": ("МТС (ПАО Мобильные ТелеСистемы)", "Сибирский ФО"),
    "914": ("МТС (ПАО Мобильные ТелеСистемы)", "Дальневосточный ФО"),
    "915": ("МТС (ПАО Мобильные ТелеСистемы)", "Москва и Центральный ФО"),
    "916": ("МТС (ПАО Мобильные ТелеСистемы)", "г. Москва и Московская область"),
    "917": ("МТС (ПАО Мобильные ТелеСистемы)", "Поволжье / Москва"),
    "918": ("МТС (ПАО Мобильные ТелеСистемы)", "Южный и Северо-Кавказский ФО"),
    "919": ("МТС (ПАО Мобильные ТелеСистемы)", "Центральный / Приволжский ФО"),
    "920": ("МегаФон (ПАО МегаФон)", "Центральный ФО"),
    "921": ("МегаФон (ПАО МегаФон)", "Северо-Западный ФО / СПб"),
    "922": ("МегаФон (ПАО МегаФон)", "Уральский ФО"),
    "923": ("МегаФон (ПАО МегаФон)", "Сибирский ФО"),
    "924": ("МегаФон (ПАО МегаФон)", "Дальневосточный ФО"),
    "925": ("МегаФон (ПАО МегаФон)", "г. Москва и Московская область"),
    "926": ("МегаФон (ПАО МегаФон)", "г. Москва и Московская область"),
    "927": ("МегаФон (ПАО МегаФон)", "Поволжье"),
    "928": ("МегаФон (ПАО МегаФон)", "Северный Кавказ / ЮФО"),
    "929": ("МегаФон (ПАО МегаФон)", "Москва и регионы РФ"),
    "930": ("МегаФон", "Центральный ФО"),
    "931": ("МегаФон", "Северо-Западный ФО"),
    "932": ("МегаФон", "Уральский ФО"),
    "936": ("МегаФон", "г. Москва и Московская область"),
    "950": ("Tele2", "Регионы РФ"),
    "951": ("Tele2", "Регионы РФ"),
    "952": ("Tele2", "Регионы РФ"),
    "953": ("Tele2", "Регионы РФ"),
    "958": ("Ростелеком / МТТ", "РФ (виртуальные / фиксированные)"),
    "960": ("Билайн", "Центральный / Северо-Западный ФО"),
    "961": ("Билайн", "ЮФО / СКФО"),
    "962": ("Билайн", "Москва и регионы РФ"),
    "963": ("Билайн", "Москва и регионы РФ"),
    "964": ("Билайн", "Москва и регионы РФ"),
    "965": ("Билайн", "Москва и регионы РФ"),
    "966": ("Билайн", "Москва и регионы РФ"),
    "967": ("Билайн", "Москва и регионы РФ"),
    "968": ("Билайн", "Москва и регионы РФ"),
    "977": ("Т2 (Tele2) / СберМобайл", "г. Москва и Московская область"),
    "980": ("МТС", "Центральный ФО"),
    "981": ("МТС", "Северо-Западный ФО"),
    "982": ("МТС", "Уральский ФО"),
    "983": ("МТС", "Сибирский ФО"),
    "984": ("МТС", "Дальневосточный ФО"),
    "985": ("МТС", "г. Москва и Московская область"),
    "986": ("МТС / МегаФон", "Поволжье"),
    "987": ("МТС", "Поволжье"),
    "988": ("МТС", "ЮФО / СКФО"),
    "989": ("МТС", "ЮФО / СКФО"),
    "991": ("Ростелеком / Tele2", "РФ"),
    "995": ("Т-Мобайл (Тинькофф Мобайл)", "г. Москва и регионы РФ"),
    "996": ("Yota (ООО Скартел)", "РФ"),
    "999": ("Yota (ООО Скартел)", "г. Москва и регионы РФ")
}

def _component_status(values, errors):
    if errors:
        return "partial" if values else "unavailable"
    return "ok" if values else "not-found"


def _lookup_search(queries, limit):
    hits, errors, seen = [], [], set()
    for query in queries:
        try:
            result = search_web(query, limit=limit)
            errors.extend(result.get("errors", []))
            for row in result.get("results", []):
                if row.get("url") and row["url"] not in seen:
                    seen.add(row["url"])
                    hits.append(row)
        except Exception as exc:
            errors.append(["search", type(exc).__name__ + ": " + str(exc)])
    return hits, errors, {"status": _component_status(hits, errors)}


def lookup_phone(phone_str):
    try:
        raw_digits = re.sub(r"[^\d+]", "", phone_str)
        if raw_digits.startswith("8") and len(raw_digits) == 11:
            raw_digits = "+7" + raw_digits[1:]
        elif raw_digits.startswith("7") and len(raw_digits) == 11:
            raw_digits = "+" + raw_digits
        elif not raw_digits.startswith("+"):
            raw_digits = "+" + raw_digits

        parsed = phonenumbers.parse(raw_digits)
        valid = phonenumbers.is_valid_number(parsed)
        e164 = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
        national = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.NATIONAL)
        intl = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL)
        carr = carrier.name_for_number(parsed, "ru") or carrier.name_for_number(parsed, "en")
        reg = geocoder.description_for_number(parsed, "ru") or geocoder.description_for_number(parsed, "en")
        tz = list(timezone.time_zones_for_number(parsed))

        clean = e164.replace("+", "")
        def_code = clean[1:4] if len(clean) >= 4 and clean.startswith("7") else ""

        custom_carr, custom_reg = DEF_MAP.get(def_code, ("", ""))
        final_carrier = carr if carr else custom_carr
        final_region = reg if (reg and reg != "Россия") else (custom_reg or reg or "Россия")

        search_dorks = [
            '"' + e164 + '"',
            '"' + national + '"',
            '"' + clean + '"'
        ]

        footprint_hits, search_errors, search_check = _lookup_search(search_dorks[:2], limit=4)

        return {
            "valid": valid,
            "e164": e164,
            "national": national,
            "international": intl,
            "carrier": final_carrier,
            "region": final_region,
            "def_code": def_code,
            "timezones": tz,
            "contact_links_unverified": {
                "whatsapp": "https://wa.me/" + clean,
                "viber": "viber://chat?number=%2B" + clean
            },
            "messenger_account_verified": False,
            "carrier_note": "Carrier/DEF are allocation hints, not current provider (number portability).",
            "web_footprint": footprint_hits,
            "search_errors": search_errors,
            "errors": search_errors,
            "checks": {"search": search_check}
        }
    except Exception as e:
        return {"error": str(e), "checks": {"search": {"status": "not-checked",
                "reason": "Phone metadata/format could not be processed"}}}

def lookup_username(username):
    """Parallel checks; status 200 never alone means a verified identity."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    username = str(username or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{2,50}", username):
        return {"username": username, "error": "Invalid username format"}
    quoted = urllib.parse.quote(username, safe="")
    sites = [
        ("GitHub", "https://github.com/" + quoted, "github"),
        ("Telegram", "https://t.me/" + quoted, "telegram"),
        ("VKontakte", "https://vk.com/" + quoted, "vk"),
        ("Reddit", "https://www.reddit.com/user/" + quoted + "/about.json", "reddit"),
        ("Habr", "https://habr.com/ru/users/" + quoted + "/", "generic"),
        ("Steam", "https://steamcommunity.com/id/" + quoted, "steam"),
        ("GitLab", "https://gitlab.com/" + quoted, "generic"),
        ("Medium", "https://medium.com/@" + quoted, "generic"),
        ("Pinterest", "https://www.pinterest.com/" + quoted + "/", "generic"),
        ("HackerNews", "https://news.ycombinator.com/user?id=" + quoted, "hn"),
        ("DockerHub", "https://hub.docker.com/u/" + quoted, "generic"),
        ("PyPI", "https://pypi.org/user/" + quoted + "/", "generic"),
        ("YouTube", "https://www.youtube.com/@" + quoted, "generic"),
    ]
    def check(item):
        name, url, kind = item
        try:
            r = requests.get(url, timeout=6, headers={"User-Agent": "Mozilla/5.0"}, allow_redirects=True)
            if r.status_code in (403, 429) or r.status_code >= 500:
                return {"platform": name, "url": url, "status": "unknown", "reason": "blocked_or_rate_limited"}
            if r.status_code == 404:
                return {"platform": name, "url": url, "status": "not_found"}
            if r.status_code != 200:
                return {"platform": name, "url": url, "status": "unknown", "http_status": r.status_code}
            known = False
            if kind == "reddit":
                try: known = bool(r.json().get("data", {}).get("name", "").lower() == username.lower())
                except ValueError: pass
            elif kind == "github":
                known = ('property="og:title"' in r.text and ('/@' + username.lower() in r.text.lower() or '"' + username.lower() + '"' in r.text.lower()))
            elif kind == "telegram":
                known = ('tgme_page_title' in r.text and 'tgme_page_extra' in r.text and 'tgme_page_photo' in r.text)
            elif kind == "steam":
                known = 'profile could not be found' not in r.text.lower() and 'Steam Community ::' in r.text
            elif kind == "hn":
                known = 'No such user.' not in r.text and 'user:' in r.text
            elif kind == "vk":
                known = 'Страница удалена' not in r.text and 'Страница заблокирована' not in r.text and '/id' in r.text
            return {"platform": name, "url": url,
                    "status": "profile_page_seen" if known else "candidate_unverified",
                    "http_status": r.status_code}
        except Exception as exc:
            return {"platform": name, "url": url, "status": "unknown", "reason": type(exc).__name__}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(check, item): item[0] for item in sites}
        all_checks = [f.result() for f in as_completed(futures)]
    ranked = {s[0]: i for i, s in enumerate(sites)}
    all_checks.sort(key=lambda item: ranked[item["platform"]])
    positive = [x for x in all_checks if x["status"] in ("profile_page_seen", "candidate_unverified")]
    try: footprint = search_web('"' + username + '"', limit=5)
    except Exception as exc: footprint = {"results": [], "errors": [["search", str(exc)]]}
    return {"username": username, "profiles": positive,
            "verified_identity": False,
            "warning": "HTTP 200/profile existence does not prove account ownership or identity.",
            "checks": all_checks, "search_footprint": footprint.get("results", []),
            "search_errors": footprint.get("errors", [])}

def lookup_email(email):
    holehe_profiles, errors = [], []
    checks = {}
    try:
        proc = subprocess.run(["holehe", email, "--only-used", "--no-color", "--no-clear"], capture_output=True, text=True, timeout=25)
        if proc.returncode != 0:
            raise RuntimeError("Holehe exited with code " + str(proc.returncode))
        negative_seen, limited = False, False
        for line in proc.stdout.splitlines():
            line = line.strip()
            if line.startswith("[+]") and "Email used" not in line:
                holehe_profiles.append(line.replace("[+]", "").strip())
            elif line.startswith("[-]"):
                negative_seen = True
            elif line.lower().startswith("[x]"):
                limited = True
        completed = re.search(r"[1-9][0-9]*\s+websites?\s+checked", proc.stdout, re.I)
        if not (holehe_profiles or negative_seen or completed):
            raise RuntimeError("Holehe output did not confirm any completed checks")
        holehe_errors = ["Some Holehe checks were rate-limited/unavailable"] if limited else []
        checks["holehe"] = {"status": _component_status(holehe_profiles, holehe_errors)}
        if holehe_errors:
            checks["holehe"]["error"] = holehe_errors[0]
            errors.append(["holehe", holehe_errors[0]])
    except Exception as exc:
        detail = type(exc).__name__ + ": " + str(exc)
        checks["holehe"] = {"status": "unavailable", "error": detail}
        errors.append(["holehe", detail])

    domain = email.split("@")[-1] if "@" in email else ""
    mx_records = []
    checks["mx"] = {"status": "not-checked", "reason": "Email domain missing"}
    if domain:
        try:
            answers = dns.resolver.resolve(domain, "MX", lifetime=3)
            mx_records = [str(r.exchange).rstrip(".") for r in answers]
            checks["mx"] = {"status": _component_status(mx_records, [])}
        except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN) as exc:
            checks["mx"] = {"status": "not-found", "reason": type(exc).__name__}
        except Exception as exc:
            detail = type(exc).__name__ + ": " + str(exc)
            checks["mx"] = {"status": "unavailable", "error": detail}
            errors.append(["dns:MX", detail])

    hits, search_errors, checks["search"] = _lookup_search(['"' + email + '"'], limit=5)
    errors.extend(search_errors)
    return {
        "email": email,
        "domain": domain,
        "mx_records": mx_records,
        "registered_services": holehe_profiles,
        "search_footprint": hits,
        "search_errors": search_errors,
        "checks": checks,
        "errors": errors
    }

def lookup_domain(domain):
    w_data, errors, checks = {}, [], {}
    try:
        w = whois.whois(domain)
        w_data = {
            "registrar": w.registrar,
            "creation_date": str(w.creation_date) if w.creation_date else None,
            "expiration_date": str(w.expiration_date) if w.expiration_date else None,
            "name_servers": list(w.name_servers) if w.name_servers else [],
            "org": w.org,
            "country": w.country
        }
        checks["whois"] = {"status": _component_status(any(w_data.values()), [])}
    except Exception as exc:
        detail = type(exc).__name__ + ": " + str(exc)
        w_data = {"error": detail}
        checks["whois"] = {"status": "unavailable", "error": detail}
        errors.append(["whois", detail])

    dns_data, dns_checks, dns_errors = {}, {}, []
    for rtype in ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA"]:
        try:
            answers = dns.resolver.resolve(domain, rtype, lifetime=3)
            rows = [str(rdata) for rdata in answers]
            if rows:
                dns_data[rtype] = rows
            dns_checks[rtype] = {"status": _component_status(rows, [])}
        except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN) as exc:
            dns_checks[rtype] = {"status": "not-found", "reason": type(exc).__name__}
        except Exception as exc:
            detail = type(exc).__name__ + ": " + str(exc)
            dns_checks[rtype] = {"status": "unavailable", "error": detail}
            dns_errors.append(["dns:" + rtype, detail])
    checks["dns"] = {"status": _component_status(dns_data, dns_errors)}
    errors.extend(dns_errors)
    hits, search_errors, checks["search"] = _lookup_search(['site:' + domain + ' OR "' + domain + '"'], limit=5)
    errors.extend(search_errors)
    return {
        "domain": domain,
        "whois": w_data,
        "dns": dns_data,
        "dns_checks": dns_checks,
        "web_footprint": hits,
        "search_errors": search_errors,
        "checks": checks,
        "errors": errors
    }

def lookup_ip(ip):
    geo_data = {}
    try:
        r = requests.get("http://ip-api.com/json/" + ip + "?fields=status,message,country,regionName,city,isp,org,as,query", timeout=5)
        if r.status_code == 200:
            geo_data = r.json()
    except Exception as e:
        geo_data = {"error": str(e)}

    rdns = ""
    try:
        rdns = dns.resolver.resolve_address(ip)[0].to_text()
    except Exception:
        pass

    return {
        "ip": ip,
        "reverse_dns": rdns,
        "geo": geo_data
    }


def query_bot(query):
    try:
        import sys, os
        sys.path.insert(0, "/opt/vibeosint/workspace")
        from osint_bot_query import execute_search
        return execute_search(query)
    except Exception as e:
        return {"status": "error", "error": str(e)}

def query_lazyapi(query):
    try:
        import sys, os
        sys.path.insert(0, "/opt/vibeosint/workspace")
        from lazyapi_bot_query import execute_lazyapi_search
        return execute_lazyapi_search(query)
    except Exception as e:
        return {"status": "error", "error": str(e)}

def query_tg(query):
    try:
        import sys, os, asyncio
        sys.path.insert(0, "/opt/vibeosint/workspace")
        from tg_entity_query import execute_tg_query
        return asyncio.run(execute_tg_query(query))
    except Exception as e:
        return {"status": "error", "error": str(e)}

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    arg = sys.argv[2] if len(sys.argv) > 2 else ""

    if action == "search":
        lim = sys.argv[3] if len(sys.argv) > 3 else 10
        engines = sys.argv[4] if len(sys.argv) > 4 else None
        try:
            result = search_web(arg, lim, engines=engines)
        except (ValueError, TypeError) as exc:
            result = {"error": str(exc), "status": "unavailable", "results": [], "count": 0,
                      "errors": [["validation", str(exc)]]}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif action == "fetch":
        network = sys.argv[3] if len(sys.argv) > 3 else "direct"
        print(json.dumps(fetch_page(arg, network=network), ensure_ascii=False, indent=2))
    elif action == "residential_status":
        print(json.dumps(fetch_page("https://www.cloudflare.com/cdn-cgi/trace", network="residential"), ensure_ascii=False, indent=2))
    elif action == "phone":
        print(json.dumps(lookup_phone(arg), ensure_ascii=False, indent=2))
    elif action == "username":
        print(json.dumps(lookup_username(arg), ensure_ascii=False, indent=2))
    elif action == "email":
        print(json.dumps(lookup_email(arg), ensure_ascii=False, indent=2))
    elif action == "domain":
        print(json.dumps(lookup_domain(arg), ensure_ascii=False, indent=2))
    elif action == "ip":
        print(json.dumps(lookup_ip(arg), ensure_ascii=False, indent=2))
    elif action in ("bot", "bot_query", "eog"):
        print(json.dumps(query_bot(arg), ensure_ascii=False, indent=2))
    elif action == "lazyapi":
        print(json.dumps(query_lazyapi(arg), ensure_ascii=False, indent=2))
    elif action in ("tg", "telegram"):
        print(json.dumps(query_tg(arg), ensure_ascii=False, indent=2))
    else:
        print("Unknown action")
