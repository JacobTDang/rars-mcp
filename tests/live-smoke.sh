#!/bin/sh
set -eu
fixture_pid=""
cleanup() {
  docker compose down >/dev/null 2>&1 || true
  [ -z "$fixture_pid" ] || kill "$fixture_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
mkdir -p .runtime workspace
node tests/live-bridge-fixture.mjs "$PWD/.runtime" &
fixture_pid=$!
attempt=0
until [ -s .runtime/port ]; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 0.1
done
docker compose up -d --build
attempt=0
until curl -fsS http://127.0.0.1:3000/health >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || { docker compose logs; exit 1; }; sleep 1
done
node tests/live-smoke.mjs
