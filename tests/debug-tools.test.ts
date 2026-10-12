import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

describe.runIf(process.env.RARS_JAR)('debug tools', () => {
  it('debugs inline source with named instructions and removes it on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    const sourceName = `${basename(root)}.s`;
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 3000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const started = await handlers.debugStart({
      source: [{ name: sourceName, text: '.text\nmain:\n  li a0, 1\n  li a7, 10\n  ecall\n' }],
    });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;
    const state = (await handlers.inspect({ sessionId, includeInstructions: true })).structuredContent as {
      instructions: Array<{ file: string }>;
    };
    const candidates = (await readdir(tmpdir()))
      .filter((name) => name.startsWith('rars-inline-'))
      .map((name) => join(tmpdir(), name));
    const sourceFolder = (await Promise.all(candidates.map(async (candidate) => {
      try {
        await access(join(candidate, sourceName));
        return candidate;
      } catch {
        return undefined;
      }
    }))).find((candidate) => candidate !== undefined);

    expect(state.instructions[0]).toMatchObject({ file: sourceName });
    expect(sourceFolder).toBeTruthy();
    await expect(access(sourceFolder!)).resolves.toBeUndefined();
    await handlers.sessionClose({ sessionId });
    await expect(access(sourceFolder!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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
    expect((await handlers.inspect({ sessionId, instructions: { around: 'main', count: 2 } })).structuredContent)
      .toMatchObject({ instructions: [{ address: '0x00400000', source: 'li a0, 1' }, { address: '0x00400004' }] });
    await expect(handlers.inspect({ sessionId, instructions: { from: 'main' } })).rejects.toThrow('instructions takes around and count, or both from and to');
    await handlers.debugCommand({ sessionId, action: 'step' });
    await handlers.debugCommand({ sessionId, action: 'backstep' });
    await handlers.sessionClose({ sessionId });
  });
});
