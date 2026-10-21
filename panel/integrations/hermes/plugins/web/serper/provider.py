"""Google Search through Serper.dev. Works with Google search operators.

Search-only plugin for Hermes; web_extract uses the configured Firecrawl backend.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from plugins.web._common import BaseWebSearchProvider, provider_env, search_fail, search_ok, setup_schema

log = logging.getLogger(__name__)
SERPER_ENDPOINT = "https://google.serper.dev/search"


class SerperWebSearchProvider(BaseWebSearchProvider):
    NAME = "serper"
    DISPLAY_NAME = "Google via Serper"
    KEY_ENV = "SERPER_API_KEY"

    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        api_key = provider_env(self.KEY_ENV)
        if not api_key:
            return search_fail("SERPER_API_KEY is missing from Hermes .env")
        if not isinstance(query, str) or not query.strip():
            return search_fail("Search query must not be empty")
        count = max(1, min(20, int(limit)))
        try:
            response = httpx.post(
                SERPER_ENDPOINT,
                json={"q": query, "num": count},
                headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                timeout=20,
            )
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            retryable = status in (408, 429) or 500 <= status < 600
            log.warning("Serper request failed: HTTP %d (retryable=%s)", status, retryable)
            return {
                **search_fail(f"Serper search unavailable (HTTP {status}; retryable={str(retryable).lower()})"),
                "http_status": status, "retryable": retryable,
            }
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Serper request failed: %s", type(exc).__name__)
            return search_fail(f"Serper search unavailable ({type(exc).__name__})")
        if not isinstance(data, dict):
            return search_fail("Invalid Serper response")
        try:
            provider_status = int(data.get("statusCode", 0))
        except (TypeError, ValueError):
            provider_status = 0
        if data.get("error") or data.get("errors") or data.get("success") is False or provider_status >= 400:
            retryable = provider_status in (408, 429) or 500 <= provider_status < 600
            # Provider bodies may echo credentials or the query; expose only numeric diagnostics.
            return {
                **search_fail(f"Serper API error (HTTP {response.status_code}; provider_status={provider_status or 'unknown'}; retryable={str(retryable).lower()})"),
                "http_status": response.status_code, "provider_status": provider_status or None,
                "retryable": retryable,
            }
        rows = []
        for item in (data.get("organic") or [])[:count]:
            if not isinstance(item, dict) or not item.get("link"):
                continue
            rows.append({
                "title": str(item.get("title") or ""),
                "url": str(item["link"]),
                "description": str(item.get("snippet") or ""),
                "position": len(rows) + 1,
            })
        return search_ok(rows)

    def get_setup_schema(self) -> dict[str, Any]:
        return setup_schema(
            "Google via Serper", "paid", "Google search through the Serper.dev API",
            "SERPER_API_KEY", "Serper.dev API key", "https://serper.dev/",
        )
