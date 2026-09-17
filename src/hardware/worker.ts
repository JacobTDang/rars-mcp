import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RarsError } from '../errors.js';
import { finalizeArtifacts } from './artifacts.js';
import { HardwareJobStore } from './jobs/store.js';
import { loadHardwareProject } from './manifest.js';
import { runBoundedProcess } from './process.js';
import { createProviderRegistry } from './providers/registry.js';
import { createSnapshot } from './snapshot.js';
import type { HardwareLimits, HardwareResult, ProcessResult } from './types.js';

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
  let queue = Promise.resolve();
  let closed = false;

  const execute = async (id: string) => {
    let claimed = false;
    try {
      const job = await store.claim(id);
      claimed = true;
      const project = await loadHardwareProject(config.workspaceRoot, job.request.manifestPath, config.limits, await registry.capabilities(), config.allowRepositoryCommands);
      const target = project.targets[job.request.target];
      if (!target) throw new RarsError('INVALID_PROJECT', `Target does not exist: ${job.request.target}`);
      const snapshot = await createSnapshot(project, target, config.stateRoot);
      const jobRoot = join(config.stateRoot, 'jobs', id);
      const buildRoot = join(jobRoot, 'build');
      const artifactRoot = join(jobRoot, 'artifacts');
      await mkdir(buildRoot, { recursive: true });
      await mkdir(artifactRoot, { recursive: true });
      const context = { target, snapshotRoot: snapshot.root, buildRoot, artifactRoot };
      const provider = registry.get(target.provider);
      const commands = await provider.commands(context);
      const controller = new AbortController();
      controllers.set(id, controller);
      const results: ProcessResult[] = [];
      for (const command of commands) {
        const result = await runBoundedProcess(command, controller.signal);
        results.push(result);
        await appendFile(join(jobRoot, 'combined.log'), result.stdout + result.stderr, { mode: 0o600 });
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
    }
  };

  const schedule = (id: string) => {
    const task = queue.then(() => execute(id));
    queue = task.catch(() => undefined);
    running.add(task);
    void task.finally(() => running.delete(task));
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
          const job = await store.create({ manifestPath: body.manifestPath, target: body.target, ...(body.parentJobId ? { parentJobId: body.parentJobId } : {}) });
          schedule(job.id);
          return json(job, 202);
        }
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
