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
}

// One newline-delimited JSON connection to a bridge, with replies matched to requests by id.
// When the connection fails, every waiting and later request fails with the same error, and
// the failure listeners are told; nothing is thrown where it would take the process down.
export class BridgeConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly failureListeners: Array<(error: Error) => void> = [];
  private failure: Error | undefined;
  private closedError: Error | undefined;

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
    if (this.failure) return Promise.reject(this.failure);
    if (this.closedError) return Promise.reject(this.closedError);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.options.name} request timed out: ${command}`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ protocolVersion: 1, id, command, payload })}\n`);
    });
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

  private disconnected(error: Error | undefined): void {
    if (this.failure || this.closedError) return;
    const { name } = this.options;
    this.fail(error === undefined
      ? new RarsError('BRIDGE_DISCONNECTED', `${name} connection closed`)
      : new RarsError('BRIDGE_DISCONNECTED', `${name} connection failed: ${error.message}`, {
        cause: (error as NodeJS.ErrnoException).code ?? error.message,
      }));
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
    if (!pending) return;
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
