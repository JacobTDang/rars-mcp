import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runBoundedProcess } from '../../src/hardware/process.js';

const base = { concurrency: 1, wallTimeSeconds: 2, memoryMb: 128, pids: 32, outputBytes: 1024, artifactMb: 1, sourceFiles: 10, sourceBytes: 1024 };

describe('bounded hardware process', () => {
  it('captures successful output without a shell', async () => {
    const result = await runBoundedProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'], cwd: await mkdtemp(join(tmpdir(), 'proc-')), env: {}, limits: base }, new AbortController().signal);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false, truncated: false });
  });

  it('terminates on timeout', async () => {
    const result = await runBoundedProcess({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: await mkdtemp(join(tmpdir(), 'proc-')), env: {}, limits: { ...base, wallTimeSeconds: 0.05 } }, new AbortController().signal);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('terminates on cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await runBoundedProcess({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: await mkdtemp(join(tmpdir(), 'proc-')), env: {}, limits: base }, controller.signal);
    expect(result).toMatchObject({ exitCode: null, cancelled: true });
  });

  it('stops and marks output overflow', async () => {
    const result = await runBoundedProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(4096))'], cwd: await mkdtemp(join(tmpdir(), 'proc-')), env: {}, limits: { ...base, outputBytes: 32 } }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32);
  });
});
