import { spawn } from 'node:child_process';

export interface CliRequest {
  mode: 'assemble' | 'run';
  files: string[];
  programArgs?: string[];
  stdin?: string;
  maxSteps?: number;
  instructionCount?: boolean;
  registers?: string[];
  memoryRanges?: string[];
  dumps?: { segment: string; format: string; file: string }[];
}

export interface RunRarsOptions {
  javaExecutable: string;
  rarsJar: string;
  cwd: string;
  request: CliRequest;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function buildRarsArgs(request: CliRequest): string[] {
  const options = ['nc', 'me'];
  if (request.mode === 'assemble') options.push('a');
  if (request.maxSteps !== undefined) options.push(String(request.maxSteps));
  if (request.instructionCount) options.push('ic');
  options.push(...(request.registers ?? []), ...(request.memoryRanges ?? []));
  for (const dump of request.dumps ?? []) options.push('dump', dump.segment, dump.format, dump.file);
  options.push(...request.files);
  if (request.programArgs?.length) options.push('pa', ...request.programArgs);
  return options;
}

export function runRars(options: RunRarsOptions): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.javaExecutable,
      ['-jar', options.rarsJar, ...buildRarsArgs(options.request)],
      { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
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
    child.once('error', reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const abort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        truncated,
      });
    });

    child.stdin.end(options.request.stdin ?? '');
  });
}
