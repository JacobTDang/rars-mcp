# RARS MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized MCP server for isolated RARS assembly, execution, inspection, and debugging, then add a token-authenticated bridge that gives the same server full control of a visible RARS GUI.

**Architecture:** A TypeScript gateway owns MCP transports, workspace policy, structured results, and session lifecycles. It invokes a checksum-pinned RARS 1.6 JAR for stateless work and a small Java bridge inside a pinned RARS source fork for stateful headless and GUI work. Streamable HTTP is the persistent transport; a stdio proxy connects local clients to that shared service.

**Tech Stack:** Node.js 22, TypeScript 5.9, `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/node` 2.0.0, Zod 4.6.5, Vitest, Java 17, RARS 1.6, Gradle, Docker Compose.

## Global Constraints

- Pin RARS stable CLI to `v1.6` and verify the downloaded `rars1_6.jar` SHA-256 during image builds.
- Restrict every source, input, and dump path to configured canonical workspace roots; reject traversal and symlink escapes.
- Apply wall-clock, instruction, output-size, and inspection-size limits to agent-triggered work.
- Bind the desktop bridge to `127.0.0.1` and require a generated bearer token.
- Never overwrite an unsaved GUI buffer without an explicit conflict policy from the caller.
- Use structured JSON-compatible results plus a concise text block for every tool result.
- Log stdio diagnostics only to stderr.
- Commit and push only after the tests named by a checkpoint pass.

---

## File Map

- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`: Node project, pinned dependencies, strict build, and tests.
- `src/config.ts`: environment configuration and execution limits.
- `src/errors.ts`: stable error codes and result conversion.
- `src/workspace.ts`: canonical workspace path policy.
- `src/rars/cli.ts`: RARS CLI argument creation and child-process execution.
- `src/rars/diagnostics.ts`: assembly and runtime diagnostic parsing.
- `src/sessions/types.ts`: public session and machine-state contracts.
- `src/sessions/store.ts`: isolated/live session lifecycle.
- `src/sessions/headless.ts`: stateful Java bridge client for isolated sessions.
- `src/live/client.ts`: authenticated desktop bridge client and protocol negotiation.
- `src/tools/schemas.ts`: Zod input schemas for all public tools.
- `src/tools/handlers.ts`: tool orchestration and structured output.
- `src/server.ts`: MCP server factory and tool registration.
- `src/http.ts`: health, capability, and Streamable HTTP endpoints.
- `src/stdio-proxy.ts`: stdio-to-HTTP MCP proxy.
- `java/bridge/`: Java protocol DTOs, simulator adapter, and socket server shared by headless and GUI modes.
- `vendor/rars/`: pinned RARS fork as a Git submodule at an exact commit.
- `Dockerfile`, `compose.yaml`, `.dockerignore`: reproducible service packaging.
- `scripts/launch-rars-mcp.command`: macOS desktop launcher and token setup.
- `examples/clients/`: Claude, Codex, and Antigravity configurations.
- `tests/fixtures/`: small RISC-V programs with deterministic expected results.

---

### Task 1: TypeScript foundation and workspace confinement

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/config.ts`, `src/errors.ts`, `src/workspace.ts`
- Test: `tests/workspace.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): AppConfig`, `Workspace.resolve(relativePath): Promise<string>`, `RarsError(code, message, details)`.

- [ ] **Step 1: Create the project manifest and strict TypeScript configuration**

Use ESM, Node 22, scripts `build`, `test`, `test:run`, `lint`, `start:http`, and `start:stdio`; pin the MCP packages to `2.0.0`, Zod to `4.6.5`, TypeScript to `5.9.2`, and Vitest to the security-patched `5.0.1`. Run `npm install` to generate the lockfile.

- [ ] **Step 2: Write failing configuration and path-policy tests**

```ts
it('rejects a path outside the workspace, async () => {
  const workspace = new Workspace(fixtureRoot);
  await expect(workspace.resolve('../secret.asm')).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
  });
});

it('loads bounded defaults', () => {
  expect(loadConfig({ RARS_WORKSPACE: fixtureRoot })).toMatchObject({
    executionTimeoutMs: 10_000,
    maxOutputBytes: 1_048_576,
  });
});
```

- [ ] **Step 3: Verify the tests fail**

Run: `npm test -- tests/workspace.test.ts tests/config.test.ts`

Expected: FAIL because `Workspace` and `loadConfig` do not exist.

- [ ] **Step 4: Implement configuration, stable errors, and canonical containment**

Define `AppConfig` with `workspaceRoot`, `rarsJar`, `executionTimeoutMs`, `maxOutputBytes`, `maxInspectionBytes`, `bridgeHost`, and optional `bridgeToken`. Resolve the root and candidate using `realpath`; for a not-yet-created output, resolve its existing parent. Accept a candidate only when it equals the root or starts with `${root}${sep}`.

- [ ] **Step 5: Run tests and type checking**

Run: `npm test -- tests/workspace.test.ts tests/config.test.ts && npm run build`

Expected: all tests PASS and `tsc` exits 0.

- [ ] **Step 6: Checkpoint 1 commit and push**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src tests
git commit -m "feat: establish gateway foundation"
git push -u origin main
```

---

### Task 2: Stateless RARS CLI execution

**Files:**
- Create: `src/rars/cli.ts`, `src/rars/diagnostics.ts`
- Create: `tests/fixtures/hello.asm`, `tests/fixtures/invalid.asm`
- Test: `tests/rars-cli.test.ts`, `tests/diagnostics.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `Workspace`, `RarsError`.
- Produces: `buildRarsArgs(request: CliRequest): string[]`, `runRars(request, signal?): Promise<CliResult>`, `parseDiagnostics(stderr): Diagnostic[]`.

- [ ] **Step 1: Write failing pure argument and diagnostic tests**

Assert that `buildRarsArgs` converts `{ files:['hello.asm'], mode:'run', programArgs:['one'] }` into RARS options followed by `pa one`, and that an invalid-instruction message produces a diagnostic with severity, file, line, column when present, and message.

- [ ] **Step 2: Verify pure tests fail**

Run: `npm test -- tests/diagnostics.test.ts tests/rars-cli.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement typed argument construction and bounded process capture**

Use `spawn(java, ['-jar', rarsJar, ...args], { cwd: workspaceRoot, stdio: ['pipe','pipe','pipe'] })`. Abort on timeout or caller cancellation, cap stdout and stderr independently, preserve exit code and signal, and return `timedOut` and `truncated` flags. Never invoke a shell.

- [ ] **Step 4: Add integration tests guarded by `RARS_JAR`**

Run `hello.asm`, assert exit code 0 and expected stdout; assemble `invalid.asm`, assert a structured assembly diagnostic; run an infinite loop with a 250 ms timeout and assert `timedOut: true`.

- [ ] **Step 5: Run CLI tests with the pinned JAR**

Run: `RARS_JAR="$PWD/.cache/rars1_6.jar" npm test -- tests/rars-cli.test.ts tests/diagnostics.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Checkpoint 2 commit and push**

```bash
git add src/rars tests
git commit -m "feat: add bounded RARS CLI runner"
git push
```

---

### Task 3: Session contracts and lifecycle

**Files:**
- Create: `src/sessions/types.ts`, `src/sessions/store.ts`
- Test: `tests/session-store.test.ts`

**Interfaces:**
- Produces: `SessionId`, `SessionSummary`, `MachineState`, `SessionBackend`, and `SessionStore` methods `add`, `get`, `list`, `close`, and `closeAll`.

- [ ] **Step 1: Write lifecycle tests**

Test unique opaque IDs, state listing, missing-session `SESSION_NOT_FOUND`, backend close invocation, idempotent `closeAll`, and isolation between two sessions.

- [ ] **Step 2: Verify lifecycle tests fail**

Run: `npm test -- tests/session-store.test.ts`

Expected: FAIL because `SessionStore` does not exist.

- [ ] **Step 3: Implement the contracts and store**

`SessionBackend` must expose `summary()`, `command(DebugCommand)`, `inspect(InspectRequest)`, `modify(ModifyRequest)`, and `close()`. Serialize commands per session with a promise queue so concurrent clients cannot race simulator mutations.

- [ ] **Step 4: Run lifecycle tests**

Run: `npm test -- tests/session-store.test.ts && npm run build`

Expected: PASS with no type errors.

- [ ] **Step 5: Checkpoint 3 commit and push**

```bash
git add src/sessions tests/session-store.test.ts
git commit -m "feat: add simulator session lifecycle"
git push
```

---

### Task 4: Public MCP tools for headless assembly and execution

**Files:**
- Create: `src/tools/schemas.ts`, `src/tools/handlers.ts`, `src/server.ts`
- Test: `tests/tools.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: `Workspace.resolve`, `runRars`, `SessionStore`.
- Produces: `createToolHandlers(deps): ToolHandlers`, `createMcpServer(deps): McpServer` and registered tools `rars_assemble`, `rars_run`, `rars_session_list`, `rars_session_close`.

- [ ] **Step 1: Write failing schema and handler tests**

Cover multi-file assembly, stdin, program arguments, requested registers/memory dumps, invalid paths, timeout reporting, structured diagnostics, concise text content, and session listing/closing.

- [ ] **Step 2: Verify tool tests fail**

Run: `npm test -- tests/tools.test.ts tests/server.test.ts`

Expected: FAIL because schemas and handlers do not exist.

- [ ] **Step 3: Implement Zod schemas and handlers**

Return `{ content:[{type:'text',text:summary}], structuredContent: result, isError }`. Treat assembly failures, traps, and execution limits as readable tool results. Throw `RarsError` only for infrastructure and policy failures.

- [ ] **Step 4: Register tools with explicit descriptions**

Tool descriptions must state that paths are workspace-relative, headless calls are isolated, and live calls mutate a visible application. Derive input JSON Schema from the Zod schemas.

- [ ] **Step 5: Run tool and server tests**

Run: `npm test -- tests/tools.test.ts tests/server.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Checkpoint 4 commit and push**

```bash
git add src/tools src/server.ts tests/tools.test.ts tests/server.test.ts
git commit -m "feat: expose RARS assembly and run tools"
git push
```

---

### Task 5: Streamable HTTP service and stdio proxy

**Files:**
- Create: `src/http.ts`, `src/stdio-proxy.ts`
- Test: `tests/http.test.ts`, `tests/stdio-proxy.test.ts`

**Interfaces:**
- Consumes: `createMcpServer`, `loadConfig`.
- Produces: `GET /health`, `GET /capabilities`, `POST|GET|DELETE /mcp`, and executable `rars-mcp-stdio`.

- [ ] **Step 1: Write failing transport tests**

Use the official MCP client to list and call a tool through an in-process HTTP handler. Spawn the stdio adapter, negotiate MCP, and prove its tool list comes from the HTTP service rather than a second local server.

- [ ] **Step 2: Verify transport tests fail**

Run: `npm test -- tests/http.test.ts tests/stdio-proxy.test.ts`

Expected: FAIL because neither entry point exists.

- [ ] **Step 3: Implement HTTP serving**

Use the SDK 2.0 server factory and Node adapter. Bind `0.0.0.0` in Docker, apply host/origin validation, expose MCP at `/mcp`, and return health JSON containing gateway, RARS artifact, and live-bridge status.

- [ ] **Step 4: Implement the stdio proxy**

Read newline-delimited JSON-RPC from stdin, forward each message to the configured Streamable HTTP endpoint while preserving MCP session headers, and write only protocol responses to stdout. Send diagnostics to stderr and close the HTTP MCP session on exit.

- [ ] **Step 5: Run transport tests**

Run: `npm test -- tests/http.test.ts tests/stdio-proxy.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Checkpoint 5 commit and push**

```bash
git add src/http.ts src/stdio-proxy.ts tests/http.test.ts tests/stdio-proxy.test.ts package.json
git commit -m "feat: add HTTP service and stdio adapter"
git push
```

---

### Task 6: Reproducible Docker distribution and client documentation

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `scripts/verify-rars.sh`
- Create: `examples/clients/claude.json`, `examples/clients/codex.toml`, `examples/clients/antigravity.json`
- Create: `README.md`, `docs/security.md`, `tests/docker-smoke.sh`

**Interfaces:**
- Produces: service `rars-mcp` on `127.0.0.1:3000`, volume `./workspace:/workspace`, and documented stdio command.

- [ ] **Step 1: Record and enforce the RARS artifact checksum**

Download `https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar`, calculate its SHA-256 once, store the literal digest in the Dockerfile and verification script, and fail the build on mismatch.

- [ ] **Step 2: Build a non-root multi-stage image**

Build TypeScript in `node:22-bookworm-slim`; run with Node 22 plus a Java 17 JRE, copy only production dependencies, compiled output, and verified `/opt/rars/rars.jar`; run as an unprivileged user.

- [ ] **Step 3: Add Compose and smoke tests**

Start the service, wait for `/health`, call `rars_assemble` and `rars_run` through an MCP client, verify the expected fixture output, invoke the stdio adapter, and always stop the stack in a shell trap.

- [ ] **Step 4: Add client and operating documentation**

Document prerequisites, `docker compose up -d`, workspace mounting, HTTP and stdio client configurations, available tools, limits, upgrade behavior, logs, shutdown, token handling, and the fact that desktop synchronization arrives in the following checkpoint.

- [ ] **Step 5: Verify the headless milestone**

Run: `npm test && npm run build && docker compose build && bash tests/docker-smoke.sh`

Expected: all unit/integration tests PASS, the image builds, HTTP and stdio smoke calls both succeed, and Compose stops cleanly.

- [ ] **Step 6: Checkpoint 6 commit and push**

```bash
git add Dockerfile compose.yaml .dockerignore scripts examples README.md docs/security.md tests/docker-smoke.sh
git commit -m "feat: ship Dockerized headless RARS MCP"
git push
```

---

### Task 7: Versioned Java bridge protocol

**Files:**
- Create: `settings.gradle`, `build.gradle`
- Create: `java/bridge/src/main/java/dev/rarsmcp/protocol/*.java`
- Create: `java/bridge/src/test/java/dev/rarsmcp/protocol/ProtocolTest.java`
- Add: `vendor/rars/` Git submodule pinned to an exact fork commit derived from upstream `b0c5cd12eb22c475c11af07acaa64e39a2f8536e`

**Interfaces:**
- Produces: newline-delimited request/response envelopes with `protocolVersion: 1`, request ID, command, payload, success result, or stable error.

- [ ] **Step 1: Write failing protocol serialization tests**

Test `hello`, `load`, `assemble`, `command`, `inspect`, `modify`, and `close` envelopes; reject unknown versions, commands, missing IDs, and payloads over 1 MiB.

- [ ] **Step 2: Verify Java tests fail**

Run: `./gradlew :java:bridge:test`

Expected: compilation FAIL because protocol classes do not exist.

- [ ] **Step 3: Implement immutable protocol records and JSON codec**

Use Jackson with unknown-property rejection. Define stable codes matching TypeScript errors and require the bearer token during `hello` before accepting any simulator command.

- [ ] **Step 4: Run protocol tests**

Run: `./gradlew :java:bridge:test`

Expected: PASS.

- [ ] **Step 5: Checkpoint 7 commit and push**

```bash
git add .gitmodules vendor/rars settings.gradle build.gradle java/bridge
git commit -m "feat: define authenticated RARS bridge protocol"
git push
```

---

### Task 8: Headless stateful simulator adapter

**Files:**
- Create: `java/bridge/src/main/java/dev/rarsmcp/sim/RarsSimulator.java`
- Create: `java/bridge/src/main/java/dev/rarsmcp/server/BridgeServer.java`
- Test: `java/bridge/src/test/java/dev/rarsmcp/sim/RarsSimulatorTest.java`
- Create: `src/sessions/headless.ts`
- Test: `tests/headless-session.test.ts`

**Interfaces:**
- Consumes: bridge protocol and pinned RARS fork internals.
- Produces: `HeadlessSession.create(config, program): Promise<SessionBackend>` supporting load, assemble, step, backstep, continue, pause, reset, breakpoints, inspect, modify, and close.

- [ ] **Step 1: Write failing Java simulator tests**

Load a fixture, assemble, step one instruction, assert the program counter changes, write/read an integer register and memory word, stop at a breakpoint, reset, and backstep when history is enabled.

- [ ] **Step 2: Implement the simulator adapter on a single command thread**

Wrap RARS program, memory, register, breakpoint, and backstep APIs behind `RarsSimulator`. Marshal every mutation onto one executor and return complete state snapshots after mutations.

- [ ] **Step 3: Write failing TypeScript backend tests**

Spawn `BridgeServer` on a random loopback port, authenticate, exercise every `SessionBackend` method, assert timeout/cancellation behavior, and confirm the child process is gone after `close()`.

- [ ] **Step 4: Implement `HeadlessSession`**

Spawn Java without a shell, read the selected port from stderr startup metadata, connect on loopback, perform `hello`, enforce request timeouts, correlate IDs, and reject all pending calls if the bridge exits.

- [ ] **Step 5: Run cross-language tests**

Run: `./gradlew :java:bridge:test && npm test -- tests/headless-session.test.ts`

Expected: PASS.

- [ ] **Step 6: Checkpoint 8 commit and push**

```bash
git add java/bridge src/sessions/headless.ts tests/headless-session.test.ts
git commit -m "feat: add stateful headless debugging"
git push
```

---

### Task 9: MCP debugging, inspection, and mutation tools

**Files:**
- Modify: `src/tools/schemas.ts`, `src/tools/handlers.ts`, `src/server.ts`
- Test: `tests/debug-tools.test.ts`

**Interfaces:**
- Produces: `rars_debug_start`, `rars_debug_command`, `rars_inspect`, and `rars_modify`.

- [ ] **Step 1: Write failing end-to-end tool tests**

Through an MCP client, start a session, step, set a breakpoint, continue, inspect integer/FPU/CSR registers and bounded memory, modify a writable register and memory, reset, backstep, and close. Assert unsupported writes return `UNSUPPORTED_OPERATION` without corrupting the session.

- [ ] **Step 2: Verify debugging tool tests fail**

Run: `npm test -- tests/debug-tools.test.ts`

Expected: tools are absent.

- [ ] **Step 3: Extend schemas, handlers, and registrations**

Use discriminated unions for commands and inspection targets. Require a session ID for stateful operations. Enforce `maxInspectionBytes` before forwarding requests.

- [ ] **Step 4: Run debugging and regression tests**

Run: `npm test && npm run build`

Expected: all tests PASS.

- [ ] **Step 5: Checkpoint 9 commit and push**

```bash
git add src/tools src/server.ts tests/debug-tools.test.ts
git commit -m "feat: expose stateful RARS debugger tools"
git push
```

---

### Task 10: MCP-enabled desktop RARS bridge

**Files:**
- Create: `java/bridge/src/main/java/dev/rarsmcp/gui/GuiSimulatorAdapter.java`
- Modify in fork: RARS startup integration and GUI action hooks needed to install the adapter
- Test: `java/bridge/src/test/java/dev/rarsmcp/gui/GuiSimulatorAdapterTest.java`
- Create: `scripts/launch-rars-mcp.command`

**Interfaces:**
- Produces: a normal RARS GUI with a loopback bridge, atomic token file, selected port file, and simulator mutations marshalled onto Swing's event dispatch thread.

- [ ] **Step 1: Write failing GUI adapter tests**

Under a virtual display, open an editor buffer, mark it dirty, verify `load` with `reject` returns `UNSAVED_CHANGES`, verify `discard` reloads it, and exercise assembly, stepping, register/memory mutation, and breakpoints while checking the corresponding GUI models refresh.

- [ ] **Step 2: Implement GUI lifecycle integration**

Install `GuiSimulatorAdapter` after RARS constructs its main window. Run GUI operations through `SwingUtilities.invokeAndWait`, publish state only after model refresh, and leave the GUI open when the MCP client disconnects.

- [ ] **Step 3: Implement secure desktop launcher**

Generate a 32-byte token with `openssl rand -hex 32`, write token and port files with mode `0600` under `${XDG_RUNTIME_DIR:-$TMPDIR}/rars-mcp-$UID`, build or use the pinned GUI JAR, and launch Java with bridge system properties. Never print the token.

- [ ] **Step 4: Run bridge and GUI tests**

Run: `./gradlew :java:bridge:test`

Expected: PASS, including dirty-buffer conflict cases.

- [ ] **Step 5: Checkpoint 10 commit and push**

```bash
git add java/bridge scripts/launch-rars-mcp.command vendor/rars
git commit -m "feat: embed live control bridge in RARS GUI"
git push
```

---

### Task 11: Gateway live-session client and tools

**Files:**
- Create: `src/live/client.ts`, `src/live/discovery.ts`
- Modify: `src/config.ts`, `src/tools/schemas.ts`, `src/tools/handlers.ts`, `src/server.ts`, `src/http.ts`
- Test: `tests/live-client.test.ts`, `tests/live-tools.test.ts`

**Interfaces:**
- Produces: `LiveClient.connect(endpoint, token): Promise<SessionBackend>`, `rars_live_connect`, and `rars_live_command`.

- [ ] **Step 1: Write failing live-client security tests**

Test valid connection, missing/wrong token, protocol mismatch, stale endpoint, request timeout, lost connection, two discovered sessions requiring explicit selection, and non-disclosure of tokens in logs and errors.

- [ ] **Step 2: Implement discovery and client protocol**

Read an explicitly mounted discovery directory or accept host/port/token through configuration. Require exact protocol version 1, correlate request IDs, serialize mutations, and convert bridge failures to stable `RarsError` values.

- [ ] **Step 3: Write failing MCP live-tool tests**

Connect a fake desktop bridge, load a workspace source with both conflict policies, run and pause it, step, inspect, modify, manage breakpoints, list the live session, and disconnect without closing the fake GUI.

- [ ] **Step 4: Register live tools and capability reporting**

Expose bridge reachability and protocol version from `/capabilities`. Make `rars_live_command` a discriminated union and explicitly document that it mutates the visible desktop session.

- [ ] **Step 5: Run live and regression tests**

Run: `npm test && npm run build && ./gradlew :java:bridge:test`

Expected: all tests PASS.

- [ ] **Step 6: Checkpoint 11 commit and push**

```bash
git add src/live src/config.ts src/tools src/server.ts src/http.ts tests/live-client.test.ts tests/live-tools.test.ts
git commit -m "feat: connect MCP tools to live RARS sessions"
git push
```

---

### Task 12: Distribution, compatibility examples, and final verification

**Files:**
- Modify: `Dockerfile`, `compose.yaml`, `README.md`, `docs/security.md`, `tests/docker-smoke.sh`
- Create: `docs/live-session.md`, `docs/troubleshooting.md`, `tests/live-smoke.sh`
- Modify: `examples/clients/claude.json`, `examples/clients/codex.toml`, `examples/clients/antigravity.json`

**Interfaces:**
- Produces: documented end-to-end headless and live workflows on macOS Docker Desktop.

- [ ] **Step 1: Wire host bridge access into Compose**

Add `host.docker.internal:host-gateway` compatibility, mount the discovery directory read-only, keep the source workspace writable, and document token-file permissions and trusted-client assumptions.

- [ ] **Step 2: Add full live smoke test**

Launch the bridge test harness, start Compose, connect with `rars_live_connect`, load a fixture, step it, write/read a register and memory, set/hit a breakpoint, disconnect, and assert the bridge remains alive.

- [ ] **Step 3: Complete user documentation and client examples**

Include installation with no prior RARS, headless startup, desktop launcher, HTTP and stdio setup for all three named clients, tool examples, unsaved-file conflict behavior, limits, updating pinned artifacts, recovery from stale sessions, and uninstall steps.

- [ ] **Step 4: Run the complete release gate**

Run: `npm ci && npm test && npm run build && ./gradlew clean test && docker compose build --no-cache && bash tests/docker-smoke.sh && bash tests/live-smoke.sh`

Expected: every test and smoke flow PASS from a clean dependency install and image build.

- [ ] **Step 5: Inspect repository state and dependency artifacts**

Run: `git status --short && git diff --check && docker compose config`

Expected: only intended documentation-plan files may remain untracked, no whitespace errors, and valid Compose output.

- [ ] **Step 6: Checkpoint 12 commit and push**

```bash
git add Dockerfile compose.yaml README.md docs/live-session.md docs/troubleshooting.md docs/security.md tests examples
git commit -m "docs: complete RARS MCP distribution"
git push
```

## Implementation Order and Checkpoint Policy

Tasks 1-6 produce the complete headless milestone. Tasks 7-12 add stateful debugging and live GUI synchronization. Execute tasks in order because later interfaces depend on earlier ones. At every checkpoint, run the stated verification, inspect the staged diff, commit only the files listed for that task, and push `main` to `origin`. Stop on a rejected push or failing verification; diagnose it before continuing.
