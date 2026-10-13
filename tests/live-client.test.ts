import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LiveClient } from '../src/live/client.js';
import { discoverLiveSession } from '../src/live/discovery.js';

// With resetOnCommand, a debug command resets the connection instead of being answered; with
// garbageOnCommand, it is answered with a line that is not JSON.
async function fakeBridge(token: string, mode = 'live', { resetOnCommand = false, garbageOnCommand = false } = {}) {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n');
        const request = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (resetOnCommand && request.command === 'command') {
          socket.resetAndDestroy();
          return;
        }
        if (garbageOnCommand && request.command === 'command') {
          socket.write('#@! not json\n');
          continue;
        }
        const authenticated = request.command === 'hello' && request.payload.token === token;
        const result = request.command === 'hello'
          ? { protocolVersion: 1, mode }
          : request.command === 'inspect' ? { status: 'paused', registers: { a0: 7 }, ...(request.payload.includeSymbols ? { symbols: [] } : {}), ...(request.payload.includeInstructions ? { instructions: [] } : {}), ...(request.payload.instructions ? { window: request.payload.instructions } : {}) }
          : { status: 'paused' };
        socket.write(`${JSON.stringify(authenticated || request.command !== 'hello'
          ? { protocolVersion: 1, id: request.id, ok: true, result }
          : { protocolVersion: 1, id: request.id, ok: false, error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid bridge token' } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

describe('LiveClient', () => {
  it('authenticates and controls a live bridge', async () => {
    const bridge = await fakeBridge('secret');
    const client = await LiveClient.connect({ host: '127.0.0.1', port: bridge.port, token: 'secret', timeoutMs: 1000 });
    expect(await client.inspect({ registers: ['a0'] })).toMatchObject({ registers: { a0: 7 } });
    expect(await client.inspect({ includeSymbols: true })).toHaveProperty('symbols');
    expect(await client.inspect({ includeInstructions: true })).toHaveProperty('instructions');
    expect(await client.inspect({ instructions: { from: 'main', to: 'end' } })).toMatchObject({ window: { from: 'main', to: 'end' } });
    await client.command({ action: 'step' });
    await client.close();
    bridge.server.close();
  });

  it('rejects a wrong token and a non-live bridge', async () => {
    const first = await fakeBridge('secret');
    await expect(LiveClient.connect({ host: '127.0.0.1', port: first.port, token: 'wrong', timeoutMs: 1000 })).rejects.toThrow('Invalid bridge token');
    first.server.close();
    const second = await fakeBridge('secret', 'headless');
    await expect(LiveClient.connect({ host: '127.0.0.1', port: second.port, token: 'secret', timeoutMs: 1000 })).rejects.toThrow('not a live RARS session');
    second.server.close();
  });

  it('fails the session when the live bridge resets the connection', async () => {
    const bridge = await fakeBridge('secret', 'live', { resetOnCommand: true });
    const client = await LiveClient.connect({ host: '127.0.0.1', port: bridge.port, token: 'secret', timeoutMs: 60_000 });
    const failure = new Promise<Error>((resolve) => client.onFailure(resolve));

    const command = client.command({ action: 'step' });

    await expect(command).rejects.toMatchObject({ code: 'BRIDGE_DISCONNECTED', message: 'Live RARS connection failed: read ECONNRESET' });
    expect(await failure).toBe(await command.catch((error: unknown) => error));
    await expect(client.inspect({})).rejects.toBe(await failure);
    bridge.server.close();
  });

  it('fails the session when the live bridge answers with a line that is not JSON', async () => {
    const bridge = await fakeBridge('secret', 'live', { garbageOnCommand: true });
    const client = await LiveClient.connect({ host: '127.0.0.1', port: bridge.port, token: 'secret', timeoutMs: 60_000 });

    await expect(client.command({ action: 'step' })).rejects.toMatchObject({
      code: 'BRIDGE_PROTOCOL_ERROR', message: 'Live RARS sent a line that is not JSON: #@! not json',
    });
    await expect(client.inspect({})).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_ERROR' });
    bridge.server.close();
  });
});

describe('discoverLiveSession', () => {
  it('reports the directory it read, so a failed connection can name it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rars-discovery-'));
    await writeFile(join(directory, 'token'), 'secret\n');
    await writeFile(join(directory, 'port'), '12345');

    await expect(discoverLiveSession(directory)).resolves.toEqual({ port: 12345, token: 'secret', directory });
  });
});
