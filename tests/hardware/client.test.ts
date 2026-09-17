import { describe, expect, it, vi } from 'vitest';

import { HardwareClient } from '../../src/hardware/client.js';

describe('hardware worker client', () => {
  it('sends bearer authentication and returns JSON', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return Response.json({ providers: [] });
    });
    const client = new HardwareClient({ baseUrl: 'http://worker', token: 'secret', timeoutMs: 1000, fetchImpl });
    await expect(client.capabilities()).resolves.toEqual({ providers: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('translates unavailable workers and structured errors', async () => {
    const unavailable = new HardwareClient({ baseUrl: 'http://worker', token: 'secret', timeoutMs: 1000, fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    await expect(unavailable.capabilities()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    const rejected = new HardwareClient({ baseUrl: 'http://worker', token: 'secret', timeoutMs: 1000, fetchImpl: vi.fn(async () => Response.json({ code: 'INVALID_PROJECT', message: 'bad manifest' }, { status: 400 })) });
    await expect(rejected.validate({ manifestPath: 'hardware.project.yaml' })).rejects.toMatchObject({ code: 'INVALID_PROJECT' });
  });
});
