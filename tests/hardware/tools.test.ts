import { describe, expect, it, vi } from 'vitest';

import { createHardwareToolHandlers } from '../../src/hardware/tool-handlers.js';

describe('hardware MCP handlers', () => {
  it('starts asynchronous jobs and returns structured content', async () => {
    const client = { start: vi.fn(async () => ({ id: 'job-id', state: 'queued' })) };
    const handlers = createHardwareToolHandlers(client as never);
    const result = await handlers.jobStart({ manifestPath: 'hardware.project.yaml', target: 'unit' });
    expect(result.structuredContent).toEqual({ id: 'job-id', state: 'queued' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('job-id') });
  });

  it('reports disabled hardware clearly', async () => {
    const handlers = createHardwareToolHandlers(undefined);
    await expect(handlers.capabilities({})).rejects.toThrow(/not enabled/i);
  });
});
