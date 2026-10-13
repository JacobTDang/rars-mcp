import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import { Workspace } from '../src/workspace.js';

type ListRoots = () => Promise<{ roots: Array<{ uri: string; name?: string }> }>;

function folders(roots: string[]): ListRoots {
  return async () => ({ roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: 'project' })) });
}

async function serve(listRoots: ListRoots) {
  const configured = await mkdtemp(join(tmpdir(), 'rars-configured-'));
  await writeFile(join(configured, 'prog.asm'), 'li a0, 1\n');
  const run = vi.fn(async () => ({
    exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false,
  }));
  const server = createMcpServer({
    workspace: await Workspace.create(configured), sessions: new SessionStore(), run,
    javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { roots: {} } });
  const answer = vi.fn(listRoots);
  client.setRequestHandler('roots/list', answer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const assemble = (file: string) => client.callTool({ name: 'rars_assemble', arguments: { files: [file] } });
  return { run, answer, assemble, close: async () => { await client.close(); await server.close(); } };
}

describe('client roots', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('accepts a file inside a folder the client advertises as a root', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    await writeFile(join(clientRoot, 'prog.asm'), 'li a0, 1\n');
    const session = await serve(folders([clientRoot]));
    close = session.close;

    const result = await session.assemble(join(clientRoot, 'prog.asm'));

    expect(result.isError).toBeFalsy();
    expect(session.run).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ files: [join(await realpath(clientRoot), 'prog.asm')] }),
    }));
  });

  it('still rejects a file outside every root', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'rars-outside-'));
    await writeFile(join(outside, 'secret.asm'), 'li a0, 1\n');
    const session = await serve(folders([clientRoot]));
    close = session.close;

    const result = await session.assemble(join(outside, 'secret.asm'));

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('outside the configured workspace folders');
  });

  it('skips a client root that does not exist and keeps serving the other folders', async () => {
    const deleted = join(await mkdtemp(join(tmpdir(), 'rars-client-root-')), 'deleted-project');
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    await writeFile(join(clientRoot, 'lib.asm'), 'li a0, 2\n');
    const session = await serve(folders([deleted, clientRoot]));
    close = session.close;

    const results = [
      await session.assemble('prog.asm'),
      await session.assemble('prog.asm'),
      await session.assemble(join(clientRoot, 'lib.asm')),
    ];

    for (const result of results) expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(session.answer).toHaveBeenCalledTimes(1);
  });

  it('refuses a file in a skipped client root and says why the root was skipped', async () => {
    const deleted = join(await mkdtemp(join(tmpdir(), 'rars-client-root-')), 'deleted-project');
    const session = await serve(folders([deleted]));
    close = session.close;

    const result = await session.assemble(join(deleted, 'prog.asm'));

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain(`Workspace path is in a client root that was skipped: ${join(deleted, 'prog.asm')}`);
    expect(text).toContain('ENOENT');
  });

  it('skips a client root on another host', async () => {
    const session = await serve(async () => ({ roots: [{ uri: 'file://otherhost/project' }] }));
    close = session.close;

    const result = await session.assemble('prog.asm');

    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  });

  it('reports a failed roots/list on that call and asks again on the next', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-client-root-'));
    await writeFile(join(clientRoot, 'lib.asm'), 'li a0, 2\n');
    let asked = 0;
    const session = await serve(async () => {
      asked += 1;
      if (asked === 1) throw new ProtocolError(ProtocolErrorCode.InternalError, 'roots are not ready');
      return folders([clientRoot])();
    });
    close = session.close;

    const failed = await session.assemble('prog.asm');
    const retried = await session.assemble('prog.asm');
    const inClientRoot = await session.assemble(join(clientRoot, 'lib.asm'));

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("Could not list the client's roots");
    expect(JSON.stringify(failed.content)).toContain('roots are not ready');
    expect(retried.isError, JSON.stringify(retried.content)).toBeFalsy();
    expect(inClientRoot.isError, JSON.stringify(inClientRoot.content)).toBeFalsy();
    expect(session.answer).toHaveBeenCalledTimes(2);
  });
});
