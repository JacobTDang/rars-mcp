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

const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

// The registers RARS 1.6 prints at the end of a run. This list came from running
// `java -jar rars1_6.jar nc me <name> prog.s` for x0-x31, f0-f31 and every name in the jar's
// RegisterFile, FloatingPointRegisterFile and ControlAndStatusRegisterFile: each of these prints
// "<name>\t0x...". pc, hi, lo and upper-case names get "Invalid Command Argument" instead.
export const CLI_REGISTERS: readonly string[] = [
  ...numbered('x', 32),
  'zero', 'ra', 'sp', 'gp', 'tp', 'fp', ...numbered('t', 7), ...numbered('s', 12), ...numbered('a', 8),
  ...numbered('f', 32), ...numbered('ft', 12), ...numbered('fs', 12), ...numbered('fa', 8),
  'ustatus', 'fflags', 'frm', 'fcsr', 'uie', 'utvec', 'uscratch', 'uepc', 'ucause', 'utval', 'uip',
  'cycle', 'time', 'instret', 'cycleh', 'timeh', 'instreth',
];
const cliRegisters = new Set(CLI_REGISTERS);
export const CLI_REGISTER_FORMS = 'x0-x31, zero, ra, sp, gp, tp, fp, t0-t6, s0-s11, a0-a7, f0-f31, ft0-ft11, fs0-fs11, '
  + 'fa0-fa7, or a CSR such as fcsr or cycle';

// Each entry is checked, as RARS reads one that is not a register or range it prints as another option, such as dump.
export function registerProblem(name: string): string | undefined {
  if (cliRegisters.has(name)) return undefined;
  if (name === 'pc') return '"pc" is not printed by the RARS command line; read it with rars_inspect in a rars_debug_start session';
  return `${JSON.stringify(name)} is not a register RARS prints; use ${CLI_REGISTER_FORMS}`;
}

const MEMORY_RANGE = /^0x([0-9a-fA-F]+)-0x([0-9a-fA-F]+)$/;

// RARS prints a range with both ends included. It reads each end as a signed 32-bit number, so it
// also refuses a range that starts below 0x80000000 and ends at or above it.
export function memoryRangeProblem(range: string): string | undefined {
  const quoted = JSON.stringify(range);
  const match = MEMORY_RANGE.exec(range);
  if (match === null) return `${quoted} is not a memory range such as 0x10010000-0x1001000c`;
  const low = BigInt(`0x${match[1]}`);
  const high = BigInt(`0x${match[2]}`);
  if (low > 0xffffffffn || high > 0xffffffffn) return `${quoted} has an address above 0xffffffff`;
  if (low % 4n !== 0n || high % 4n !== 0n) return `${quoted} must start and end on a word boundary, a multiple of 4`;
  if (low > high) return `${quoted} must give the lower address first`;
  if (low < 0x80000000n && high >= 0x80000000n) {
    return `${quoted} spans 0x80000000, which RARS refuses; ask for the parts below and above it separately`;
  }
  return undefined;
}

export function buildRarsArgs(request: CliRequest): string[] {
  // Checked again here because a direct handler call does not pass through the tool schema.
  const problem = [...(request.registers ?? []).map(registerProblem), ...(request.memoryRanges ?? []).map(memoryRangeProblem)]
    .find((item) => item !== undefined);
  if (problem !== undefined) throw new Error(problem);
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
