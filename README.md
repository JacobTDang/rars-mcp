# RARS MCP

RARS MCP gives Claude Code, Codex, Antigravity and other MCP clients access to the
[RARS](https://github.com/TheThirdOne/rars) RISC-V assembler and simulator: assemble and run
programs, step through them in a real debugger, read registers and memory, list symbols and
assembled instructions, write memory images for hardware simulation, and drive a visible RARS
desktop session.

## Quick start

Requirements: Node.js 22 and a JDK 11 or later.

```sh
npm ci
npm run build
mkdir -p .cache
curl -fsSL https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar -o .cache/rars1_6.jar
scripts/verify-rars.sh
scripts/build-java-bridge.sh
```

Register it with Claude Code. The stdio entry point runs the server in its own process, so
nothing else has to be running:

```sh
claude mcp add --scope user rars -- node /path/to/rars-mcp/dist/src/stdio.js
```

Start your client in the folder holding your `.s` files and the server works there. Examples for
other clients are in `examples/clients/`.

## Which files the server can read

Every path is checked against the workspace folders, after resolving symlinks, and anything
outside them is refused. Folders come from, in order:

- **The client's roots.** A client that advertises the MCP `roots` capability has its roots used
  as workspace folders, so the workspace follows the client's project with no configuration.
- **`RARS_WORKSPACE`.** One or more folders separated by `:` (`;` on Windows). Relative paths
  resolve against the first one.
- **The starting folder.** Without `RARS_WORKSPACE`, the stdio entry point uses the folder the
  client started it in.

## Tools

### Running programs

- **`rars_assemble`** — assemble source files and return structured diagnostics.
- **`rars_run`** — run them. Options: `stdin`, `programArgs`, `registers`, `memoryRanges`,
  `instructionCount`, `maxSteps`, `timeoutMs`. Requested registers and memory come back as
  structured values, not raw RARS text:

  ```json
  { "registers": { "t0": { "hex": "0xfffff000", "signed": -4096 } },
    "memory": [{ "address": "0x10010000", "hex": "0x6c6c6568", "signed": 1819043176 }],
    "instructionCount": 22 }
  ```

Both accept `dump`, which writes a memory image with RARS's own dumper:

```json
"dump": [{ "segment": ".text", "format": "HexText", "file": "mem/imem.hex" }]
```

`segment` is `.text`, `.data`, or a range like `0x400000-0x10000000`; `format` is one of
`SegmentWindow`, `HexText`, `AsciiText`, `HEX`, `Binary`, `BinaryText`. With `rars_assemble` the
image is written without running the program, which is what an instruction-memory image for a
hardware simulation needs. The target folder must already exist.

### Debugging

- **`rars_debug_start`** — start an isolated debugger session on one or more files.
- **`rars_debug_command`** — `step`, `backstep`, `continue`, `pause`, `reset`, `terminate`,
  `breakpoint_add`, `breakpoint_remove`.
  - A breakpoint `address` may be a number, a code label such as `EXIT`, or a source location
    such as `prob1a.s:17`.
  - `continue` takes an optional `maxSteps` (1,000,000 by default).
  - Every step and continue reports why it stopped: `step`, `breakpoint`, `step_limit`, `exited`,
    `ran_off_end`, `exception` or `terminated`. A program that has terminated refuses to run
    until the session is reset.
- **`rars_inspect`** — registers (including `pc`) and bounded memory as `{ hex, signed }`, plus
  `includeSymbols` for the symbol table and `includeInstructions` for the assembled text segment
  with each instruction's address, machine code, basic form, source line and file.
- **`rars_modify`** — write registers or memory.
- **`rars_session_list`**, **`rars_session_close`** — a session with no requests for
  `RARS_SESSION_IDLE_MS` closes itself and then reports `SESSION_EXPIRED`.

### The visible desktop session

- **`rars_live_connect`**, **`rars_live_command`** — drive the RARS application you can see.

## Run in Docker

Requirements: Docker Desktop with Compose.

```sh
mkdir -p workspace
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

Put `.s` files in `workspace/`. HTTP-capable clients connect to `http://127.0.0.1:3000/mcp`.
Stdio-only clients use the proxy, which forwards to that server:

```sh
docker exec -i rars-mcp node dist/src/stdio-proxy.js
```

View logs with `docker compose logs -f`, stop with `docker compose down`, and rebuild after an
update with `docker compose build --no-cache && docker compose up -d`.

## Desktop session

```sh
./scripts/launch-rars-mcp.command
```

The launcher opens RARS and writes protected discovery files into the ignored `.runtime/`
directory. Call `rars_live_connect`, then use its session ID with `rars_live_command`. See
`docs/live-session.md` for the commands and how unsaved buffers are handled.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RARS_WORKSPACE` | the starting folder (stdio) | Folders the server may read, separated by `:` |
| `RARS_JAR` | `.cache/rars1_6.jar` | The RARS JAR |
| `RARS_BRIDGE_JAR` | `java/bridge/build/rars-mcp-bridge.jar` | The Java bridge used by debugger sessions |
| `RARS_BRIDGE_HOST` | `127.0.0.1` | Host of the visible desktop session |
| `RARS_LIVE_DISCOVERY_DIR` | `.runtime` | Where the launcher writes its port and token |
| `RARS_EXECUTION_TIMEOUT_MS` | `10000` | Wall-clock limit for one run |
| `RARS_MAX_OUTPUT_BYTES` | `1048576` | Output captured per run |
| `RARS_MAX_INSPECTION_BYTES` | `65536` | Limit on one inspection |
| `RARS_SESSION_IDLE_MS` | `1800000` | Idle time before a debugger session closes |
| `JAVA_EXECUTABLE` | `java` | Java binary to run |
| `PORT` | `3000` | HTTP entry point port |
| `RARS_MCP_URL` | `http://127.0.0.1:3000/mcp` | Server the stdio proxy forwards to |

Paths default to this checkout and are resolved from the package, not the current directory, so
the server works no matter where it is started. The Docker image sets them explicitly.

## Development

```sh
npm run lint                                   # tsc --noEmit
RARS_JAR="$PWD/.cache/rars1_6.jar" npm run test:run   # vitest once; RARS-backed tests need the JAR
scripts/test-java-bridge.sh                    # Java bridge self-tests
npm run build
```

`npm run start:stdio` runs the stdio entry point, `npm run start:http` the HTTP server, and
`npm run start:proxy` the proxy used inside Docker.

See `docs/security.md` before changing network bindings or workspace folders,
`docs/troubleshooting.md` for recovery steps, and `docs/bug-log.md` for fixed defects and how
they were found.
