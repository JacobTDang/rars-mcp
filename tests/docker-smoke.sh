#!/bin/sh
set -eu
cleanup() { docker compose down; }
trap cleanup EXIT INT TERM
mkdir -p workspace
cp tests/fixtures/hello.asm workspace/hello.asm
docker compose up -d --build
attempt=0
until curl -fsS http://127.0.0.1:3000/health >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { docker compose logs; exit 1; }
  sleep 1
done
node tests/docker-smoke.mjs
