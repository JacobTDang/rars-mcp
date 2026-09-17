# Hardware Harness Gap-Closure Implementation Plan

> Execute this plan on `feat/hardware-harness` with test-first changes. Run the focused test before each implementation, then the full unit/build suite and the relevant Docker smoke before each checkpoint commit. Push every checkpoint.

**Goal:** Finish the hardware-debug harness so an MCP agent can run bounded open-source simulation/formal flows, compare RARS/Spike/RTL retirement traces, locate a failing cycle in a waveform, and minimize reproducible failures.

**Architecture:** Keep the MCP server as the small authenticated control plane and the hardware worker as the execution/data plane. Providers accept only typed, allowlisted options. Every execution uses an immutable source snapshot, bounded subprocess, artifact inventory, and parent/child provenance. Waveform and trace operations remain bounded and return resumable cursors.

**Tools:** TypeScript, Zod, Vitest, Node 22, Docker Compose, RARS, Verilator, GHDL, cocotb, Yosys, SymbiYosys/Boolector, Spike, and riscv-formal.

## Checkpoint 1: Bounded APIs and typed provider options

- Extend provider capabilities with machine-readable option schemas.
- Validate provider-specific options in the manifest resolver; reject unknown keys, unsafe paths, arbitrary commands, and environment injection.
- Add a waveform response-byte ceiling that truncates only at record boundaries and returns a cursor for continuation.
- Add focused schema, provider, waveform, and MCP-handler tests.

## Checkpoint 2: Runnable open-source verification providers

- Make the Spike provider invoke a checked-in normalizer that writes canonical JSONL artifacts and supports bounded ISA/instruction options.
- Pin and install Spike in the hardware image; add a tiny bare-metal RV32 fixture and parser/provider tests.
- Make the riscv-formal provider run `genchecks.py` from a pinned framework checkout, then execute one selected generated check.
- Add real cocotb, Yosys, SBY counterexample, and riscv-formal fixtures to the Docker smoke.
- Verify cancellation and at least one enforced resource limit in the container.

## Checkpoint 3: Native waveform-format coverage

- Generate actual VCD, FST, and GHW files in the hardware container.
- Query hierarchy, values, transitions, and bounded pagination for each format through MCP.
- Assert malformed and oversized requests produce structured errors.

## Checkpoint 4: Reproducible failure minimization

- Add an asynchronous minimization job API and MCP tool.
- Derive candidates from a completed parent job's immutable snapshot, change only the declared assembly source, and rerun the same target under the same limits.
- Preserve a failure by a typed oracle (`job_failure` or a trace-divergence signature), bound attempts, and record the seed, candidate history, and final minimized source as artifacts.
- Add unit tests with deterministic injected runners and an end-to-end worker test.

## Checkpoint 5: Faulty processor end-to-end debugger

- Add a deliberately faulty RV32I RTL fixture with RVFI-like retirement output and waveform generation.
- Run one program through RARS and the RTL fixture, normalize both traces, and assert the first architectural divergence.
- Map the divergent retirement order to its simulation cycle and query the relevant PC/instruction/register signals around that cycle.
- Expose source-line metadata where available and emit a single machine-readable debug report linking trace, cycle, waveform evidence, and artifacts.

## Checkpoint 6: Extensible course-flow template and documentation

- Add a sanitized `examples/cpre381` project manifest and adapter script that demonstrates compile, simulate, trace, and waveform artifact contracts without Iowa State proprietary files.
- Document how to map a course Makefile/tool command into a disabled-by-default repository-command target and how to replace it with a typed provider.
- Add a manifest/contract smoke test. State clearly that exact parity needs a user-supplied sanitized current starter project.
- Update setup, security, provider option, troubleshooting, and MCP-client documentation.

## Checkpoint 7: Full verification, review, and integration

- Run unit tests, TypeScript build/lint, dependency audit, base Docker smoke, and full hardware Docker smoke from a clean build.
- Review the diff for command injection, path escapes, secrets, unbounded output, licenses, and provenance regressions.
- Commit and push the final review fixes.
- Fast-forward or merge the verified feature branch into `main` without disturbing unrelated files, then push `main`.

## Acceptance criteria

- All advertised providers report truthful availability and typed options.
- Spike and RARS both produce canonical retirement trace artifacts.
- A real SBY/riscv-formal counterexample is captured as an artifact.
- VCD, FST, and GHW queries are exercised inside the published image and honor item/byte bounds.
- MCP can launch, inspect, cancel, compare, debug, and minimize jobs without arbitrary shell access.
- The faulty RTL fixture deterministically identifies the expected first mismatch and supporting waveform values.
- The CprE 381 example is reusable but contains no private course material.
- Both smoke suites and all local checks pass before `main` is pushed.
