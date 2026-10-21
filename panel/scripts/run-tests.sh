#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON=${VIBEOSINT_TEST_PYTHON:-"$ROOT/.venv/bin/python"}
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1
export VIBEOSINT_SERPER_PLUGIN="$ROOT/integrations/hermes/plugins/web/serper/provider.py"
"$PYTHON" -m unittest discover -s tests -p 'test_*.py' -q
"$PYTHON" tests/osint_smoke.py
"$PYTHON" tests/hermes_serper_test.py
cd "$ROOT/server"
PANEL_PROMPTS_DIR="$ROOT/prompts" node --test *.test.mjs
