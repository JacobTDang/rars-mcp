# RARS MCP

RARS MCP gives Claude, Codex, Antigravity, and other MCP clients access to the RARS RISC-V assembler and simulator. RARS is downloaded and checksum-verified while the image builds; no host installation is required.

## Start

Requirements: Docker Desktop with Compose.

```sh
mkdir -p workspace
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

Place `.asm` files in `workspace/`. Connect HTTP-capable clients to `http://127.0.0.1:3000/mcp`. For stdio-only clients, use:

```sh
docker exec -i rars-mcp node dist/src/stdio-proxy.js
```

Ready-to-copy examples are in `examples/clients/`.

## Tools

- `rars_assemble`: assemble workspace source files and return diagnostics.
- `rars_run`: execute workspace source files with stdin, program arguments, register output, memory ranges, step limits, and wall-clock limits.
- `rars_session_list`: list stateful headless and live sessions.
- `rars_session_close`: close or disconnect a session.

- `rars_debug_start`, `rars_debug_command`, `rars_inspect`, `rars_modify`: control isolated stateful debuggers.
- `rars_live_connect`, `rars_live_command`: connect to and drive the visible desktop RARS session.

## Stateful and desktop debugging

The Docker image includes the Java bridge used by isolated debugger sessions. To synchronize a visible RARS application, run:

```sh
./scripts/launch-rars-mcp.command
```

The launcher opens RARS and creates protected discovery files in the ignored `.runtime/` directory. Call `rars_live_connect`, then use its session ID with `rars_live_command`. See `docs/live-session.md` for commands and unsaved-buffer behavior.

## Operations

View logs with `docker compose logs -f`. Stop with `docker compose down`. Change bounded execution defaults in `compose.yaml`. Rebuild after an update with `docker compose build --no-cache && docker compose up -d`.

See `docs/security.md` before changing network bindings or workspace mounts, and `docs/troubleshooting.md` for recovery steps.
