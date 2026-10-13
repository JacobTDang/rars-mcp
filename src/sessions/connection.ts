import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

import { RarsError } from '../errors.js';

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code?: string; message: string };
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface BridgeConnectionOptions {
  // Starts every message, such as "RARS bridge" or "Live RARS".
  name: string;
  timeoutMs: number;
  // Called once if the connection breaks, with the error to fail it with; the owner then calls
  // fail. Without it, the connection fails at once.
  onDisconnect?(failure: RarsError): void;
}

// One newline-delimited JSON connection to a bridge, with replies matched to requests by id.
// When the connection fails, every waiting and later request fails with the same error, and
// the failure listeners are told; nothing is thrown where it would take the process down.
export class BridgeConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly failureListeners: Array<(error: Error) => void> = [];
  private failure: Error | undefined;
  private closedError: Error | undefined;
  private broken = false;
  // The bridge hands each piece of program output over once, in its next reply. Output in a reply
  // nobody waits for, to a request that timed out or the pause sent after it, goes in the next
  // reply that is waited for.
  private readonly timedOut = new Set<string>();
  private unclaimed = { stdout: '', stderr: '' };

  constructor(private readonly socket: Socket, private readonly options: BridgeConnectionOptions) {
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    // readline passes each socket error on to the interface, so both need a handler.
    const failed = (error: Error) => this.disconnected(error);
    socket.on('error', failed);
    lines.on('error', failed);
    socket.on('close', () => this.disconnected(undefined));
  }

  request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { name, timeoutMs } = this.options;
    const what = command === 'command' ? String(payload.action) : command;
    // Output starts again from a load or a reset, so what an earlier run wrote is not added to it.
    const restartsOutput = command === 'load' || what === 'reset';
    return this.send(command, payload, () => {
      this.interrupt();
      return new RarsError('BRIDGE_TIMEOUT', `${name} request timed out after ${timeoutMs} ms: ${what}. `
        + 'A pause was sent, so the session can take further requests.', { timeoutMs });
    }).then((result) => this.claimOutput(result, restartsOutput));
  }

  onFailure(listener: (error: Error) => void): void {
    if (this.failure) listener(this.failure);
    else this.failureListeners.push(listener);
  }

  // Fails every waiting and later request with error. Only the first failure counts.
  fail(error: Error): void {
    if (this.failure || this.closedError) return;
    this.failure = error;
    this.rejectPending(error);
    this.socket.destroy();
    for (const listener of this.failureListeners.splice(0)) listener(error);
  }

  // Ends the connection on purpose: waiting and later requests fail with message.
  close(message: string): void {
    if (this.failure || this.closedError) return;
    this.closedError = new Error(message);
    this.rejectPending(this.closedError);
    this.socket.end();
  }

  // timedOut makes the error for a request that gets no reply in time.
  private send(command: string, payload: Record<string, unknown>, timedOut: () => Error): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closedError) return Promise.reject(this.closedError);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOut.add(id);
        reject(timedOut());
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ protocolVersion: 1, id, command, payload })}\n`);
    });
  }

  // The bridge answers one request at a time, so a request that timed out still holds it. A pause
  // stops a continue that is still running, and its late reply is ignored. A bridge that does not
  // answer the pause either has stopped answering, and the connection fails.
  private interrupt(): void {
    const { name, timeoutMs } = this.options;
    const unanswered = new RarsError('BRIDGE_TIMEOUT',
      `${name} stopped answering: a request and the pause sent after it both timed out after ${timeoutMs} ms`, { timeoutMs });
    this.send('command', { action: 'pause' }, () => unanswered).then((result) => this.keepOutput(result), (error: unknown) => {
      // Any other result needs nothing: a reply, even an error, shows the bridge answers again,
      // and a connection that failed or closed meanwhile has reported that already.
      if (error === unanswered) this.fail(unanswered);
    });
  }

  private keepOutput(result: Record<string, unknown>): void {
    if (typeof result.stdout === 'string') this.unclaimed.stdout += result.stdout;
    if (typeof result.stderr === 'string') this.unclaimed.stderr += result.stderr;
  }

  private claimOutput(result: Record<string, unknown>, restartsOutput: boolean): Record<string, unknown> {
    const { stdout, stderr } = this.unclaimed;
    if (restartsOutput) this.unclaimed = { stdout: '', stderr: '' };
    if (restartsOutput || (stdout === '' && stderr === '')) return result;
    if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') return result;
    this.unclaimed = { stdout: '', stderr: '' };
    return { ...result, stdout: stdout + result.stdout, stderr: stderr + result.stderr };
  }

  private disconnected(error: Error | undefined): void {
    if (this.failure || this.closedError || this.broken) return;
    this.broken = true;
    const { name, onDisconnect } = this.options;
    const failure = error === undefined
      ? new RarsError('BRIDGE_DISCONNECTED', `${name} connection closed`)
      : new RarsError('BRIDGE_DISCONNECTED', `${name} connection failed: ${error.message}`, {
        cause: (error as NodeJS.ErrnoException).code ?? error.message,
      });
    if (onDisconnect) onDisconnect(failure);
    else this.fail(failure);
  }

  private receive(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch {
      this.fail(new RarsError('BRIDGE_PROTOCOL_ERROR', `${this.options.name} sent a line that is not JSON: ${line.slice(0, 200)}`));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      if (this.timedOut.delete(response.id) && response.ok) this.keepOutput(response.result ?? {});
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.ok) pending.reject(new Error(response.error?.message ?? `${this.options.name} request failed`));
    else pending.resolve(response.result ?? {});
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
