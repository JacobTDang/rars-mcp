import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RarsError } from '../../errors.js';
import type { HardwareJob, HardwareJobRequest, HardwareResult, TerminalJobState } from '../types.js';

const terminalStates = new Set<TerminalJobState>(['succeeded', 'failed', 'cancelled', 'aborted']);

export class HardwareJobStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<HardwareJobStore> {
    await mkdir(join(root, 'jobs'), { recursive: true });
    return new HardwareJobStore(root);
  }

  create(request: HardwareJobRequest): Promise<HardwareJob> {
    return this.serial(async () => {
      const now = new Date().toISOString();
      const job: HardwareJob = { id: randomUUID(), state: 'queued', request, createdAt: now, updatedAt: now };
      await this.persist(job);
      return job;
    });
  }

  claim(id: string): Promise<HardwareJob> {
    return this.serial(async () => {
      const job = await this.read(id);
      if (job.state !== 'queued') throw this.conflict(job, 'claim');
      const now = new Date().toISOString();
      const next: HardwareJob = { ...job, state: 'running', startedAt: now, updatedAt: now };
      await this.persist(next);
      return next;
    });
  }

  finish(id: string, state: TerminalJobState, result: HardwareResult): Promise<HardwareJob> {
    return this.serial(async () => {
      const job = await this.read(id);
      if (job.state !== 'running') throw this.conflict(job, 'finish');
      const now = new Date().toISOString();
      const cancelled = job.cancellationRequested;
      const nextResult = cancelled ? this.interruptedResult('cancelled') : result;
      const next: HardwareJob = { ...job, state: cancelled ? 'cancelled' : state, result: nextResult, updatedAt: now, finishedAt: now };
      await this.persist(next);
      return next;
    });
  }

  cancel(id: string): Promise<HardwareJob> {
    return this.serial(async () => {
      const job = await this.read(id);
      if (terminalStates.has(job.state as TerminalJobState)) return job;
      const now = new Date().toISOString();
      const next: HardwareJob = job.state === 'queued'
        ? { ...job, state: 'cancelled', updatedAt: now, finishedAt: now, result: this.interruptedResult('cancelled') }
        : { ...job, cancellationRequested: true, updatedAt: now };
      await this.persist(next);
      return next;
    });
  }

  get(id: string): Promise<HardwareJob> {
    return this.read(id);
  }

  async list(): Promise<HardwareJob[]> {
    const entries = await readdir(join(this.root, 'jobs'), { withFileTypes: true });
    const jobs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.read(entry.name)));
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  recover(): Promise<string[]> {
    return this.serial(async () => {
      const recovered: string[] = [];
      for (const job of await this.list()) {
        if (job.state !== 'queued' && job.state !== 'running') continue;
        const now = new Date().toISOString();
        const interrupted = this.interruptedResult('aborted');
        if (job.result?.artifacts) interrupted.artifacts = job.result.artifacts;
        await this.persist({ ...job, state: 'aborted', updatedAt: now, finishedAt: now, result: interrupted });
        recovered.push(job.id);
      }
      return recovered;
    });
  }

  private interruptedResult(reason: 'cancelled' | 'aborted'): HardwareResult {
    return { success: false, summary: `Job ${reason}`, diagnostics: [], artifacts: [], exitCode: null, signal: null, reason };
  }

  private conflict(job: HardwareJob, action: string): RarsError {
    return new RarsError('JOB_STATE_CONFLICT', `Cannot ${action} job in state ${job.state}`, { id: job.id, state: job.state });
  }

  private async read(id: string): Promise<HardwareJob> {
    try {
      return JSON.parse(await readFile(join(this.root, 'jobs', id, 'job.json'), 'utf8')) as HardwareJob;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new RarsError('JOB_NOT_FOUND', `Hardware job does not exist: ${id}`, { id });
      throw error;
    }
  }

  private async persist(job: HardwareJob): Promise<void> {
    const directory = join(this.root, 'jobs', job.id);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `job.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(directory, 'job.json'));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
