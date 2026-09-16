import { describe, expect, it, vi } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import type {
  DebugCommand,
  InspectRequest,
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
    close: vi.fn(async () => undefined),
  };
}

describe('SessionStore', () => {
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
});
