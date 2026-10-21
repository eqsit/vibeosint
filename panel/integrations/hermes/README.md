# Hermes integration

This directory contains a search-only Serper plugin, an optional web-resilience patch, and regression tests. It is not a Hermes installation or a copy of any operator profile.

## Plugin and configuration

Copy `plugins/web/serper/` into **your project** `$HERMES_HOME/plugins/web/serper/`. Enable `web-serper`, set `web.search_backend=serper` and `web.extract_backend=firecrawl` through your installed Hermes configuration CLI. Supply your own Serper key outside Git. The MCP configuration template is in `../../config/hermes.example.yaml`; replace its absolute placeholders. The MCP wrapper explicitly loads the panel checkout's ignored `.env` because stdio environments are filtered.

## Optional patch

`patches/web-resilience.patch` was generated against upstream Hermes commit [`e6f57427c198cfd96854522b7a9159eb007e13c2`](https://github.com/NousResearch/hermes-agent/commit/e6f57427c198cfd96854522b7a9159eb007e13c2). It changes four web-runtime modules plus two test fixtures to preserve per-URL/partial-result coverage. It does not include credentials, provider accounts, a generated launcher, dependency environments or local provider-picker preferences.

Use a separate checkout and its own dependency environment; do not patch a shared running installation. Before applying, inspect the diff and run:

```bash
git -C "$HERMES_SOURCE" apply --check "$PANEL_ROOT/integrations/hermes/patches/web-resilience.patch"
```

If that fails, stop and adapt the patch for the installed version. A successful apply check alone is not a runtime test. Follow the official Hermes development/test workflow, then exercise ACP and actual web tools in the intended project profile. Restart only that project's old execution gateway after an idle check: a matching commit/protocol does not prove an already-running daemon loaded your local patches.

The `tests/` subtree holds additional regression tests for a compatible Hermes test tree. Set `VIBEOSINT_SERPER_PLUGIN` to the absolute path of the plugin under test. The deployment baseline ran a broader 193-test Hermes web subset; those results are not produced by the panel's 96-Python/60-Node test command. No test credentials or live-account fixtures are supplied.

Hermes Agent is developed by Nous Research and distributed under its upstream license. Preserve upstream license notices when redistributing a modified runtime; see the [upstream repository](https://github.com/NousResearch/hermes-agent).
