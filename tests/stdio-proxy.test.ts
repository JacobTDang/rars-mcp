import { describe, expect, it } from 'vitest';

import { parseSseResponse } from '../src/stdio-proxy.js';

describe('stdio proxy response parsing', () => {
  it('extracts JSON-RPC messages from an SSE response', async () => {
    const response = new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    await expect(parseSseResponse(response)).resolves.toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
    ]);
  });

  it('accepts a plain JSON response', async () => {
    const response = Response.json({ jsonrpc: '2.0', id: 1, result: {} });
    await expect(parseSseResponse(response)).resolves.toHaveLength(1);
  });
});
