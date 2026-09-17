import { spawn } from 'node:child_process';

import type { ProcessResult, ProviderCommand } from './types.js';

export async function runBoundedProcess(command: ProviderCommand, abortSignal: AbortSignal): Promise<ProcessResult> {
  const started = Date.now();
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
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

  return await new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
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
