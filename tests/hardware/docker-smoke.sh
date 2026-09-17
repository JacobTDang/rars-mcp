#!/bin/sh
set -eu
project=rars-mcp-hardware-smoke
cleanup() { docker compose -p "$project" --profile rtl down --volumes; }
trap cleanup EXIT INT TERM
mkdir -p workspace/sv/rtl workspace/vhdl/rtl workspace/rars .runtime
cp tests/fixtures/hello.asm workspace/hello.asm
cp tests/fixtures/hardware/systemverilog/rtl/adder.sv workspace/sv/rtl/adder.sv
cp tests/fixtures/hardware/smoke-systemverilog.yaml workspace/sv/hardware.project.yaml
cp tests/fixtures/hardware/vhdl/rtl/adder.vhd workspace/vhdl/rtl/adder.vhd
cp tests/fixtures/hardware/smoke-vhdl.yaml workspace/vhdl/hardware.project.yaml
cp tests/fixtures/hardware/rars/program.s workspace/rars/program.s
cp tests/fixtures/hardware/rars/hardware.project.yaml workspace/rars/hardware.project.yaml
docker compose -p "$project" --profile rtl up -d --build
attempt=0
until curl -fsS http://127.0.0.1:3000/health >/dev/null && [ "$(docker inspect -f '{{.State.Health.Status}}' "${project}-hardware-worker-1")" = healthy ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { docker compose -p "$project" --profile rtl logs --no-color; exit 1; }
  sleep 1
done
node tests/hardware/docker-smoke.mjs
