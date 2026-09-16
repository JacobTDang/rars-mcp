import { randomUUID } from 'node:crypto';

import { RarsError } from '../errors.js';
import type {
  DebugCommand,
  InspectRequest,
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

  inspect(request: InspectRequest): Promise<unknown> {
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class SessionStore {
  private readonly sessions = new Map<SessionId, QueuedBackend>();

  add(backend: SessionBackend): SessionId {
    const id = randomUUID();
    this.sessions.set(id, new QueuedBackend(backend));
    return id;
  }

  get(id: SessionId): SessionBackend {
    const backend = this.sessions.get(id);
    if (!backend) {
      throw new RarsError('SESSION_NOT_FOUND', `Session does not exist: ${id}`, { id });
    }
    return backend;
  }

  async list(): Promise<SessionSummary[]> {
    return Promise.all(
      [...this.sessions].map(async ([id, backend]) => ({ ...(await backend.summary()), id })),
    );
  }

  async close(id: SessionId): Promise<void> {
    const backend = this.get(id);
    this.sessions.delete(id);
    await backend.close();
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((backend) => backend.close()));
  }
}
