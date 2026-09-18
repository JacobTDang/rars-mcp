# RARS MCP Server Design

## Goal

Build a local Model Context Protocol (MCP) server that gives agents such as Claude, Codex, and Antigravity broad access to RARS. The system must support deterministic headless assembly and simulation in Docker and full read/write control of an optional visible RARS desktop session.

The user does not need an existing RARS installation. The project pins and obtains a compatible RARS build as part of setup.

## Delivery Scope

Development is split into two milestones that share one MCP interface:

1. A complete headless server, Docker packaging, HTTP transport, stdio adapter, and client configuration examples.
2. An MCP-enabled RARS desktop build and live-session control bridge.

The first milestone remains useful without the desktop bridge. Live-session tools clearly report that no desktop session is connected when the second component is unavailable.

## Architecture

### MCP gateway

A TypeScript service implements the MCP server. It exposes Streamable HTTP from a persistent Docker container, owns session metadata, validates all file access, applies execution limits, and converts RARS output into structured MCP results.

The gateway starts pinned RARS Java processes for isolated headless sessions. Each session has independent execution state and cannot affect other sessions.

### Headless RARS runtime

The container image obtains a pinned RARS release during its build and verifies its checksum. The image includes the Java runtime needed to execute RARS. Assembly source, input, and dump files remain in a host-mounted workspace rather than the container image.

### Desktop bridge

The project maintains a small RARS fork containing an embedded control bridge. This build retains the normal RARS GUI and simulator behavior while exposing supported internal simulator operations through a versioned local protocol.

The desktop bridge binds only to `127.0.0.1` and requires a generated authentication token. The Docker gateway reaches the host through `host.docker.internal`. The protocol includes compatibility negotiation so a mismatched gateway and desktop build fail clearly.

The bridge provides full read/write control: load programs; assemble; run; pause; step; backstep when RARS history permits it; reset; set and remove breakpoints; inspect execution state; read and write registers, CSRs, floating-point registers, and memory; and inspect symbols and source locations.

### stdio adapter

A lightweight host command proxies MCP stdio to the persistent gateway. This lets stdio-only clients use the same service and live RARS session as HTTP-capable clients. It does not create a second simulator service.

## MCP Tool Interface

The gateway exposes these initial tools:

- `rars_assemble`: Assemble one or more workspace files. Return diagnostics, symbols, and optional machine-code output.
- `rars_run`: Execute a program headlessly. Accept program arguments, stdin, instruction and wall-clock limits, requested register values, memory ranges, and dump formats.
- `rars_debug_start`: Create an isolated debugger session.
- `rars_debug_command`: Step, backstep, continue, pause, reset, or terminate, and manage breakpoints.
- `rars_inspect`: Read integer and floating-point registers, CSRs, memory, symbols, source positions, output, and session state.
- `rars_modify`: Write supported registers or memory and change supported simulator settings.
- `rars_live_connect`: Discover and authenticate with an MCP-enabled desktop RARS session.
- `rars_live_command`: Load a program or apply execution, breakpoint, inspection, and mutation operations to the visible desktop session.
- `rars_session_list`: List isolated and connected live sessions and their states.
- `rars_session_close`: Terminate an isolated session or disconnect from a live session without closing the user's GUI unless explicitly requested.

Inputs and outputs use stable JSON schemas. Results also contain short text summaries for clients that do not render structured content well. Tool capability metadata distinguishes features available in headless and live modes.

## Data Flow

For a headless call, the client invokes the gateway over HTTP or through the stdio adapter. The gateway resolves requested paths inside configured workspace roots, validates options, starts or communicates with the relevant Java process, parses RARS output, and returns structured results.

For a live call, the gateway validates the MCP request and forwards a versioned command to the authenticated desktop bridge. The bridge schedules simulator and GUI mutations on the correct RARS thread, captures the resulting state, and returns it to the gateway. The gateway translates that response into the same public schemas used by headless tools where practical.

Source synchronization is file-based. Both the container and the GUI use the same host files. Loading or reassembling a changed file is an explicit tool operation so an agent cannot unexpectedly replace unsaved GUI edits. The bridge reports dirty editor state before a conflicting load and requires the caller to explicitly choose whether to reject the load or discard the unsaved buffer.

## Safety and Isolation

- File operations are restricted to configured workspace roots after canonical path resolution. Traversal and symlink escapes are rejected.
- Headless executions have configurable instruction, wall-clock, output-size, and memory-inspection limits.
- The desktop bridge is localhost-only and token-authenticated.
- Full mutation capability is enabled for authenticated clients, as required.
- Live commands use session identifiers and protocol versions to prevent accidental control of an incompatible or stale RARS process.
- Closing or resetting a live GUI is always an explicit operation. Disconnecting the MCP gateway does not close RARS.
- Secrets and authentication tokens are stored outside source control and are not written to normal logs.

## Error Handling

Assembly errors, runtime traps, limit exhaustion, and invalid RISC-V operations are normal structured tool results. They include source locations, relevant simulator state, and captured output when available.

Infrastructure failures use MCP errors with stable codes. These include invalid paths, unavailable Java or RARS artifacts, process crashes, expired sessions, unavailable desktop bridges, authentication failures, protocol mismatches, timeouts, and lost connections. A failed command must not silently create a replacement live session or redirect work to another RARS window.

## Packaging and Setup

The repository provides:

- A Dockerfile and Compose configuration for the persistent gateway.
- A pinned and checksum-verified RARS artifact or reproducible patched build.
- A macOS desktop launcher for the MCP-enabled RARS GUI and its token configuration.
- A stdio proxy command.
- Ready-to-copy MCP client configuration examples for Claude, Codex, and Antigravity.
- A default host-mounted `workspace/` directory.
- Health and capability endpoints for the runtime and optional desktop bridge.
- Setup, upgrade, troubleshooting, and security documentation.

The normal headless startup is `docker compose up -d`. Desktop synchronization is optional and begins when the user launches the bundled MCP-enabled RARS application.

## Testing

Unit tests cover path containment, argument conversion, diagnostic parsing, schema validation, limits, session transitions, authentication, and bridge protocol messages.

Integration fixtures exercise assembly, execution, stdin and stdout, program arguments, warnings and errors, runtime traps, integer and floating-point registers, CSRs, memory, symbols, breakpoints, stepping, backstepping, reset behavior, and execution limits.

Bridge tests exercise simulator control without requiring a visible window where RARS internals permit it. Docker smoke tests start from a clean build, invoke MCP through HTTP and stdio, and confirm that both transports reach the same gateway. A manual GUI checklist verifies loading, assembly, stepping, register and memory mutation, breakpoint handling, and visible state synchronization.

## Success Criteria

- A user without RARS installed can start the headless service with Docker Compose.
- Claude, Codex, and Antigravity have documented connection paths through Streamable HTTP or stdio.
- Agents can assemble, run, debug, inspect, and modify RISC-V programs within mounted workspace roots.
- Multiple isolated headless sessions work without state leakage.
- An authenticated agent can connect to the bundled desktop RARS build and drive its visible simulator state with full read/write control.
- Failures are bounded, structured, and do not leave orphaned sessions or silently overwrite unsaved GUI work.
