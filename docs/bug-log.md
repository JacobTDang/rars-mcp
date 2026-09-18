# Bug Log

## 2026-09-17: Found while using the MCP on a RISC-V homework set

All five bugs are fixed and each one has a regression test.

### 1. `rars_debug_command` hides the breakpoint actions

- **Symptom:** Clients saw only `step`, `backstep`, `continue`, `pause`, `reset`, and `terminate`. A call with `continue` and an `address` ran to the end of the program: the address was dropped without an error, and no breakpoint was set.
- **Cause:** The input schema was a top-level `oneOf`. Clients that require a plain object schema at the top level, such as Claude Code, flatten the union and keep only the first variant's `action` enum. Zod then removed the unknown `address` key from the `continue` request without an error.
- **Fix:** The schema is now one flat object with all eight actions and an optional `address`. A refinement requires `address` for `breakpoint_add` and `breakpoint_remove`, and rejects it for every other action.
- **Tests:** `tests/server.test.ts`

### 2. `rars_inspect` / `rars_modify` fail with a bare `NullPointerException` for `pc` or an unknown register

- **Symptom:** `registers: ["pc"]`, or a misspelled name, returned `NullPointerException`.
- **Cause:** RARS's `Program.getRegisterValue` searches the integer, floating-point, and CSR register files. When no file has the name, it dereferences null. `pc` is in none of these files.
- **Fix:** `pc` is now read and written through the program counter. The bridge checks every other name first, and an unknown name gives `Unknown register: <name>`.
- **Tests:** `RarsSimulatorSelfTest`, `tests/headless-session.test.ts`

### 3. `rars_inspect` ignores `includeSymbols`

- **Symptom:** `includeSymbols: true` returned no symbols and no error.
- **Cause:** The TypeScript side sent the flag, but the Java bridge never read it. `LiveClient` also removed the flag before it sent the request.
- **Fix:** When `includeSymbols` is set, the bridge returns `symbols: [{ name, address, type: "text" | "data", global }]`, sorted by address. This list includes the local labels of every source file and all `.globl` labels. To keep each file's local symbol table, the simulator now does the two steps of `Program.assemble(files, main)` itself. `LiveClient` now sends the flag.
- **Tests:** `RarsSimulatorSelfTest` (a program with two source files, `tests/fixtures/debug-helper.asm`), `tests/headless-session.test.ts`, `tests/live-client.test.ts`

### 4. `rars_debug_start` reports assembly errors as only `AssemblyException`

- **Symptom:** A source file with a syntax error gave the message `AssemblyException`, with no file, line, or reason.
- **Cause:** RARS's `AssemblyException` has no message. The details are in its `ErrorList`, and the bridge did not read that list.
- **Fix:** The bridge now returns the RARS error report. For example: `Error in …/file.asm line 3 column 3: "addi": Too few or incorrectly formatted operands.`
- **Tests:** `tests/headless-session.test.ts`

### 5. The stdio proxy hides why a request failed

- **Symptom:** When the HTTP server was not running, the client received only `-32603: MCP proxy request failed`. `claude mcp list` showed `Failed to connect` and no reason.
- **Cause:** The proxy wrote the real error to stderr, and the client does not show stderr. The client received a fixed message.
- **Fix:** The JSON-RPC error now includes the endpoint and the cause. For example: `MCP proxy request to http://127.0.0.1:3000/mcp failed: fetch failed (ECONNREFUSED)`. The proxy now receives its input and output streams as parameters, so the tests can run it.
- **Tests:** `tests/stdio-proxy.test.ts`
