import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import { Workspace } from '../src/workspace.js';

async function serve(roots: string[]) {
  const configured = await mkdtemp(join(tmpdir(), 'rars-configured-'));
  const run = vi.fn(async () => ({
    exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false,
  }));
  const server = createMcpServer({
    workspace: await Workspace.create(configured), sessions: new SessionStore(), run,
    javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { roots: {} } });
  client.setRequestHandler('roots/list', async () => ({
    roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: 'project' })),
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, run, configured, close: async () => { await client.close(); await server.close(); } };
}

describe('client roots', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('accepts a file inside a folder the client advertises as a root', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    await writeFile(join(clientRoot, 'prog.asm'), 'li a0, 1\n');
    const session = await serve([clientRoot]);
    close = session.close;

    const result = await session.client.callTool({
      name: 'rars_assemble', arguments: { files: [join(clientRoot, 'prog.asm')] },
    });

    expect(result.isError).toBeFalsy();
    expect(session.run).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ files: [join(await realpath(clientRoot), 'prog.asm')] }),
    }));
  });

  it('still rejects a file outside every root', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'rars-outside-'));
    await writeFile(join(outside, 'secret.asm'), 'li a0, 1\n');
    const session = await serve([clientRoot]);
    close = session.close;

    const result = await session.client.callTool({
      name: 'rars_assemble', arguments: { files: [join(outside, 'secret.asm')] },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('outside the configured workspace folders');
  });
});
