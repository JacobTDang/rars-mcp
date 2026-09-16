import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HardwareJobStore } from '../../src/hardware/jobs/store.js';

const request = { manifestPath: 'hardware.project.yaml', target: 'unit' };

describe('hardware job store', () => {
  it('enforces state transitions and terminal immutability', async () => {
    const store = await HardwareJobStore.open(await mkdtemp(join(tmpdir(), 'job-store-')));
    const queued = await store.create(request);
    expect(queued.state).toBe('queued');

    const running = await store.claim(queued.id);
    expect(running.state).toBe('running');
    await expect(store.claim(queued.id)).rejects.toMatchObject({ code: 'JOB_STATE_CONFLICT' });

    const finished = await store.finish(queued.id, 'succeeded', {
      success: true, summary: 'ok', diagnostics: [], artifacts: [], exitCode: 0, signal: null,
    });
    expect(finished.state).toBe('succeeded');
    await expect(store.finish(queued.id, 'failed', {
      success: false, summary: 'late', diagnostics: [], artifacts: [], exitCode: 1, signal: null,
    })).rejects.toMatchObject({ code: 'JOB_STATE_CONFLICT' });
  });

  it('cancels queued jobs and treats terminal cancellation as idempotent', async () => {
    const store = await HardwareJobStore.open(await mkdtemp(join(tmpdir(), 'job-store-')));
    const job = await store.create(request);
    expect((await store.cancel(job.id)).state).toBe('cancelled');
    expect((await store.cancel(job.id)).state).toBe('cancelled');
  });

  it('marks persisted nonterminal jobs aborted during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-store-'));
    const store = await HardwareJobStore.open(root);
    const queued = await store.create(request);
    const running = await store.create(request);
    await store.claim(running.id);
    const terminal = await store.create(request);
    await store.cancel(terminal.id);

    expect(await store.recover()).toEqual(expect.arrayContaining([queued.id, running.id]));
    expect((await store.get(queued.id)).state).toBe('aborted');
    expect((await store.get(running.id)).state).toBe('aborted');
    expect((await store.get(terminal.id)).state).toBe('cancelled');
  });

  it('persists records across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-store-'));
    const first = await HardwareJobStore.open(root);
    const job = await first.create(request);
    const second = await HardwareJobStore.open(root);
    await expect(second.get(job.id)).resolves.toMatchObject({ id: job.id, request });
    await expect(second.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
