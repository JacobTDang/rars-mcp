import { createServer } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { parseSseResponse, proxyStdio } from '../src/stdio-proxy.js';

async function closedEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

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

describe('stdio proxy errors', () => {
  it('names the endpoint and the cause when the HTTP server is unreachable', async () => {
    const endpoint = await closedEndpoint();
    const input = Readable.from([`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`]);
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => { written += String(chunk); });

    await proxyStdio(endpoint, input, output);

    const reply = JSON.parse(written) as { id: number; error: { code: number; message: string } };
    expect(reply).toMatchObject({ id: 7, error: { code: -32603 } });
    expect(reply.error.message).toBe(`MCP proxy request to ${endpoint} failed: fetch failed (ECONNREFUSED)`);
  });

  it('falls back to the cause message when the cause has no code', async () => {
    const endpoint = 'http://127.0.0.1:1/mcp';
    const input = Readable.from([`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })}\n`]);
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => { written += String(chunk); });

    await proxyStdio(endpoint, input, output);

    const reply = JSON.parse(written) as { error: { message: string } };
    expect(reply.error.message).toBe(`MCP proxy request to ${endpoint} failed: fetch failed (bad port)`);
  });
});
