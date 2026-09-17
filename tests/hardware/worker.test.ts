import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHardwareWorker, type HardwareWorker } from '../../src/hardware/worker.js';

const limits = { concurrency: 1, wallTimeSeconds: 5, memoryMb: 256, pids: 64, outputBytes: 4096, artifactMb: 1, sourceFiles: 100, sourceBytes: 1024 * 1024 };
const workers: HardwareWorker[] = [];

async function request(worker: HardwareWorker, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`http://worker${path}`, { ...init, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...init.headers } }));
}

async function waitForTerminal(worker: HardwareWorker, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(worker, `/jobs/${id}`);
    const body = await response.json() as Record<string, unknown>;
    if (['succeeded', 'failed', 'cancelled', 'aborted'].includes(body.state as string)) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not finish');
}

afterEach(async () => Promise.all(workers.splice(0).map((worker) => worker.close())));

describe('hardware worker', () => {
  it('runs a repository command and persists logs and artifacts', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'worker-space-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'worker-state-'));
    await writeFile(join(workspaceRoot, 'run.sh'), '#!/bin/sh\necho hello\necho artifact > "$HARDWARE_ARTIFACT_DIR/report.log"\n');
    await chmod(join(workspaceRoot, 'run.sh'), 0o755);
    await writeFile(join(workspaceRoot, 'hardware.project.yaml'), `
version: 1
name: course
sources: [run.sh]
targets:
  course:
    provider: repository-command
    action: test
    command: [./run.sh]
    allow_repository_command: true
`);
    const worker = await createHardwareWorker({ workspaceRoot, stateRoot, token: 'test-token', allowRepositoryCommands: true, limits, executableVersions: {} });
    workers.push(worker);

    const start = await request(worker, '/jobs', { method: 'POST', body: JSON.stringify({ manifestPath: 'hardware.project.yaml', target: 'course' }) });
    expect(start.status).toBe(202);
    const { id } = await start.json() as { id: string };
    const job = await waitForTerminal(worker, id);
    expect(job).toMatchObject({ state: 'succeeded', result: { success: true } });

    const logs = await (await request(worker, `/jobs/${id}/logs?offset=0&limit=100`)).json() as Record<string, unknown>;
    expect(logs).toMatchObject({ text: expect.stringContaining('hello'), nextOffset: expect.any(Number) });
    const artifacts = await (await request(worker, `/jobs/${id}/artifacts`)).json() as { artifacts: Array<Record<string, unknown>> };
    expect(artifacts.artifacts).toEqual([expect.objectContaining({ path: 'report.log' })]);
  });

  it('rejects missing authentication and validates without execution', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'worker-space-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'worker-state-'));
    const worker = await createHardwareWorker({ workspaceRoot, stateRoot, token: 'test-token', allowRepositoryCommands: false, limits, executableVersions: {} });
    workers.push(worker);
    expect((await worker.fetch(new Request('http://worker/capabilities'))).status).toBe(401);
    expect((await worker.fetch(new Request('http://worker/health'))).status).toBe(200);
  });

  it('cancels a running job', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'worker-space-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'worker-state-'));
    await writeFile(join(workspaceRoot, 'run.sh'), '#!/bin/sh\nwhile true; do sleep 1; done\n');
    await chmod(join(workspaceRoot, 'run.sh'), 0o755);
    await writeFile(join(workspaceRoot, 'hardware.project.yaml'), 'version: 1\nname: slow\nsources: [run.sh]\ntargets:\n  slow:\n    provider: repository-command\n    action: test\n    command: [./run.sh]\n    allow_repository_command: true\n');
    const worker = await createHardwareWorker({ workspaceRoot, stateRoot, token: 'test-token', allowRepositoryCommands: true, limits, executableVersions: {} });
    workers.push(worker);
    const started = await (await request(worker, '/jobs', { method: 'POST', body: JSON.stringify({ manifestPath: 'hardware.project.yaml', target: 'slow' }) })).json() as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await request(worker, `/jobs/${started.id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect(await waitForTerminal(worker, started.id)).toMatchObject({ state: 'cancelled' });
  });
});
