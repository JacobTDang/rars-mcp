import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

describe.runIf(process.env.RARS_JAR)('debug tools', () => {
  it('starts, inspects, mutates, steps, and closes a debug session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    execFileSync('cp', ['tests/fixtures/debug.asm', join(root, 'debug.asm')]);
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 3000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const started = await handlers.debugStart({ files: ['debug.asm'] });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;
    expect(sessionId).toBeTruthy();
    await handlers.modify({ sessionId, registers: { a0: '41' } });
    expect((await handlers.inspect({ sessionId, registers: ['a0'] })).structuredContent).toMatchObject({ registers: { a0: { hex: '0x00000029', signed: 41 } } });
    await handlers.debugCommand({ sessionId, action: 'step' });
    await handlers.debugCommand({ sessionId, action: 'backstep' });
    await handlers.sessionClose({ sessionId });
  });
});
