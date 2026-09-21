import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, type Transport } from '@modelcontextprotocol/client';

import { startStdioServer } from '../src/stdio.js';

type Message = Parameters<Transport['send']>[0];

// Newline-delimited JSON-RPC over a pair of streams, the same framing stdio uses.
class StreamTransport implements Transport {
  onmessage?: (message: Message) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  constructor(private readonly input: Readable, private readonly output: Writable) {}
  async start(): Promise<void> {
    createInterface({ input: this.input, crlfDelay: Infinity }).on('line', (line) => this.onmessage?.(JSON.parse(line) as Message));
  }
  async send(message: Message): Promise<void> { this.output.write(`${JSON.stringify(message)}\n`); }
  async close(): Promise<void> { this.onclose?.(); }
}

async function connect(workspace: string) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = await startStdioServer({ env: { RARS_WORKSPACE: workspace }, input: toServer, output: toClient });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamTransport(toClient, toServer));
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('stdio server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('serves the RARS tools without an HTTP server', async () => {
    const connection = await connect(await mkdtemp(join(tmpdir(), 'rars-stdio-')));
    close = connection.close;

    const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['rars_run', 'rars_debug_start', 'rars_inspect']));
  });

  it.runIf(process.env.RARS_JAR)('runs a program', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rars-stdio-'));
    await copyFile('tests/fixtures/hello.asm', join(workspace, 'hello.asm'));
    const connection = await connect(workspace);
    close = connection.close;

    const result = await connection.client.callTool({ name: 'rars_run', arguments: { files: ['hello.asm'] } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ stdout: 'hello from rars\n', exitCode: 0 });
  });
});
