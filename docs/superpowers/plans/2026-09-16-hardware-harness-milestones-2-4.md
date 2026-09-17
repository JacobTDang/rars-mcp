# Hardware Harness Milestones 2–4 Implementation Plan

**Goal:** Complete bounded waveform analysis, processor differential debugging, and optional verification providers on the persistent hardware-job substrate.

**Architecture:** Derived waveform and trace indexes live beside immutable job artifacts and are accessed through worker HTTP endpoints exposed as MCP tools. New verification flows implement the existing provider contract, so lifecycle, quotas, cancellation, and provenance remain uniform. Heavy toolchains are activated with Compose profiles.

## Checkpoint 0: Harden the execution substrate

- Isolate each workload from worker records and other jobs with a dedicated OS identity and private execution tree.
- Snapshot sources before queueing and revalidate canonical file identity while copying.
- Enforce cancellation immediately before spawn, per-job memory/PID/output/artifact limits, and configured concurrency.
- Validate provider options and path fields; make Verilator simulation execute its generated binary.
- Report hardware availability from the gateway and preserve valid partial artifacts on recovery.
- Add adversarial regression tests and run both Docker smoke suites.

## Checkpoint 1: Waveform intelligence

- Add a versioned waveform-index contract with hierarchy, signal metadata, timescale, bounds, and four-state values.
- Implement VCD parsing directly and FST/GHW ingestion through deterministic conversion tools in the worker image.
- Add bounded `hierarchy`, `signals`, `value_at`, `transitions`, `first_edge`, `first_unknown`, `pulse_widths`, and `compare` operations.
- Persist indexes lazily as derived artifacts, validate source checksums, and return continuation cursors.
- Add signal-role metadata and expose `hardware_wave_query` through worker HTTP and MCP.

## Checkpoint 2: Processor differential debugging

- Add the ISA-neutral architectural retirement-event contract and JSONL trace artifact format.
- Implement RARS instruction-trace normalization and RVFI JSONL/text normalization.
- Add comparison policies for registers, memory, traps, privilege, system calls, and termination.
- Return the first divergence with bounded context and cycle/waveform hints through `hardware_trace_compare`.
- Add a Spike reference provider when installed, reporting it unavailable otherwise.
- Add an intentionally faulty RISC-V fixture that proves the first divergence is correctly localized.

## Checkpoint 3: Verification expansion

- Add cocotb, Yosys, SBY, and riscv-formal provider capabilities and strict option schemas.
- Package synthesis/formal dependencies in opt-in Compose profiles and retain reports/counterexamples as artifacts.
- Add deterministic seeded program generation and delta-debugging minimization for failing assembly cases.
- Add provider contract tests for success, diagnostics, cancellation, quotas, and unavailable tools.
- Generate a third-party tool/version inventory and document profile setup.

## Final verification

- Run unit, integration, build, lint, audit, and Docker smoke suites.
- Run the complete processor fixture from RARS assembly through divergence and bounded waveform evidence.
- Request code review, fix all critical/important findings, then push the final branch.
