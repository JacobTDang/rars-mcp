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
});
