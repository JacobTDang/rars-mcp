import { randomUUID } from 'node:crypto';

import { RarsError } from '../errors.js';
import type {
  DebugCommand,
  InspectRequest,
  InspectResult,
  MachineState,
  ModifyRequest,
  SessionBackend,
  SessionId,
  SessionSummary,
} from './types.js';

class QueuedBackend implements SessionBackend {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly target: SessionBackend) {}

  summary(): Promise<SessionSummary> {
    return this.enqueue(() => this.target.summary());
  }

  command(command: DebugCommand): Promise<MachineState> {
    return this.enqueue(() => this.target.command(command));
  }

  inspect(request: InspectRequest): Promise<InspectResult> {
    return this.enqueue(() => this.target.inspect(request));
  }

  modify(request: ModifyRequest): Promise<MachineState> {
    return this.enqueue(() => this.target.modify(request));
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.enqueue(() => this.target.close());
  }

  onFailure(listener: (error: Error) => void): void {
    this.target.onFailure(listener);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface SessionStoreOptions {
  // A session with no requests for this long is closed.
  idleMs?: number;
}

export class SessionStore {
  private readonly sessions = new Map<SessionId, QueuedBackend>();
  private readonly idleTimers = new Map<SessionId, NodeJS.Timeout>();
  private readonly expired = new Set<SessionId>();
  private readonly failures = new Map<SessionId, Error>();
  private readonly idleMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.idleMs = options.idleMs ?? 30 * 60 * 1000;
  }

  get size(): number {
    return this.sessions.size;
  }

  add(backend: SessionBackend): SessionId {
    const id = randomUUID();
    this.sessions.set(id, new QueuedBackend(backend));
    this.touch(id);
    backend.onFailure((error) => this.failed(id, error));
    return id;
  }

  get(id: SessionId): SessionBackend {
    const backend = this.sessions.get(id);
    if (!backend) {
      if (this.expired.has(id)) {
        throw new RarsError('SESSION_EXPIRED', `Session ${id} was closed after ${this.idleMs} ms without requests`, { id });
      }
      const failure = this.failures.get(id);
      if (failure) {
        throw new RarsError('SESSION_FAILED', `Session ${id} failed: ${failure.message}`, {
          id, ...(failure instanceof RarsError ? { cause: failure.code } : {}),
        });
      }
      throw new RarsError('SESSION_NOT_FOUND', `Session does not exist: ${id}`, { id });
    }
    this.touch(id);
    return backend;
  }

  async list(): Promise<SessionSummary[]> {
    return Promise.all(
      [...this.sessions].map(async ([id, backend]) => ({ ...(await backend.summary()), id })),
    );
  }

  async close(id: SessionId): Promise<void> {
    const backend = this.get(id);
    this.forget(id);
    await backend.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const id of [...this.sessions.keys()]) this.forget(id);
    await Promise.all(sessions.map((backend) => backend.close()));
  }

  // Restarts the idle timer. The timer never keeps the process alive on its own.
  private touch(id: SessionId): void {
    clearTimeout(this.idleTimers.get(id));
    const timer = setTimeout(() => {
      this.expired.add(id);
      this.close(id).catch((error: unknown) => {
        console.error(`Failed to close idle RARS session ${id}:`, error);
      });
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(id, timer);
  }

  // A session that stopped working by itself is removed at once, and its ID reports why. It is
  // still closed, to release what it holds, such as a folder of inline source.
  private failed(id: SessionId, error: Error): void {
    const backend = this.sessions.get(id);
    if (!backend) return;
    this.forget(id);
    this.failures.set(id, error);
    backend.close().catch((closeError: unknown) => {
      console.error(`Failed to close failed RARS session ${id}:`, closeError);
    });
  }

  private forget(id: SessionId): void {
    clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
    this.sessions.delete(id);
  }
}
