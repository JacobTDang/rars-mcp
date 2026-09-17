import { appendFile, chmod, chown, mkdir, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { RarsError } from '../errors.js';
import { finalizeArtifacts } from './artifacts.js';
import { HardwareJobStore } from './jobs/store.js';
import { loadHardwareProject } from './manifest.js';
import { runBoundedProcess } from './process.js';
import { createProviderRegistry } from './providers/registry.js';
import { createSnapshot } from './snapshot.js';
import type { HardwareLimits, HardwareResult, ProcessResult } from './types.js';
import { loadOrCreateVcdIndex, queryWave } from './waveform.js';
import { compareTraces, loadTrace, type TraceFormat, type TracePolicy } from './trace.js';
import { generateRiscvProgram } from './generation.js';

export interface HardwareWorkerConfig {
  workspaceRoot: string;
  stateRoot: string;
  token: string;
  allowRepositoryCommands: boolean;
  limits: HardwareLimits;
  executableVersions: Record<string, string | null>;
}

export interface HardwareWorker {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export async function createHardwareWorker(config: HardwareWorkerConfig): Promise<HardwareWorker> {
  const store = await HardwareJobStore.open(config.stateRoot);
  await store.recover();
  const registry = createProviderRegistry({ executableVersions: config.executableVersions, allowRepositoryCommands: config.allowRepositoryCommands });
  const controllers = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  const pending: string[] = [];
  let active = 0;
  let closed = false;

  const execute = async (id: string) => {
    let claimed = false;
    let sandbox: { uid: number; snapshotRoot: string; executionRoot: string } | undefined;
    try {
      const job = await store.claim(id);
      claimed = true;
      const target = job.request.resolvedTarget;
      const snapshot = job.request.snapshot;
      if (!target || !snapshot) throw new RarsError('INVALID_PROJECT', 'Queued job has no immutable snapshot');
      const controller = new AbortController();
      controllers.set(id, controller);
      if ((await store.get(id)).cancellationRequested) controller.abort();
      const jobRoot = join(config.stateRoot, 'executions', id);
      const buildRoot = join(jobRoot, 'build');
      const artifactRoot = join(jobRoot, 'artifacts');
      await mkdir(buildRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const slot = activeIds.indexOf(id);
      const runAs = process.platform === 'linux' && process.getuid?.() === 0 ? { uid: 20_000 + slot, gid: 20_000 + slot } : undefined;
      if (runAs) {
        await chmod(config.stateRoot, 0o711); await mkdir(join(config.stateRoot, 'executions'), { recursive: true, mode: 0o711 });
        await chmod(join(config.stateRoot, 'executions'), 0o711);
        await chown(jobRoot, 0, runAs.gid); await chmod(jobRoot, 0o710);
        await secureSnapshot(snapshot.root, runAs.gid);
        for (const dir of [buildRoot, artifactRoot]) { await chown(dir, runAs.uid, runAs.gid); await chmod(dir, 0o700); }
        sandbox = { uid: runAs.uid, snapshotRoot: snapshot.root, executionRoot: jobRoot };
      }
      const context = { target, snapshotRoot: snapshot.root, buildRoot, artifactRoot };
      const provider = registry.get(target.provider);
      const commands = await provider.commands(context);
      const results: ProcessResult[] = [];
      for (const command of commands) {
        if ((await store.get(id)).cancellationRequested) controller.abort();
        const result = await runBoundedProcess({ ...command, artifactRoot, ...(runAs ? { runAs } : {}) }, controller.signal);
        results.push(result);
        await appendFile(join(config.stateRoot, 'jobs', id, 'combined.log'), result.stdout + result.stderr, { mode: 0o600 });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.truncated) break;
      }
      const artifacts = await finalizeArtifacts(id, artifactRoot, target.effectiveLimits.artifactMb * 1024 * 1024);
      const result = await provider.parseResult(context, results, artifacts);
      result.reproducibility = { provider: target.provider, providerVersion: (await provider.capability()).version, snapshotSha256: snapshot.sha256, commands: results.map((item) => ({ executable: item.executable, args: item.args })) };
      await store.finish(id, result.success ? 'succeeded' : result.reason === 'cancelled' ? 'cancelled' : 'failed', result);
    } catch (error) {
      if (!claimed) return;
      const message = error instanceof Error ? error.message : String(error);
      const result: HardwareResult = { success: false, summary: message, diagnostics: [], artifacts: [], exitCode: null, signal: null, reason: 'exit' };
      try { await store.finish(id, 'failed', result); } catch {}
    } finally {
      controllers.delete(id);
      if (sandbox) {
        spawnSync('pkill', ['-KILL', '-u', String(sandbox.uid)], { stdio: 'ignore' });
        await chmod(sandbox.snapshotRoot, 0o700).catch(() => undefined);
        await chmod(sandbox.executionRoot, 0o700).catch(() => undefined);
      }
    }
  };

  const activeIds: string[] = [];
  const pump = () => {
    while (!closed && active < config.limits.concurrency && pending.length > 0) {
      const id = pending.shift() as string;
      active++; activeIds.push(id);
      const task = execute(id);
      running.add(task);
      void task.finally(() => { running.delete(task); active--; activeIds.splice(activeIds.indexOf(id), 1); pump(); });
    }
  };
  const schedule = (id: string) => {
    pending.push(id);
    pump();
  };

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health') return json({ status: closed ? 'closing' : 'ok' });
        if (request.headers.get('authorization') !== `Bearer ${config.token}`) return json({ code: 'UNAUTHORIZED', message: 'Invalid worker token' }, 401);
        if (request.method === 'GET' && url.pathname === '/capabilities') return json({ providers: await registry.capabilities(), limits: config.limits });
        if (request.method === 'POST' && url.pathname === '/validate') {
          const body = await request.json() as { manifestPath: string; target?: string };
          const project = await loadHardwareProject(config.workspaceRoot, body.manifestPath, config.limits, await registry.capabilities(), config.allowRepositoryCommands);
          if (body.target && !project.targets[body.target]) throw new RarsError('INVALID_PROJECT', `Target does not exist: ${body.target}`);
          return json(project);
        }
        if (request.method === 'POST' && url.pathname === '/jobs') {
          const body = await request.json() as { manifestPath: string; target: string; parentJobId?: string };
          const project = await loadHardwareProject(config.workspaceRoot, body.manifestPath, config.limits, await registry.capabilities(), config.allowRepositoryCommands);
          if (!project.targets[body.target]) throw new RarsError('INVALID_PROJECT', `Target does not exist: ${body.target}`);
          const target = project.targets[body.target];
          if (!target) throw new RarsError('INVALID_PROJECT', `Target does not exist: ${body.target}`);
          const snapshot = await createSnapshot(project, target, config.stateRoot);
          const job = await store.create({ manifestPath: body.manifestPath, target: body.target, snapshot, resolvedTarget: target, ...(body.parentJobId ? { parentJobId: body.parentJobId } : {}) });
          schedule(job.id);
          return json(job, 202);
        }
        const waveMatch = /^\/jobs\/([0-9a-f-]+)\/wave$/u.exec(url.pathname);
        if (request.method === 'POST' && waveMatch) {
          const id = waveMatch[1] as string; const body = await request.json() as { artifactId: string; operation: string; signal?: string; otherSignal?: string; startTime?: number; endTime?: number; limit?: number; cursor?: number };
          const job = await store.get(id); const artifact = job.result?.artifacts.find((item) => item.id === body.artifactId && item.type === 'waveform');
          if (!artifact) throw new RarsError('ARTIFACT_CORRUPT', 'Waveform artifact does not exist for this job');
          const source = join(config.stateRoot, 'executions', id, 'artifacts', artifact.path);
          const indexPath = join(config.stateRoot, 'jobs', id, `wave-${artifact.id}.json`);
          const index = await loadOrCreateVcdIndex(source, indexPath, artifact.sha256, (job.request.resolvedTarget?.effectiveLimits.artifactMb ?? config.limits.artifactMb) * 1024 * 1024);
          const roles = job.request.resolvedTarget?.signalRoles ?? {};
          for (const signal of index.signals) { const role = roles[signal.path] ?? roles[signal.name]; if (role !== undefined) signal.role = role; }
          return json(queryWave(index, body));
        }
        if (request.method === 'POST' && url.pathname === '/trace/compare') {
          const body = await request.json() as { left: { jobId: string; artifactId: string; format: TraceFormat }; right: { jobId: string; artifactId: string; format: TraceFormat }; policy?: TracePolicy; context?: number };
          const resolveTrace = async (side: typeof body.left) => { const job = await store.get(side.jobId); const artifact = job.result?.artifacts.find((item) => item.id === side.artifactId && item.type === 'trace'); if (!artifact) throw new RarsError('ARTIFACT_CORRUPT', 'Trace artifact does not exist for this job'); return loadTrace(join(config.stateRoot, 'executions', side.jobId, 'artifacts', artifact.path), side.format); };
          return json(compareTraces(await resolveTrace(body.left), await resolveTrace(body.right), body.policy, body.context));
        }
        if (request.method === 'POST' && url.pathname === '/riscv/generate') { const body = await request.json() as { seed: number; instructionCount: number }; return json({ seed: body.seed, assembly: generateRiscvProgram(body.seed, body.instructionCount) }); }
        const match = /^\/jobs\/([0-9a-f-]+)(?:\/(cancel|logs|artifacts))?$/u.exec(url.pathname);
        if (match) {
          const id = match[1] as string;
          const action = match[2];
          if (request.method === 'GET' && !action) return json(await store.get(id));
          if (request.method === 'POST' && action === 'cancel') {
            const job = await store.cancel(id);
            controllers.get(id)?.abort();
            return json(job);
          }
          if (request.method === 'GET' && action === 'artifacts') return json({ artifacts: (await store.get(id)).result?.artifacts ?? [] });
          if (request.method === 'GET' && action === 'logs') {
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
            const limit = Math.min(65_536, Math.max(1, Number(url.searchParams.get('limit') ?? 8192)));
            const contents = await readFile(join(config.stateRoot, 'jobs', id, 'combined.log')).catch(() => Buffer.alloc(0));
            const end = Math.min(contents.byteLength, offset + limit);
            return json({ text: contents.subarray(offset, end).toString('utf8'), offset, nextOffset: end, eof: end >= contents.byteLength });
          }
        }
        return json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
      } catch (error) {
        if (error instanceof RarsError) return json({ code: error.code, message: error.message, details: error.details }, 400);
        return json({ code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
    async close(): Promise<void> {
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...running]);
    },
  };
}

async function secureSnapshot(root: string, gid: number): Promise<void> {
  await chown(root, 0, gid); await chmod(root, 0o550);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await secureSnapshot(path, gid);
    else { await chown(path, 0, gid); await chmod(path, 0o440); }
  }
}
