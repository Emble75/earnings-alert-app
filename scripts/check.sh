#!/usr/bin/env bash
# Everything CI would run, locally.
set -euo pipefail

cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}

echo "==> backend lint"
(cd backend && "$PY" -m ruff check app tests)

echo "==> backend tests"
(cd backend && "$PY" -m pytest -q)

echo "==> migration is in sync with the models"
(cd backend && "$PY" -m alembic check)

echo "==> frontend typecheck"
(cd frontend && npm run typecheck --silent)

echo "==> frontend lint"
(cd frontend && npm run lint --silent)

echo "==> frontend build"
(cd frontend && npm run build)

echo "all checks passed"
