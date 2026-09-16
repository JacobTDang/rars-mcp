# Hardware Tool Harness Design

## Goal

Extend RARS MCP into a local, provider-neutral hardware development harness. Claude, Codex, Antigravity, and other MCP clients must be able to compile, simulate, test, inspect, and debug VHDL and Verilog/SystemVerilog projects without coupling the public interface to one HDL, ISA, simulator, or course tool flow.

The existing RARS tools and live desktop bridge remain available. Hardware jobs run independently so a long compilation, simulation, or proof cannot block a RARS session.

## Scope

### Included

- VHDL and Verilog/SystemVerilog project manifests.
- Verilator and GHDL providers.
- Explicitly enabled repository-owned course commands.
- Persistent asynchronous job records and immutable job results.
- Isolated, resource-bounded hardware execution.
- Structured diagnostics, logs, and artifact metadata.
- VCD, FST, and GHW waveform artifacts and bounded queries.
- An ISA-neutral processor retirement-event schema based on RVFI concepts.
- RARS-to-RTL and reference-model trace comparison for RISC-V projects.
- Optional later providers for cocotb, Yosys, SBY, Spike, Sail, and riscv-formal.

### Excluded from the first release

- Source-file editing through MCP. Agents use their existing filesystem tools.
- Live control or synchronization of Surfer or GTKWave.
- FPGA programming, JTAG, logic-analyzer capture, or physical-board debugging.
- Transparent resumption of a running process after a gateway or worker restart.
- Arbitrary shell-string evaluation.
- A guaranteed reimplementation of private or unavailable CprE 381 grading infrastructure.

## Design Principles

1. The MCP contract describes hardware-development operations, not executable command lines.
2. HDL, ISA, simulator, and course flow are independent choices.
3. Every execution uses a declared provider and immutable source snapshot.
4. Repository code and testbenches are untrusted executable workloads.
5. Original tool output is retained, while normalized diagnostics and results provide portability.
6. Large artifacts stay outside model context and are accessed through bounded queries.
7. Every completed result contains enough provenance to reproduce the run.
8. Optional heavyweight capabilities do not increase the default RARS image or startup cost.

## Architecture

```text
Claude / Codex / Antigravity
             |
         MCP gateway
             |
    +--------+----------+
    |                   |
RARS runtime      Persistent job store
                         |
                  Hardware worker
                         |
       +-----------------+------------------+
       |                 |                  |
   Providers         Artifacts       Trace/wave indexes
       |
 Verilator, GHDL, repository commands,
 cocotb, Yosys/SBY, Spike/Sail
```

### MCP gateway

The existing TypeScript service remains the only public MCP endpoint. It:

- Validates MCP inputs and project manifests.
- Restricts source and artifact access to configured workspace roots.
- Resolves source files and creates immutable source snapshots.
- Creates and queries persistent jobs.
- Dispatches jobs to the hardware worker.
- Returns bounded logs, structured results, and artifact handles.
- Continues to own all existing RARS session behavior.

The gateway never runs HDL toolchains or repository commands directly.

### Persistent job store

The job store records requests, state transitions, timestamps, ownership, results, and artifact references atomically. Job metadata survives gateway and worker restarts.

Jobs have these states:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> aborted
```

- `cancelled` means an explicit cancellation or configured limit stopped a live job and the result identifies the reason.
- `aborted` means recovery found a nonterminal job whose original process no longer exists.
- Terminal jobs are immutable.
- Rerunning a job creates a new job with `parentJobId`; it never changes the original.

After restart, the gateway changes orphaned `queued` and `running` records to `aborted`. It retains partial logs and valid artifacts. It does not attempt process resumption.

### Hardware worker

The worker claims queued jobs and executes one provider action in a fresh isolated directory. Source, build, and artifact directories are separate:

- Source snapshot: immutable and mounted read-only.
- Build directory: private and writable for the current job.
- Artifact directory: private while running and immutable after finalization.

The default configuration permits one active hardware job. A positive configuration value can increase concurrency, but every job retains independent resource limits.

### Providers

A provider translates a validated target into tool invocations and normalizes the result. Each provider reports:

- Stable provider identifier and version.
- Installed tool versions.
- Supported actions, languages, HDL standards, and artifact formats.
- Provider-specific option schema.
- Whether network access or other elevated capabilities are required.

The first release contains:

- `verilator`: Verilog/SystemVerilog lint, compile, simulate, and VCD/FST generation.
- `ghdl`: VHDL analyze, elaborate, simulate, and VCD/FST/GHW generation.
- `repository-command`: an explicitly enabled argument-array command located within the immutable source snapshot.

Later providers add cocotb regression, Yosys synthesis, SBY formal verification, Spike/Sail references, and riscv-formal checks without changing the common job lifecycle.

### Artifact and analysis subsystem

Artifacts include logs, diagnostics, waveforms, retirement traces, coverage, reports, binaries, memory images, and counterexamples. Each artifact has:

- ID and job ID.
- Stable type.
- Relative storage path.
- Media type.
- Byte size.
- SHA-256 checksum.
- Creation time.
- Retention state.

Waveform and retirement-trace indexes are derived artifacts. They are created lazily on the first query and are subject to the same quotas and integrity checks.

## Project Manifest

Projects use `hardware.project.yaml` with this initial schema:

```yaml
version: 1
name: cpu-project

sources:
  - rtl/**/*.vhd
  - test/**/*.vhd

targets:
  unit:
    provider: ghdl
    language: vhdl
    standard: "08"
    top: tb_alu
    action: simulate
    parameters: {}
    defines: []
    include_dirs: []
    options: {}
    artifacts:
      waveform: ghw
    limits:
      wall_time_seconds: 30
      memory_mb: 1024
      pids: 128
      output_bytes: 1048576
      artifact_mb: 256

  course:
    provider: repository-command
    action: test
    command: ["./cpre381-toolflow", "test"]
    allow_repository_command: true
    limits:
      wall_time_seconds: 120
      memory_mb: 2048
      pids: 256
      output_bytes: 4194304
      artifact_mb: 512
```

### Manifest rules

- `version`, `name`, `sources`, and at least one target are required.
- Target names are unique and contain only letters, digits, `_`, and `-`.
- A target declares exactly one provider and action.
- The provider determines valid values for `language`, `standard`, `options`, and artifacts.
- Paths are workspace-relative. Absolute paths, traversal, and symlink escapes are invalid.
- Source globs resolve before snapshot creation. An empty source set is invalid.
- The server applies maximum file-count and total-input-byte limits after expansion.
- Target limits can reduce server defaults but cannot exceed server maximums.
- Provider options are namespaced under `options` and validated before job creation.
- Repository commands are argument arrays. Shell strings and implicit interpolation are invalid.
- Repository commands require both `allow_repository_command: true` and server-side enablement.

Manifest overrides supplied in an MCP call may select a target, reduce limits, set a declared parameter, or set a provider-declared runtime option. They cannot replace sources, change the executable, enable network access, or raise limits.

## Execution Flow

1. The client requests project validation or starts a target.
2. The gateway parses the manifest and selects the provider capability schema.
3. It canonicalizes paths and rejects traversal, symlink escape, excessive file counts, or oversized input.
4. It resolves source globs and creates an immutable snapshot manifest with SHA-256 hashes.
5. It creates a persistent `queued` job.
6. The worker claims the job atomically and changes it to `running`.
7. The worker creates isolated source, build, and artifact directories.
8. The provider validates its target and creates executable-plus-argument-array invocations.
9. The worker runs the process under all configured restrictions.
10. The provider parses diagnostics and test results without discarding original output.
11. The worker validates artifact paths and quotas, calculates checksums, and finalizes the artifact manifest.
12. The worker writes the immutable result and terminal state atomically.
13. The gateway returns the concise result and handles for further log or artifact queries.

## Isolation and Security

Hardware projects can execute native code, Python, simulator extensions, and repository commands. The worker therefore runs with:

- A non-root identity.
- No Docker socket.
- No host credentials or inherited arbitrary environment variables.
- No network by default.
- A fixed environment allowlist.
- A read-only source snapshot.
- Job-private writable build and artifact directories.
- CPU, memory, PID, wall-time, output-byte, and artifact-byte limits.
- Full process-group termination on cancellation or timeout.
- No access to live RARS discovery tokens or desktop bridge credentials.

Providers that require network access are unsupported in the first release. A future network-enabled provider must declare the requirement and use a separately configured worker class; a manifest cannot enable it.

Logs and results redact configured secret patterns and replace absolute host paths with workspace-relative paths. The audit record identifies the MCP session, target, provider, action, snapshot hash, and lifecycle transitions.

## Reproducibility

Every final result records:

- Provider ID and version.
- Tool versions.
- Worker image digest.
- Project-manifest hash.
- Source snapshot manifest and aggregate hash.
- Exact executable and argument arrays.
- Allowlisted environment values, excluding secrets.
- Random seed when applicable.
- Start and end timestamps.
- Exit code, signal, timeout, cancellation, or resource-limit reason.
- Artifact IDs and checksums.

Two jobs are equivalent inputs only when their provider, toolchain, manifest, snapshot, arguments, environment, and seed match. The system may use this identity for future caching, but result caching is not required by this specification.

## MCP Tool Interface

### `hardware_capabilities`

Lists installed providers, tool versions, supported actions, HDL languages and standards, artifact formats, option schemas, and server limits. This operation is read-only.

### `hardware_project_validate`

Accepts a manifest path and optional target. It resolves files and validates common and provider schemas without executing project code. It returns normalized project metadata, warnings, and calculated effective limits.

### `hardware_job_start`

Accepts a manifest path, target name, and permitted runtime overrides. It creates a job and returns its ID, initial state, snapshot identity, and effective limits. It does not wait for completion.

### `hardware_job_status`

Returns job state, timestamps, progress when known, result summary, diagnostic counts, and artifact counts. A terminal response includes the reproducibility record.

### `hardware_job_cancel`

Requests cancellation of a queued or running job. Repeated cancellation of a terminal job is idempotent and reports the existing terminal state.

### `hardware_job_logs`

Returns a bounded stdout/stderr window using byte offsets. It can filter normalized diagnostics by severity or phase. Responses include continuation offsets and truncation state.

### `hardware_artifact_list`

Lists artifact metadata for an authorized job. Artifact bytes are not embedded in this response.

### `hardware_wave_query`

Queries a waveform artifact using one of these operations:

- `hierarchy`
- `signals`
- `value_at`
- `transitions`
- `first_edge`
- `first_unknown`
- `pulse_widths`
- `compare`

Every request specifies or inherits limits for signal count, time span, transition count, and response bytes. A result that exceeds a bound returns a continuation cursor or derived artifact rather than silently truncating semantic data.

### `hardware_trace_compare`

Compares two normalized architectural traces using an explicit comparison policy. It returns the first meaningful divergence, preceding and following events, original provider records, and waveform time/cycle hints when available.

## Diagnostics and Errors

Expected tool outcomes use successful MCP transport with structured job or result data:

- HDL syntax, analysis, or elaboration failure.
- Failed test or assertion.
- Simulation timeout or configured resource exhaustion.
- Formal counterexample, failed proof, or inconclusive proof.
- Architectural trace divergence.
- Unsupported target capability.
- Nonzero course-command exit.

Normalized diagnostics contain:

- Severity.
- Provider and phase.
- Workspace-relative file path.
- Line and column when available.
- Diagnostic code when available.
- Normalized message.
- Original output excerpt and log offset.

Infrastructure failures use stable error codes:

- `INVALID_PROJECT`
- `PATH_OUTSIDE_WORKSPACE`
- `PROVIDER_UNAVAILABLE`
- `WORKER_UNAVAILABLE`
- `JOB_NOT_FOUND`
- `JOB_STATE_CONFLICT`
- `ARTIFACT_LIMIT_EXCEEDED`
- `WORKER_PROTOCOL_MISMATCH`
- `ARTIFACT_CORRUPT`

Provider failures never silently fall back to a different provider.

## Waveform Model

The initial waveform layer supports VCD, FST, and GHW inputs. It preserves four-state values when the source format contains them.

Waveforms never enter model context in full. The analysis API returns only selected hierarchy metadata, values, and transitions. Default query limits are server configuration, and target manifests can only reduce them.

The index records timescale, time bounds, hierarchy, signal types and widths, and lookup data required for bounded queries. A corrupt or incomplete waveform remains downloadable as an artifact but cannot be queried and produces `ARTIFACT_CORRUPT` with the parser failure.

## Processor Trace Model

The core hardware harness is ISA-neutral. A processor provider can emit architectural events. The first RISC-V event schema is derived from RVFI semantics and contains:

- `retireOrder`
- `cycle`
- `lane`
- `valid`
- `instructionBits` and `instructionWidth`
- `pcBefore` and `pcAfter`
- Source register addresses and pre-state values
- Destination register address and post-state value
- Memory address, byte read/write masks, and read/write data
- Trap, interrupt, and halt state
- Privilege mode
- Optional symbol and source location
- Provider-specific original record reference

The internal event is not presented as a ratified RISC-V interface. RVFI is one adapter into it. RARS, Spike, Sail, and textual simulator traces are other adapters.

Trace policies define comparison behavior for initial state, system calls, CSRs, timers, misaligned accesses, traps, termination, and unsupported extensions. Comparison is based on retirement order, not equal simulation cycles. Pipeline stages and control signals remain waveform data associated through `cycle` and project-defined signal roles.

## Course-Flow Integration

The CprE 381 adapter initially uses the repository-command provider because public material does not establish the current private flow's complete commands or constraints. A sanitized current starter project is required before defining a specialized provider.

The generic course target:

- Invokes only an executable within the source snapshot.
- Uses an argument array declared in the manifest.
- Runs under the same isolation and limits as all other jobs.
- Preserves its complete logs and declared artifacts.
- Normalizes diagnostics when a parser is configured.
- Does not claim equivalence with the official grading environment.

The open-source Verilator/GHDL flows are local development aids. The course target remains authoritative for course submission behavior.

## Packaging

Compose uses optional services or profiles:

- `core`: current RARS MCP service and Java bridge; enabled by default.
- `rtl`: hardware worker with Verilator, GHDL, waveform parsing, and initial providers.
- `formal`: Yosys, SBY, and solver tooling.
- `reference`: Spike and/or Sail plus RISC-V verification assets.

`docker compose up` preserves the current RARS-only behavior. Hardware capabilities report unavailable until the relevant worker is running. External tool archives and images use immutable versions and checksums. Distribution includes a generated third-party software and license inventory.

## Testing

### Unit tests

- Manifest parsing and provider option validation.
- Glob expansion, path containment, and symlink escape rejection.
- File-count, input-size, output-size, and artifact quotas.
- Job state transitions and atomic restart recovery.
- Command-array construction without shell interpolation.
- Diagnostic parsers.
- Artifact checksum and path validation.
- Waveform query bounds and continuation.
- Retirement-event normalization and comparison policies.

### Provider contract tests

Every provider fixture covers:

- Capability reporting.
- Valid project execution.
- Invalid source diagnostics.
- Unsupported option rejection.
- Timeout and cancellation.
- Output and artifact quota handling.
- Reproducibility metadata.

### Integration tests

- Verilator compiles and simulates a small SystemVerilog design.
- GHDL analyzes, elaborates, and simulates a small VHDL design.
- Both providers generate queryable waveforms.
- A repository command runs only when both opt-ins are enabled.
- The worker cannot access the network, RARS tokens, or paths outside its job.
- Gateway restart marks orphaned jobs `aborted` and retains partial artifacts.
- A long hardware job does not block a RARS invocation.

### End-to-end processor fixture

An intentionally faulty small RISC-V processor must:

1. Run a RARS-assembled program.
2. Produce RTL retirement events and a waveform.
3. Compare against the RARS or reference trace.
4. Identify the first architectural divergence.
5. Map it to a simulation cycle.
6. Query relevant internal signals in a bounded window.
7. Return evidence linked to the RTL and assembly source locations when available.

## Delivery Milestones

### Milestone 1: Execution substrate

- Versioned manifest.
- Persistent job store and recovery.
- Isolated hardware worker.
- Verilator and GHDL providers.
- Repository-command provider.
- Logs, diagnostics, artifacts, capability discovery, and Compose packaging.

### Milestone 2: Waveform intelligence

- VCD/FST/GHW indexing.
- Structured bounded waveform queries.
- Four-state handling.
- Signal-role metadata.

### Milestone 3: Processor differential debugging

- Architectural event schema.
- RARS trace producer.
- RTL/RVFI trace producer.
- Comparison policy and first-divergence reports.
- Spike or Sail reference provider.

### Milestone 4: Verification expansion

- cocotb regressions.
- Yosys structural analysis.
- SBY formal jobs and counterexample artifacts.
- riscv-formal integration.
- Seeded test generation and failing-case minimization.

## Success Criteria

- A VHDL or Verilog/SystemVerilog project can be validated and executed through a stable MCP interface.
- Verilator, GHDL, and explicitly enabled course commands share the same job and artifact model.
- Jobs and terminal results survive gateway restarts; interrupted jobs become `aborted` without silent resumption.
- Hardware workloads cannot read live RARS credentials or paths outside their isolated job inputs.
- Time, memory, PID, output, and artifact limits terminate work predictably and clean the full process group.
- Waveform queries return bounded structured data without embedding full dumps.
- A deliberately faulty processor fixture produces a correctly located first architectural divergence and supporting waveform evidence.
- Existing RARS tools and live sessions continue to pass their tests and remain responsive during hardware jobs.
- The default Compose startup remains the current lightweight RARS service, with hardware toolchains activated explicitly.

## Research Basis

The design is informed by the following primary documentation and public course evidence:

- RISC-V Formal Interface: https://yosyshq.readthedocs.io/projects/riscv-formal/en/latest/rvfi.html
- RISC-V ratified specifications: https://docs.riscv.org/reference/home/index.html
- Verilator: https://verilator.org/guide/latest/overview.html
- GHDL: https://github.com/ghdl/ghdl
- cocotb: https://www.cocotb.org/
- Surfer: https://docs.surfer-project.org/book/
- wellen: https://github.com/ekiwi/wellen
- Yosys/SBY: https://yosyshq.readthedocs.io/
- OSS CAD Suite: https://github.com/YosysHQ/oss-cad-suite-build
- Docker resource constraints: https://docs.docker.com/reference/compose-file/deploy/
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/
- Public CprE 381 VHDL testbench: https://git.ece.iastate.edu/cpre-381-project-1/project1/-/blob/main/proj/test/tb_ALU.vhd
