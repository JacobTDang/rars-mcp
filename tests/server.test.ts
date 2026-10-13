import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { Workspace } from '../src/workspace.js';

const sessionId = '00000000-0000-4000-8000-000000000000';

async function connect(workspace?: Workspace) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ workspace: workspace ?? await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-server-'))) } as never);
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
      'rars_assemble', 'rars_run', 'rars_session_list', 'rars_session_close', 'rars_status',
    ]));
  });

  it('lists the workspace folders in its instructions', async () => {
    const workspace = await Workspace.create(
      await mkdtemp(join(tmpdir(), 'rars-server-')), await mkdtemp(join(tmpdir(), 'rars-server-')),
    );
    const connection = await connect(workspace);
    close = connection.close;

    const instructions = connection.client.getInstructions() ?? '';
    for (const root of workspace.roots) expect(instructions).toContain(root);
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

  it('rejects an unaligned dump address in rars_run', async () => {
    const connection = await connect();
    close = connection.close;

    const result = await connection.client.callTool({
      name: 'rars_run',
      arguments: { files: ['prog.s'], dump: [{ segment: { address: '0x10010001', words: 2 }, format: 'HexText' }] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('dump address 0x10010001 is not word aligned');
    expect(JSON.stringify(result.content)).not.toContain('ENOENT');
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

  it('accepts maxSteps only for continue', async () => {
    const connection = await connect();
    close = connection.close;

    const result = await connection.client.callTool({
      name: 'rars_debug_command', arguments: { sessionId, action: 'step', maxSteps: 10 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('maxSteps is only valid for continue');
  });

  it('publishes the instruction window and marks includeInstructions as deprecated', async () => {
    const connection = await connect();
    close = connection.close;

    const tool = (await connection.client.listTools()).tools.find((item) => item.name === 'rars_inspect');
    const schema = tool?.inputSchema as { properties: Record<string, { type?: string; description?: string; properties?: object }> };
    expect(schema.properties.instructions).toMatchObject({ type: 'object', properties: { around: {}, count: {}, from: {}, to: {} } });
    expect(schema.properties.includeInstructions?.description).toMatch(/^Deprecated/);
  });

  it('rejects an invalid instruction window', async () => {
    const connection = await connect();
    close = connection.close;

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ includeInstructions: true, instructions: {} }, 'includeInstructions and instructions cannot be combined'],
      [{ instructions: { around: 'main', from: 'main', to: 'end' } }, 'instructions takes around and count, or both from and to'],
      [{ instructions: { from: 'main' } }, 'instructions takes around and count, or both from and to'],
      [{ instructions: { count: 201 } }, '200'],
      [{ instructions: { count: 0 } }, '1'],
      [{ instructions: { arround: 'pc' } }, 'arround'],
    ];
    for (const [input, message] of cases) {
      const result = await connection.client.callTool({ name: 'rars_inspect', arguments: { sessionId, ...input } });
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.stringify(result.content), JSON.stringify(input)).toContain(message);
    }
  });

  it('publishes rars_encode with a bounded list of instructions', async () => {
    const connection = await connect();
    close = connection.close;

    const tool = (await connection.client.listTools()).tools.find((item) => item.name === 'rars_encode');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { instructions: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string' } } },
      required: ['instructions'],
    });
  });

  it('rejects an empty, oversized or multi-line instruction list', async () => {
    const connection = await connect();
    close = connection.close;

    const cases: Array<[string[], string]> = [
      [[], '1'],
      [Array<string>(201).fill('nop'), '200'],
      [['nop', 'nop\nnop'], 'An instruction must fit on one line'],
      [['nop', ''], 'An instruction cannot be empty'],
    ];
    for (const [instructions, message] of cases) {
      const result = await connection.client.callTool({ name: 'rars_encode', arguments: { instructions } });
      expect(result.isError, JSON.stringify(instructions)).toBe(true);
      expect(JSON.stringify(result.content), JSON.stringify(instructions)).toContain(message);
    }
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
