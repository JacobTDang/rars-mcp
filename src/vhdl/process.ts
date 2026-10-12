import { spawn } from 'node:child_process';

import { RarsError } from '../errors.js';

export interface SimulatorProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SimulatorProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

// Kills the simulator when it runs past timeoutMs or prints more than maxOutputBytes.
export function runSimulatorProcess(options: SimulatorProcessOptions): Promise<SimulatorProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let truncated = false;

    const capture = (destination: Buffer[]) => (chunk: Buffer) => {
      const remaining = options.maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      destination.push(chunk.subarray(0, remaining));
      capturedBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(error.code === 'ENOENT'
        ? new RarsError('INVALID_CONFIGURATION', `VHDL simulator not found: ${options.executable}. Install nvc or set VHDL_SIMULATOR`, {
          executable: options.executable,
        })
        : error);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        truncated,
      });
    });
  });
}
