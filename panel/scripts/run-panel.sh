#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node --env-file-if-exists="$ROOT/.env" "$ROOT/server/standalone.mjs"
