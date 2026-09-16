# Hardware Harness Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the persistent, isolated hardware-job substrate with manifest validation, Verilator, GHDL, repository-command providers, logs, artifacts, and MCP tools while preserving all RARS behavior.

**Architecture:** The existing MCP gateway calls an internal HTTP hardware worker. The worker owns manifest resolution, immutable source snapshots, a file-backed job store, a single-concurrency queue, provider execution, and artifact finalization. Compose mounts the user workspace read-only into the worker and a dedicated state volume read/write; the worker has no live-RARS runtime mount.

**Tech Stack:** Node.js 22, TypeScript 5.9, Zod 4, `yaml`, `fast-glob`, Vitest, Docker Compose, Verilator, GHDL.

## Global Constraints

- Existing RARS MCP tool names and schemas remain backward compatible.
- Source paths are workspace-relative and must survive canonical containment and symlink checks.
- Hardware jobs are asynchronous and use states `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `aborted`.
- Interrupted `queued` or `running` jobs become `aborted` on worker startup; processes are not resumed.
- Terminal job results and finalized artifacts are immutable.
- Repository commands use executable-plus-argument arrays and require manifest and server opt-in.
- The worker runs one job concurrently by default, without network access, as a non-root user, and without RARS tokens or runtime discovery mounts.
- Every process has wall-time, output-byte, artifact-byte, memory, and PID limits; cancellation terminates its process group.
- The default `rars-mcp` Compose service remains usable without enabling the `rtl` profile.
- Every task uses test-driven development and ends in a focused commit.

---

## File Structure

- `src/hardware/types.ts`: shared manifest, provider, job, result, diagnostic, and artifact types.
- `src/hardware/manifest.ts`: YAML loading, Zod validation, limit calculation, source resolution, and containment.
- `src/hardware/snapshot.ts`: immutable snapshot creation and hashing.
- `src/hardware/jobs/store.ts`: atomic file-backed records, state transitions, and restart recovery.
- `src/hardware/process.ts`: bounded child-process execution and process-group cancellation.
- `src/hardware/providers/provider.ts`: provider contract.
- `src/hardware/providers/verilator.ts`: Verilator command construction and diagnostics.
- `src/hardware/providers/ghdl.ts`: GHDL command construction and diagnostics.
- `src/hardware/providers/repository-command.ts`: opt-in repository command execution.
- `src/hardware/providers/registry.ts`: provider lookup and capability aggregation.
- `src/hardware/worker.ts`: queue, job execution, artifact finalization, and worker HTTP API.
- `src/hardware/client.ts`: gateway-to-worker HTTP client.
- `src/hardware/tool-schemas.ts`: public hardware MCP input schemas.
- `src/hardware/tool-handlers.ts`: public hardware MCP handlers.
- `tests/hardware/*.test.ts`: focused unit and integration tests.
- `Dockerfile.hardware`: pinned worker image.
- `compose.yaml`: optional `rtl` worker profile, read-only workspace, state volume, and limits.

### Task 1: Shared contracts and configuration

**Files:**
- Create: `src/hardware/types.ts`
- Modify: `src/config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/hardware/config.test.ts`

**Interfaces:**
- Produces: `HardwareConfig`, `HardwareLimits`, `JobState`, `HardwareJob`, `ProviderCapability`, `ArtifactRecord`, and `HardwareResult`.
- Consumes: existing `RarsError` configuration error conventions.

- [ ] **Step 1: Write failing configuration tests**

```ts
it('loads bounded hardware defaults', () => {
  const config = loadConfig({ RARS_WORKSPACE: '/tmp/work' });
  expect(config.hardware).toEqual(expect.objectContaining({
    workerUrl: 'http://hardware-worker:3010',
    enabled: false,
    limits: expect.objectContaining({ concurrency: 1, wallTimeSeconds: 120 }),
  }));
});

it('rejects a non-positive hardware limit', () => {
  expect(() => loadConfig({ HARDWARE_MAX_PIDS: '0' })).toThrow(/HARDWARE_MAX_PIDS/);
});
```

- [ ] **Step 2: Run the tests and verify the missing hardware configuration failure**

Run: `npm test -- tests/hardware/config.test.ts`

Expected: FAIL because `AppConfig` has no `hardware` property.

- [ ] **Step 3: Add dependencies and shared types**

Run: `npm install yaml@2.8.1 fast-glob@3.3.3`

Define exact limits:

```ts
export interface HardwareLimits {
  wallTimeSeconds: number;
  memoryMb: number;
  pids: number;
  outputBytes: number;
  artifactMb: number;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'aborted';
```

Extend `AppConfig` with a `hardware` object loaded from `HARDWARE_ENABLED`, `HARDWARE_WORKER_URL`, `HARDWARE_WORKER_TOKEN`, `HARDWARE_STATE_DIR`, `HARDWARE_ALLOW_REPOSITORY_COMMANDS`, and positive integer limit variables. Default hardware execution is disabled in the gateway.

- [ ] **Step 4: Run configuration and existing tests**

Run: `npm test -- tests/hardware/config.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config.ts src/hardware/types.ts tests/hardware/config.test.ts
git commit -m "feat: define hardware harness contracts"
```

### Task 2: Manifest loading and secure source resolution

**Files:**
- Create: `src/hardware/manifest.ts`
- Test: `tests/hardware/manifest.test.ts`
- Create: `tests/fixtures/hardware/systemverilog/hardware.project.yaml`
- Create: `tests/fixtures/hardware/systemverilog/rtl/adder.sv`
- Create: `tests/fixtures/hardware/vhdl/hardware.project.yaml`
- Create: `tests/fixtures/hardware/vhdl/rtl/adder.vhd`

**Interfaces:**
- Produces: `loadHardwareProject(workspaceRoot, manifestPath, serverLimits, provider): Promise<ResolvedProject>`.
- Consumes: `HardwareLimits`, provider option schemas, `fast-glob`, and `yaml`.

- [ ] **Step 1: Write failing manifest tests**

Cover valid YAML, empty source expansion, absolute paths, `../` traversal, symlink escape, duplicate/invalid target names, unsupported provider options, repository command without dual opt-in, and target limits above server limits.

```ts
const project = await loadHardwareProject(root, 'hardware.project.yaml', limits, registry, false);
expect(project.targets.unit.sources).toEqual(['rtl/adder.sv']);
expect(project.targets.unit.effectiveLimits.wallTimeSeconds).toBe(30);
```

- [ ] **Step 2: Run the manifest tests**

Run: `npm test -- tests/hardware/manifest.test.ts`

Expected: FAIL because `loadHardwareProject` does not exist.

- [ ] **Step 3: Implement strict manifest parsing and resolution**

Use `yaml.parse`, Zod `.strict()` objects, `fast-glob` with `cwd`, and `realpath` containment checks. Sort resolved paths lexicographically for deterministic snapshots. Reject more than the configured source-file count or total input bytes.

```ts
export async function loadHardwareProject(
  workspaceRoot: string,
  manifestPath: string,
  serverLimits: HardwareLimits,
  registry: ProviderRegistry,
  allowRepositoryCommands: boolean,
): Promise<ResolvedProject>;
```

- [ ] **Step 4: Run manifest tests and type checking**

Run: `npm test -- tests/hardware/manifest.test.ts && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/manifest.ts tests/hardware tests/fixtures/hardware
git commit -m "feat: validate hardware project manifests"
```

### Task 3: Immutable snapshots and file-backed job store

**Files:**
- Create: `src/hardware/snapshot.ts`
- Create: `src/hardware/jobs/store.ts`
- Test: `tests/hardware/snapshot.test.ts`
- Test: `tests/hardware/job-store.test.ts`

**Interfaces:**
- Produces: `createSnapshot(project, stateRoot): Promise<SourceSnapshot>`.
- Produces: `HardwareJobStore.create`, `claim`, `finish`, `cancel`, `get`, `list`, and `recover`.
- Consumes: resolved project paths and shared job types.

- [ ] **Step 1: Write failing snapshot and job-state tests**

```ts
expect(snapshot.files[0]).toMatchObject({ path: 'rtl/adder.sv', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
expect(await readFile(join(snapshot.root, 'rtl/adder.sv'), 'utf8')).toContain('module adder');

const queued = await store.create(request);
const running = await store.claim(queued.id);
expect(running.state).toBe('running');
await expect(store.claim(queued.id)).rejects.toMatchObject({ code: 'JOB_STATE_CONFLICT' });
```

Include tests proving terminal records reject mutation and recovery changes persisted `queued`/`running` records to `aborted` while leaving terminal records unchanged.

- [ ] **Step 2: Run the tests**

Run: `npm test -- tests/hardware/snapshot.test.ts tests/hardware/job-store.test.ts`

Expected: FAIL because snapshot and store modules do not exist.

- [ ] **Step 3: Implement snapshots and atomic records**

Copy files without following links after resolution, calculate per-file and aggregate SHA-256 hashes, write a snapshot manifest, and remove write bits from copied sources. Persist each job below `stateRoot/jobs`, using the job UUID as its directory name and `job.json` as the record, with write-to-temporary-file plus rename.

```ts
export class HardwareJobStore {
  static async open(root: string): Promise<HardwareJobStore>;
  create(request: HardwareJobRequest): Promise<HardwareJob>;
  claim(id: string): Promise<HardwareJob>;
  finish(id: string, state: TerminalJobState, result: HardwareResult): Promise<HardwareJob>;
  cancel(id: string): Promise<HardwareJob>;
  get(id: string): Promise<HardwareJob>;
  list(): Promise<HardwareJob[]>;
  recover(): Promise<string[]>;
}
```

- [ ] **Step 4: Run focused tests and lint**

Run: `npm test -- tests/hardware/snapshot.test.ts tests/hardware/job-store.test.ts && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/snapshot.ts src/hardware/jobs/store.ts tests/hardware/snapshot.test.ts tests/hardware/job-store.test.ts
git commit -m "feat: persist hardware snapshots and jobs"
```

### Task 4: Bounded process runner and artifact finalization

**Files:**
- Create: `src/hardware/process.ts`
- Create: `src/hardware/artifacts.ts`
- Test: `tests/hardware/process.test.ts`
- Test: `tests/hardware/artifacts.test.ts`

**Interfaces:**
- Produces: `runBoundedProcess(request, signal): Promise<ProcessResult>`.
- Produces: `finalizeArtifacts(jobId, artifactRoot, maxBytes): Promise<ArtifactRecord[]>`.
- Consumes: provider command arrays and hardware limits.

- [ ] **Step 1: Write failing boundary tests**

Test successful execution, timeout, cancellation, combined output truncation, environment allowlisting, full process-group termination, artifact traversal rejection, artifact quota failure, and stable SHA-256 metadata.

```ts
const result = await runBoundedProcess({
  executable: process.execPath,
  args: ['-e', 'process.stdout.write("ok")'],
  cwd: root,
  env: {},
  limits,
}, new AbortController().signal);
expect(result).toMatchObject({ exitCode: 0, stdout: 'ok', timedOut: false, truncated: false });
```

- [ ] **Step 2: Run boundary tests**

Run: `npm test -- tests/hardware/process.test.ts tests/hardware/artifacts.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement bounded execution and artifact scanning**

Spawn with `shell: false`, `detached: true` on POSIX, explicit `cwd` and environment, streaming byte counters, a timeout timer, and abort handling. Terminate the negative process-group PID with `SIGTERM`, then `SIGKILL` after a fixed grace period. Treat output overflow as a terminal limit reason. Artifact finalization uses `lstat`/`realpath`, rejects links and non-regular files, enforces aggregate bytes, hashes each file, and sorts records by relative path.

- [ ] **Step 4: Run focused tests and lint**

Run: `npm test -- tests/hardware/process.test.ts tests/hardware/artifacts.test.ts && npm run lint`

Expected: PASS with no surviving child process in the cancellation test.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/process.ts src/hardware/artifacts.ts tests/hardware/process.test.ts tests/hardware/artifacts.test.ts
git commit -m "feat: bound hardware processes and artifacts"
```

### Task 5: Provider contract and initial providers

**Files:**
- Create: `src/hardware/providers/provider.ts`
- Create: `src/hardware/providers/registry.ts`
- Create: `src/hardware/providers/verilator.ts`
- Create: `src/hardware/providers/ghdl.ts`
- Create: `src/hardware/providers/repository-command.ts`
- Test: `tests/hardware/providers.test.ts`

**Interfaces:**
- Produces: `HardwareProvider.capability`, `validate`, `commands`, and `parseResult`.
- Produces: `createProviderRegistry(options): ProviderRegistry`.
- Consumes: resolved targets, snapshots, build/artifact roots, and process results.

- [ ] **Step 1: Write failing provider contract tests**

Assert exact command arrays for Verilator lint/simulate, GHDL analyze/elaborate/run, and repository commands. Assert rejection of language/action/format mismatches and conversion of sample tool messages into normalized diagnostics.

```ts
expect(commands[0]).toMatchObject({
  executable: 'verilator',
  args: ['--lint-only', '--language', '1800-2017', '--top-module', 'adder', 'rtl/adder.sv'],
});
```

- [ ] **Step 2: Run provider tests**

Run: `npm test -- tests/hardware/providers.test.ts`

Expected: FAIL because the provider modules do not exist.

- [ ] **Step 3: Implement the provider interface and registry**

```ts
export interface HardwareProvider {
  capability(): Promise<ProviderCapability>;
  validate(target: ResolvedTarget): void;
  commands(context: ProviderContext): Promise<ProviderCommand[]>;
  parseResult(context: ProviderContext, results: ProcessResult[]): Promise<HardwareResult>;
}
```

The registry returns stable capabilities even when an executable is unavailable, using `available: false` and a reason. Repository commands verify the executable resolves inside the read-only snapshot and never use a shell.

- [ ] **Step 4: Run provider tests and lint**

Run: `npm test -- tests/hardware/providers.test.ts && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/providers tests/hardware/providers.test.ts
git commit -m "feat: add initial hardware providers"
```

### Task 6: Worker queue and internal HTTP API

**Files:**
- Create: `src/hardware/worker.ts`
- Create: `src/hardware/worker-main.ts`
- Test: `tests/hardware/worker.test.ts`

**Interfaces:**
- Produces internal endpoints: `GET /health`, `GET /capabilities`, `POST /validate`, `POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel`, `GET /jobs/:id/logs`, and `GET /jobs/:id/artifacts`.
- Consumes: job store, manifest loader, snapshotter, provider registry, bounded process runner, and artifact finalizer.

- [ ] **Step 1: Write failing worker lifecycle tests**

Use a repository-command fixture to prove queued-to-running-to-succeeded state, bounded log pagination, cancellation, failed-command results, artifact listing, bearer-token rejection, and recovery of a manually persisted running job.

- [ ] **Step 2: Run worker tests**

Run: `npm test -- tests/hardware/worker.test.ts`

Expected: FAIL because `createHardwareWorker` does not exist.

- [ ] **Step 3: Implement the queue and API**

```ts
export interface HardwareWorker {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createHardwareWorker(config: HardwareWorkerConfig): Promise<HardwareWorker>;
```

Use a FIFO in-memory wakeup queue backed by persisted `queued` jobs. Claim records atomically, store each job's `AbortController`, and always finalize a terminal state in `finally`. Require a fixed bearer token on every endpoint except `/health`. Return stable JSON errors with `code`, `message`, and `details`.

- [ ] **Step 4: Run worker tests and all existing tests**

Run: `npm test -- tests/hardware/worker.test.ts && npm test -- --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/worker.ts src/hardware/worker-main.ts tests/hardware/worker.test.ts
git commit -m "feat: run persistent hardware jobs"
```

### Task 7: Gateway client and MCP tools

**Files:**
- Create: `src/hardware/client.ts`
- Create: `src/hardware/tool-schemas.ts`
- Create: `src/hardware/tool-handlers.ts`
- Modify: `src/tools/handlers.ts`
- Modify: `src/server.ts`
- Modify: `src/http.ts`
- Test: `tests/hardware/client.test.ts`
- Test: `tests/hardware/tools.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/http.test.ts`

**Interfaces:**
- Produces: gateway implementations for `hardware_capabilities`, `hardware_project_validate`, `hardware_job_start`, `hardware_job_status`, `hardware_job_cancel`, `hardware_job_logs`, and `hardware_artifact_list`.
- Consumes: internal worker JSON API.

- [ ] **Step 1: Write failing client and MCP tests**

Assert authorization headers, timeout/error translation, strict input schemas, tool registration, unavailable-worker behavior, asynchronous job creation, cancellation idempotence, and bounded log inputs.

```ts
expect(names).toEqual(expect.arrayContaining([
  'hardware_capabilities', 'hardware_project_validate', 'hardware_job_start',
  'hardware_job_status', 'hardware_job_cancel', 'hardware_job_logs',
  'hardware_artifact_list',
]));
```

- [ ] **Step 2: Run gateway tests**

Run: `npm test -- tests/hardware/client.test.ts tests/hardware/tools.test.ts tests/server.test.ts tests/http.test.ts`

Expected: FAIL because the hardware tools are not registered.

- [ ] **Step 3: Implement the client and handlers**

The client uses `fetch` with an abort timeout and bearer token. Tool handlers return short text plus structured content. Worker unavailability is reported clearly and does not affect RARS handlers. Add hardware status to `/capabilities` without changing existing fields.

- [ ] **Step 4: Run gateway and complete unit suites**

Run: `npm test -- tests/hardware/client.test.ts tests/hardware/tools.test.ts tests/server.test.ts tests/http.test.ts && npm test -- --run && npm run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hardware/client.ts src/hardware/tool-schemas.ts src/hardware/tool-handlers.ts src/tools/handlers.ts src/server.ts src/http.ts tests/hardware/client.test.ts tests/hardware/tools.test.ts tests/server.test.ts tests/http.test.ts
git commit -m "feat: expose hardware job MCP tools"
```

### Task 8: Container packaging and smoke tests

**Files:**
- Create: `Dockerfile.hardware`
- Modify: `compose.yaml`
- Modify: `.dockerignore`
- Create: `tests/hardware/docker-smoke.sh`
- Create: `tests/hardware/docker-smoke.mjs`
- Modify: `README.md`
- Create: `docs/hardware-harness.md`
- Modify: `docs/security.md`
- Modify: `docs/troubleshooting.md`

**Interfaces:**
- Produces: optional Compose profile `rtl` and documented startup `docker compose --profile rtl up -d --build`.
- Consumes: compiled worker entry point and shared workspace/state volumes.

- [ ] **Step 1: Add a failing smoke test**

The test starts the profile, validates gateway and worker health, checks provider capabilities, runs one SystemVerilog and one VHDL fixture, observes terminal states, lists logs/artifacts, and confirms the RARS health endpoint remains responsive.

- [ ] **Step 2: Run the smoke test before packaging**

Run: `bash tests/hardware/docker-smoke.sh`

Expected: FAIL because `hardware-worker` and the `rtl` profile do not exist.

- [ ] **Step 3: Add the worker image and Compose profile**

Build from a pinned Debian base, install pinned distro packages for Verilator and GHDL, copy only production Node output, run as `node`, declare an internal-only port, mount `./workspace:/workspace:ro`, mount `hardware-state:/state`, set `network_mode: none` only when the gateway/worker communication is moved to a Unix socket; for Milestone 1 use an isolated internal Compose network with no published worker port and no default route to unrelated services. Apply memory, CPU, and PID limits and do not mount `.runtime`.

- [ ] **Step 4: Document the exact security boundary and operational commands**

Document that the worker's internal Compose network is not a complete egress firewall on every Docker platform. Repository commands remain local-trust opt-in until per-job network namespaces are added. Document start, stop, logs, state location, cleanup, limits, and provider troubleshooting.

- [ ] **Step 5: Run all verification**

Run: `npm ci && npm run build && npm run lint && npm test -- --run && bash tests/hardware/docker-smoke.sh && bash tests/docker-smoke.sh`

Expected: all commands exit 0.

- [ ] **Step 6: Commit and push the milestone**

```bash
git add Dockerfile.hardware compose.yaml .dockerignore tests/hardware/docker-smoke.sh tests/hardware/docker-smoke.mjs README.md docs/hardware-harness.md docs/security.md docs/troubleshooting.md
git commit -m "feat: package isolated hardware worker"
git push
```

### Task 9: Milestone verification and review

**Files:**
- Modify only files required by verified review findings.

**Interfaces:**
- Verifies every Milestone 1 success criterion before beginning waveform work.

- [ ] **Step 1: Run the complete local and container verification suite from a clean install**

Run: `npm ci && npm run build && npm run lint && npm test -- --run && bash tests/hardware/docker-smoke.sh && bash tests/docker-smoke.sh`

Expected: all commands exit 0 with no orphan worker or simulator processes.

- [ ] **Step 2: Verify repository state and generated artifacts**

Run: `git status --short && docker compose ps && docker compose --profile rtl logs --no-color --tail=200`

Expected: only intentional ignored runtime artifacts, healthy services, and no secrets or absolute host paths in logs.

- [ ] **Step 3: Request code review and address only concrete findings**

Review against `docs/superpowers/specs/2026-09-16-hardware-tool-harness-design.md`, focusing on command injection, containment, state races, process cleanup, and backward compatibility.

- [ ] **Step 4: Commit and push review fixes when present**

```bash
git add -u
git commit -m "fix: harden hardware execution substrate"
git push
```

If review requires no changes, do not create an empty commit.

## Later Plans

After Milestone 1 passes its gate, create and execute separate implementation plans in this order:

1. `2026-09-16-hardware-harness-waveforms.md` for VCD/FST/GHW indexing and bounded queries.
2. `2026-09-16-hardware-harness-processor-traces.md` for normalized retirement events, RARS/RTL comparison, and Spike or Sail.
3. `2026-09-16-hardware-harness-verification.md` for cocotb, Yosys/SBY, riscv-formal, seeded generation, and failure minimization.

Each later plan starts only after the preceding milestone is verified, committed, and pushed.
