import { afterEach, describe, expect, it, vi } from 'vitest';

import { RarsError } from '../src/errors.js';
import { SessionStore } from '../src/sessions/store.js';
import type {
  DebugCommand,
  InspectRequest,
  LoadRequest,
  MachineState,
  ModifyRequest,
  SessionBackend,
  SessionSummary,
} from '../src/sessions/types.js';

function backend(name: string): SessionBackend {
  return {
    summary: async (): Promise<SessionSummary> => ({ kind: 'headless', state: 'paused', name }),
    command: async (_command: DebugCommand): Promise<MachineState> => ({ status: 'paused' }),
    inspect: async (_request: InspectRequest) => ({ status: 'paused' }),
    modify: async (_request: ModifyRequest): Promise<MachineState> => ({ status: 'paused' }),
    load: async (_request: LoadRequest): Promise<MachineState> => ({ status: 'paused' }),
    close: vi.fn(async () => undefined),
    onFailure: () => undefined,
  };
}

describe('SessionStore', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('closes a session after the idle limit and reports it as expired', async () => {
    vi.useFakeTimers();
    const target = backend('idle');
    const store = new SessionStore({ idleMs: 1000 });
    const id = store.add(target);

    await vi.advanceTimersByTimeAsync(999);
    expect(target.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(target.close).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
    expect(() => store.get(id)).toThrowError(expect.objectContaining({
      code: 'SESSION_EXPIRED', message: `Session ${id} was closed after 1000 ms without requests`,
    }));
  });

  it('keeps a session open while it receives requests', async () => {
    vi.useFakeTimers();
    const target = backend('busy');
    const store = new SessionStore({ idleMs: 1000 });
    const id = store.add(target);

    await vi.advanceTimersByTimeAsync(800);
    store.get(id);
    await vi.advanceTimersByTimeAsync(800);
    expect(target.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it('assigns unique opaque IDs and lists isolated summaries', async () => {
    const store = new SessionStore();
    const first = store.add(backend('first'));
    const second = store.add(backend('second'));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.list()).toEqual([
      { id: first, kind: 'headless', state: 'paused', name: 'first' },
      { id: second, kind: 'headless', state: 'paused', name: 'second' },
    ]);
  });

  it('removes a session whose backend fails and reports why to later requests', async () => {
    let fail!: (error: Error) => void;
    const target = backend('failing');
    target.onFailure = (listener) => { fail = listener; };
    const store = new SessionStore();
    const other = store.add(backend('other'));
    const id = store.add(target);

    fail(new RarsError('BRIDGE_DISCONNECTED', 'RARS bridge connection failed: read ECONNRESET'));

    expect(await store.list()).toEqual([{ id: other, kind: 'headless', state: 'paused', name: 'other' }]);
    expect(() => store.get(id)).toThrowError(expect.objectContaining({
      code: 'SESSION_FAILED', message: `Session ${id} failed: RARS bridge connection failed: read ECONNRESET`,
    }));
    await expect(store.close(id)).rejects.toMatchObject({ code: 'SESSION_FAILED' });
    // Closing it still releases what the session holds, such as a folder of inline source.
    await vi.waitFor(() => expect(target.close).toHaveBeenCalledTimes(1));
  });

  it('reports a stable error for a missing session', () => {
    expect(() => new SessionStore().get('missing')).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
  });

  it('closes each backend once even when closeAll is repeated', async () => {
    const first = backend('first');
    const second = backend('second');
    const store = new SessionStore();
    store.add(first);
    store.add(second);

    await store.closeAll();
    await store.closeAll();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
  });

  it('serializes mutations within one session', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = backend('queued');
    target.command = async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
      return { status: 'paused' };
    };
    target.modify = async () => {
      order.push('second');
      return { status: 'paused' };
    };
    const store = new SessionStore();
    const session = store.get(store.add(target));

    const first = session.command({ action: 'step' });
    const second = session.modify({ registers: { a0: '1' } });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('queues a load behind an earlier request, as other requests are', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = backend('loading');
    target.command = async () => {
      order.push('command-start');
      await gate;
      order.push('command-end');
      return { status: 'paused' };
    };
    target.load = async (request) => {
      order.push(`load ${request.files.join(' ')}`);
      return { status: 'ready' };
    };
    const store = new SessionStore();
    const session = store.get(store.add(target));

    const running = session.command({ action: 'continue' });
    const loaded = session.load({ files: ['/work/program.s'], conflictPolicy: 'reject' });
    await Promise.resolve();
    expect(order).toEqual(['command-start']);
    release();

    await expect(loaded).resolves.toEqual({ status: 'ready' });
    await running;
    expect(order).toEqual(['command-start', 'command-end', 'load /work/program.s']);
  });

  it('passes a pause on while an earlier command is still running, so it can stop that command', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = backend('running');
    target.command = async (command) => {
      order.push(command.action);
      if (command.action === 'continue') await gate;
      return { status: 'paused' };
    };
    const store = new SessionStore();
    const session = store.get(store.add(target));

    const running = session.command({ action: 'continue' });
    await Promise.resolve();
    await session.command({ action: 'pause' });

    expect(order).toEqual(['continue', 'pause']);
    release();
    await running;
  });
});
