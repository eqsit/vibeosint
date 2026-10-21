"""The project Serper provider distinguishes unavailable from an empty search."""
import importlib.util
import os
from pathlib import Path

import httpx
import pytest

PROVIDER_PATH = Path(os.environ.get("VIBEOSINT_SERPER_PLUGIN", str(Path(__file__).resolve().parents[3] / "plugins/web/serper/provider.py")))
spec = importlib.util.spec_from_file_location("vibeosint_project_serper", PROVIDER_PATH)
serper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serper)


@pytest.fixture
def response(monkeypatch):
    monkeypatch.setattr(serper, "provider_env", lambda key: "fixture-secret-api-key")
    def set_response(status, payload):
        r = httpx.Response(status, json=payload, request=httpx.Request("POST", serper.SERPER_ENDPOINT))
        monkeypatch.setattr(serper.httpx, "post", lambda *a, **kw: r)
    return set_response


@pytest.mark.parametrize("payload,status,retryable", [
    ({"error": "fixture-secret-api-key", "statusCode": 503}, 503, True),
    ({"message": "fixture-secret-api-key", "statusCode": 403}, 403, False),
    ({"success": False, "error": "fixture-secret-api-key", "statusCode": 429}, 429, True),
])
def test_http_200_api_error_is_not_a_successful_empty_search(response, payload, status, retryable):
    response(200, payload)
    result = serper.SerperWebSearchProvider().search("fixture query")

    assert result["success"] is False
    assert result["http_status"] == 200
    assert result["provider_status"] == status
    assert result["retryable"] is retryable
    assert str(status) in result["error"]
    assert "fixture-secret-api-key" not in str(result)


@pytest.mark.parametrize("status,retryable", [(400, False), (401, False), (403, False), (429, True), (500, True), (503, True)])
def test_http_error_diagnostics_are_safe_and_actionable(response, status, retryable):
    response(status, {"error": "fixture-secret-api-key"})
    result = serper.SerperWebSearchProvider().search("fixture query")

    assert result["success"] is False
    assert result["http_status"] == status
    assert result["retryable"] is retryable
    assert f"HTTP {status}" in result["error"]
    assert f"retryable={str(retryable).lower()}" in result["error"]
    assert "fixture-secret-api-key" not in str(result)
