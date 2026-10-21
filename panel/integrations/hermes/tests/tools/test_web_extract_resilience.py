"""End-to-end model-facing contracts for extraction resilience."""
import json
from types import SimpleNamespace

import pytest

from plugins.web import keyless_mcp
from tools import web_tools, web_tools_extract
from tools.registry import registry


@pytest.fixture
def use_provider(monkeypatch):
    def configure(provider):
        monkeypatch.setattr(web_tools, "_get_extract_backend", lambda: provider.name)
        monkeypatch.setattr(web_tools, "_ensure_web_plugins_loaded", lambda: None)
        monkeypatch.setattr("agent.web_search_registry.get_provider", lambda name: provider)
        monkeypatch.setattr("tools.web_result_cache.extract_cache_get", lambda *a, **kw: None)
        monkeypatch.setattr("tools.web_result_cache.extract_cache_put", lambda *a, **kw: None)

        async def allow(url):
            return True
        monkeypatch.setattr(web_tools, "async_is_safe_url", allow)
    return configure


def test_successful_rescue_is_visible_in_serialized_model_output(monkeypatch, use_provider):
    requested = "https://example.com/report"
    provider = SimpleNamespace(name="fixture-keyed", supports_extract=lambda: True)

    async def fail(urls, **kw):
        return [{"url": u, "error": "primary HTTP 503"} for u in urls]
    provider.extract = fail
    use_provider(provider)
    monkeypatch.setattr(web_tools_extract, "_rescue_eligible", lambda p: True)
    monkeypatch.setattr(keyless_mcp, "extract_with_failover", lambda name, urls: [{
        "url": requested, "title": "Report", "content": "Rescued report",
        "metadata": {"sourceURL": requested, "served_by": "parallel", "private_vendor_field": "drop me"},
    }])

    result = json.loads(registry.dispatch("web_extract", {"urls": [requested]}))["results"][0]

    assert result["content"] == "Rescued report"
    assert not result["error"]
    assert result["metadata"]["rescued_from"] == provider.name
    assert result["metadata"]["served_by"] == "parallel"
    assert "503" in result["metadata"]["backend_error"]
    assert "keyless free tier" in result["metadata"]["backend_error"]
    assert "private_vendor_field" not in result["metadata"]


def test_completed_page_survives_a_hanging_peer_without_retry(monkeypatch, use_provider):
    import asyncio
    import time
    requested = ["https://example.com/ready", "https://example.com/hanging"]
    calls = []
    completed = []
    provider = SimpleNamespace(name="fixture-sequential", supports_extract=lambda: True)

    async def extract(urls, **kw):
        results = []
        for url in urls:
            calls.append(url)
            if url == requested[1]:
                await asyncio.Event().wait()
            results.append({"url": url, "content": "completed page"})
            completed.append(url)
        return results
    provider.extract = extract
    use_provider(provider)
    monkeypatch.setattr(web_tools_extract, "_extract_timeout_seconds", lambda: 0.05)
    monkeypatch.setattr(web_tools_extract, "_rescue_eligible", lambda p: False)

    def no_late_rescue(*args):
        raise AssertionError("deadline must not launch another unbounded request")
    monkeypatch.setattr(web_tools_extract, "_rescue_extract", no_late_rescue)

    start = time.monotonic()
    results = json.loads(registry.dispatch("web_extract", {"urls": requested}))["results"]

    assert requested[0] in completed
    assert results[0]["content"] == "completed page"
    assert not results[0]["error"]
    assert "timed out" in results[1]["error"].lower()
    assert [r["url"] for r in results] == requested
    assert calls == requested
    assert time.monotonic() - start < 2


def test_deadline_does_not_start_a_new_rescue(monkeypatch):
    import asyncio
    from unittest.mock import Mock

    async def hang(urls, **kw):
        await asyncio.Event().wait()
    provider = SimpleNamespace(name="fixture-keyed", extract=hang)
    rescue = Mock(return_value=[])
    monkeypatch.setattr(web_tools_extract, "_extract_timeout_seconds", lambda: 0.03)
    monkeypatch.setattr(web_tools_extract, "_rescue_eligible", lambda p: True)
    monkeypatch.setattr(web_tools_extract, "_rescue_extract", rescue)

    results = asyncio.run(web_tools_extract._dispatch_extract(provider, ["https://example.com/hang"], None))

    rescue.assert_not_called()
    assert "timed out" in results[0]["error"].lower()


def test_rescue_uses_only_the_remaining_dispatch_budget(monkeypatch):
    import asyncio
    import threading

    release = threading.Event()
    async def fail(urls, **kw):
        return [{"url": u, "error": "primary HTTP 503"} for u in urls]
    def slow_rescue(name, urls, results):
        release.wait(timeout=3)
        return [{"url": u, "content": "late rescue"} for u in urls]
    provider = SimpleNamespace(name="fixture-keyed", extract=fail)
    monkeypatch.setattr(web_tools_extract, "_extract_timeout_seconds", lambda: 0.05)
    monkeypatch.setattr(web_tools_extract, "_rescue_eligible", lambda p: True)
    monkeypatch.setattr(web_tools_extract, "_rescue_extract", slow_rescue)

    async def scenario():
        start = asyncio.get_running_loop().time()
        try:
            results = await web_tools_extract._dispatch_extract(provider, ["https://example.com/a"], None)
            return results, asyncio.get_running_loop().time() - start
        finally:
            release.set()
    results, elapsed = asyncio.run(scenario())

    assert elapsed < 2
    assert "503" in results[0]["error"]
    assert "rescue timed out" in results[0]["error"].lower()
