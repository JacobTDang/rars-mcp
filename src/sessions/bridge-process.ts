import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { RarsError } from '../errors.js';

// The most output kept from each stream while the bridge starts, for the error message.
const startupOutputLimit = 64 * 1024;

// On POSIX the bridge leads its own process group, so one signal reaches it and everything it
// started. Windows has no process groups; there only the bridge process is signalled.
const ownGroup = process.platform !== 'win32';

// A bridge in its own group does not get the Ctrl-C that a terminal sends to this process, so
// every bridge still running when this process exits is killed then.
const running = new Set<ChildProcess>();
let killOnExit = false;

export function spawnBridge(executable: string, args: string[]): ChildProcess {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: ownGroup });
  if (!killOnExit) {
    process.once('exit', () => { for (const bridge of running) signalBridge(bridge, 'SIGKILL'); });
    killOnExit = true;
  }
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

export interface BridgeStartup {
  // Resolves with the port from the bridge's ready line.
  readonly port: Promise<number>;
  // Settles as promise does, unless the limit passes or the bridge exits first.
  within<T>(promise: Promise<T>): Promise<T>;
  // The bridge started: stop the limit and the capture.
  finish(): void;
  // The bridge did not start: kill it and everything it started, and wait for it to exit.
  abort(): Promise<void>;
}

// One limit covers the whole start, and a failure reports what the bridge printed so far.
export function watchStartup(child: ChildProcess, timeoutMs: number): BridgeStartup {
  const stdout = captureStream(child.stdout!);
  const stderr = captureStream(child.stderr!);
  const output = () => ({ stdout: stdout.text(), stderr: stderr.text() });
  const report = () => `${section('stdout', stdout.text())}\n${section('stderr', stderr.text())}`;

  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  const timer = setTimeout(() => fail(new RarsError(
    'BRIDGE_START_TIMEOUT', `RARS bridge did not start within ${timeoutMs} ms\n${report()}`, { timeoutMs, ...output() },
  )), timeoutMs);
  const onError = (error: Error) => fail(error);
  // close, not exit: it comes once the output is read to the end.
  const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => fail(new RarsError(
    'BRIDGE_START_FAILED', `RARS bridge exited during startup ${describeExit(exitCode, signal)}\n${report()}`,
    { exitCode, signal, ...output() },
  ));
  child.once('error', onError);
  child.once('close', onClose);

  const lines = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  lines.on('error', onError);
  const port = new Promise<number>((resolve) => {
    lines.on('line', (line) => {
      const match = line.match(/^RARS_MCP_PORT=(\d+)$/);
      if (match) resolve(Number(match[1]));
    });
  });

  const stopWatching = () => {
    clearTimeout(timer);
    child.off('error', onError);
    child.off('close', onClose);
    lines.close();
    stdout.stop();
    stderr.stop();
  };

  return {
    port,
    within: (promise) => Promise.race([promise, failed]),
    finish: stopWatching,
    async abort() {
      stopWatching();
      await stopBridge(child);
    },
  };
}

// "with code 3" or "on signal SIGKILL".
export function describeExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  return exitCode === null ? `on signal ${signal}` : `with code ${exitCode}`;
}

// Kills the bridge and everything it started, and waits for the bridge to exit.
export async function stopBridge(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signalBridge(child, 'SIGKILL');
  await exited;
}

function captureStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (chunk: Buffer) => {
    const room = startupOutputLimit - size;
    if (room > 0) chunks.push(chunk.subarray(0, room));
    size += chunk.length;
  };
  stream.on('data', onData);
  return {
    text(): string {
      const kept = Buffer.concat(chunks).toString('utf8');
      return size > startupOutputLimit ? `${kept}\n[cut at ${startupOutputLimit} of ${size} bytes]` : kept;
    },
    // Later output is not kept, but the stream is still read so the bridge never blocks on a full pipe.
    stop(): void {
      stream.off('data', onData);
      stream.resume();
    },
  };
}

function section(name: string, text: string): string {
  return text === '' ? `${name}: (none)` : `${name}:\n${text.trimEnd()}`;
}

function signalBridge(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (!ownGroup) {
    child.kill(signal);
    return;
  }
  try {
    sendSignal(-child.pid, signal);
  } catch (error) {
    // macOS refuses a group whose processes have all exited but are not yet reaped. The
    // bridge itself still takes the signal then, and nothing else in the group is running.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    sendSignal(child.pid, signal);
  }
}

// ESRCH means the process or group is already gone, which is what the signal is for.
function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
