import { createServer } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

// A live bridge that answers every request with a paused state and keeps each request it receives.
async function fakeLiveBridge() {
  const bridge = { connections: 0, requests: [] as Array<{ command: string; payload: Record<string, unknown> }> };
  const server = createServer((socket) => {
    bridge.connections++;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        bridge.requests.push({ command: request.command, payload: request.payload });
        socket.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result:
          request.command === 'hello' ? { protocolVersion: 1, mode: 'live' } : { status: 'paused' } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const discovery = await mkdtemp(join(tmpdir(), 'rars-live-'));
  await writeFile(join(discovery, 'token'), 'secret\n');
  await writeFile(join(discovery, 'port'), String((server.address() as { port: number }).port));
  return Object.assign(bridge, { server, discovery });
}

async function liveHandlers(discovery: string) {
  const workspace = await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-live-workspace-')));
  const handlers = createToolHandlers({
    workspace, sessions: new SessionStore(), run: async () => { throw new Error('unused'); },
    javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    bridgeHost: '127.0.0.1', liveDiscoveryDir: discovery,
  });
  return { workspace, handlers };
}

describe('live tools', () => {
  it('discovers, connects, commands, and disconnects without closing the bridge', async () => {
    const bridge = await fakeLiveBridge();
    const { handlers } = await liveHandlers(bridge.discovery);
    const connected = await handlers.liveConnect({});
    const sessionId = (connected.structuredContent as Record<string, unknown>).sessionId as string;
    await handlers.liveCommand({ sessionId, command: { action: 'step' } });
    await handlers.sessionClose({ sessionId });
    expect(bridge.connections).toBe(1);
    expect(bridge.server.listening).toBe(true);
    bridge.server.close();
  });

  it('loads a program into the live session', async () => {
    const bridge = await fakeLiveBridge();
    const { workspace, handlers } = await liveHandlers(bridge.discovery);
    await writeFile(join(workspace.root, 'program.s'), '.text\nmain:\n  li a7, 10\n  ecall\n');
    const connected = await handlers.liveConnect({});
    const sessionId = (connected.structuredContent as Record<string, unknown>).sessionId as string;

    const loaded = await handlers.liveCommand({
      sessionId, command: { action: 'load', files: ['program.s'], conflictPolicy: 'discard', programArgs: ['one'], stdin: 'input\n' },
    });

    expect(loaded.structuredContent).toEqual({ status: 'paused' });
    expect(bridge.requests.filter(({ command }) => command === 'load')).toEqual([{ command: 'load', payload: {
      files: [await workspace.resolve('program.s')], conflictPolicy: 'discard', programArgs: ['one'], stdin: 'input\n',
    } }]);
    await handlers.sessionClose({ sessionId });
    bridge.server.close();
  });

  it('says the discovery files are stale when nothing answers on the port', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const discovery = await mkdtemp(join(tmpdir(), 'rars-live-'));
    await writeFile(join(discovery, 'token'), 'secret\n');
    await writeFile(join(discovery, 'port'), String(port));
    const root = await mkdtemp(join(tmpdir(), 'rars-live-workspace-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => { throw new Error('unused'); },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
      bridgeHost: '127.0.0.1', liveDiscoveryDir: discovery,
    });

    await expect(handlers.liveConnect({})).rejects.toThrow(
      `The discovery files in ${discovery} point at a RARS desktop session that is no longer running `
      + `(connection refused on 127.0.0.1:${port}). Start the desktop launcher again.`,
    );
  });

  it('refuses to connect when no bridge host is configured', async () => {
    const discovery = await mkdtemp(join(tmpdir(), 'rars-live-'));
    const root = await mkdtemp(join(tmpdir(), 'rars-live-workspace-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => { throw new Error('unused'); },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
      liveDiscoveryDir: discovery,
    });
    await expect(handlers.liveConnect({})).rejects.toThrow('Live RARS bridge host is not configured');
  });
});
