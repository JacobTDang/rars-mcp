import { createServer } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

describe('live tools', () => {
  it('discovers, connects, commands, and disconnects without closing the bridge', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().trim().split('\n')) {
          const request = JSON.parse(line);
          socket.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result:
            request.command === 'hello' ? { protocolVersion: 1, mode: 'live' } : { status: 'paused' } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const discovery = await mkdtemp(join(tmpdir(), 'rars-live-'));
    await writeFile(join(discovery, 'token'), 'secret\n');
    await writeFile(join(discovery, 'port'), String((server.address() as { port: number }).port));
    const root = await mkdtemp(join(tmpdir(), 'rars-live-workspace-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => { throw new Error('unused'); },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
      bridgeHost: '127.0.0.1', liveDiscoveryDir: discovery,
    });
    const connected = await handlers.liveConnect({});
    const sessionId = (connected.structuredContent as Record<string, unknown>).sessionId as string;
    await handlers.liveCommand({ sessionId, command: { action: 'step' } });
    await handlers.sessionClose({ sessionId });
    expect(connections).toBe(1);
    expect(server.listening).toBe(true);
    server.close();
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
