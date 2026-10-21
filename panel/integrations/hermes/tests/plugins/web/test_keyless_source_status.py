"""A successful extraction transport must not hide an inaccessible source."""
from types import SimpleNamespace

from plugins.web import keyless_mcp
from plugins.web.firecrawl import provider as firecrawl


def test_keyless_source_403_preserves_final_url_and_reports_challenge(monkeypatch):
    requested = "https://example.com/start"
    final = "https://example.com/challenge"
    payload = {"markdown": "Verify you are human", "metadata": {
        "title": "Access denied", "sourceURL": final, "statusCode": 403,
    }}
    client = SimpleNamespace(scrape=lambda **kw: payload)
    monkeypatch.setattr(firecrawl, "_KeylessFirecrawlClient", lambda: client)

    result, = keyless_mcp.firecrawl_extract_keyless([requested])

    assert result["url"] == final
    assert result["metadata"]["sourceURL"] == requested
    assert result["metadata"]["statusCode"] == 403
    assert "403" in result["error"]
    assert "challenge" in result["error"].lower()
    assert not result["content"]
