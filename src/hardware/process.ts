import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProcessResult, ProviderCommand } from './types.js';

export async function runBoundedProcess(command: ProviderCommand, abortSignal: AbortSignal): Promise<ProcessResult> {
  const started = Date.now();
  const usePrlimit = process.platform === 'linux';
  const executable = usePrlimit ? 'prlimit' : command.executable;
  const args = usePrlimit ? [`--as=${command.limits.memoryMb * 1024 * 1024}`, `--nproc=${command.limits.pids}`, '--', command.executable, ...command.args] : command.args;
  const child = spawn(executable, args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(command.runAs ? { uid: command.runAs.uid, gid: command.runAs.gid } : {}),
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let stopping = false;

  const stop = () => {
    if (stopping || child.pid === undefined) return;
    stopping = true;
    const pid = process.platform === 'win32' ? child.pid : -child.pid;
    try { process.kill(pid, 'SIGTERM'); } catch {}
    const force = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }, 100);
    force.unref();
  };
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    const used = stdout.byteLength + stderr.byteLength;
    const available = Math.max(0, command.limits.outputBytes - used);
    const kept = chunk.subarray(0, available);
    if (target === 'stdout') stdout = Buffer.concat([stdout, kept]);
    else stderr = Buffer.concat([stderr, kept]);
    if (kept.byteLength < chunk.byteLength || available === 0) {
      truncated = true;
      stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  const onAbort = () => { cancelled = true; stop(); };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  if (abortSignal.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; stop(); }, command.limits.wallTimeSeconds * 1000);
  timer.unref();
  const artifactTimer = command.artifactRoot ? setInterval(() => {
    void directoryBytes(command.artifactRoot as string).then((bytes) => {
      if (bytes > command.limits.artifactMb * 1024 * 1024) { truncated = true; stop(); }
    }).catch(() => undefined);
  }, 100) : undefined;
  artifactTimer?.unref();

  return await new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      if (artifactTimer) clearInterval(artifactTimer);
      abortSignal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (artifactTimer) clearInterval(artifactTimer);
      abortSignal.removeEventListener('abort', onAbort);
      resolve({
        exitCode, signal: signal as NodeJS.Signals | null,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        timedOut, cancelled, truncated, durationMs: Date.now() - started,
        executable: command.executable, args: [...command.args],
      });
    });
  });
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
