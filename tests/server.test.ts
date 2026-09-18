import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';

const sessionId = '00000000-0000-4000-8000-000000000000';

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({} as never);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('MCP server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('advertises the headless tools', async () => {
    const connection = await connect();
    close = connection.close;

    const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'rars_assemble', 'rars_run', 'rars_session_list', 'rars_session_close',
    ]));
  });

  it('publishes every debug action in a flat top-level schema', async () => {
    const connection = await connect();
    close = connection.close;

    const tool = (await connection.client.listTools()).tools.find((item) => item.name === 'rars_debug_command');
    const schema = tool?.inputSchema as Record<string, unknown>;
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        action: { enum: ['step', 'backstep', 'continue', 'pause', 'reset', 'terminate', 'breakpoint_add', 'breakpoint_remove'] },
        address: { type: 'string' },
      },
      required: ['sessionId', 'action'],
    });
  });

  it('rejects an address on a debug action that does not use one', async () => {
    const connection = await connect();
    close = connection.close;

    const result = await connection.client.callTool({
      name: 'rars_debug_command', arguments: { sessionId, action: 'continue', address: '0x00400020' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('address is only valid for breakpoint_add and breakpoint_remove');
  });

  it('requires an address for breakpoint actions', async () => {
    const connection = await connect();
    close = connection.close;

    const result = await connection.client.callTool({
      name: 'rars_debug_command', arguments: { sessionId, action: 'breakpoint_add' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('address is required for breakpoint_add');
  });
});
