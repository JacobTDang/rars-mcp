import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { inspectSchema, liveCommandSchema, modifySchema } from '../src/tools/schemas.js';
import { Workspace } from '../src/workspace.js';

describe('memory address and value schemas', () => {
  const sessionId = '00000000-0000-4000-8000-000000000000';
  const issuesOf = (result: { error?: { issues: unknown[] } }) => result.error?.issues;

  it.each(['x', '', '0x', '-4', '+4', '1.5', '0x1g', ' 4', '#10', '010'])('refuses the address %j', (address) => {
    const issue = { path: ['memory', 0, 'address'], message: `address must be a hex or decimal number: ${JSON.stringify(address)}` };

    expect(issuesOf(inspectSchema.safeParse({ sessionId, memory: [{ address, length: 4 }] })))
      .toEqual([expect.objectContaining(issue)]);
    expect(issuesOf(modifySchema.safeParse({ sessionId, memory: [{ address, value: '1', width: 4 }] })))
      .toEqual([expect.objectContaining(issue)]);
    expect(issuesOf(liveCommandSchema.safeParse({ sessionId, command: { action: 'inspect', memory: [{ address, length: 4 }] } })))
      .toEqual([expect.objectContaining({ ...issue, path: ['command', ...issue.path] })]);
  });

  it.each(['abc', '', '0x', '--1', '1e3', '-0x1', '0x-1', '007', '-01'])('refuses the value %j', (value) => {
    expect(issuesOf(modifySchema.safeParse({ sessionId, memory: [{ address: '0x10010000', value, width: 4 }] }))).toEqual([
      expect.objectContaining({ path: ['memory', 0, 'value'], message: `value must be a hex or decimal number: ${JSON.stringify(value)}` }),
    ]);
  });

  it('accepts hex and decimal addresses, and hex, decimal and negative decimal values', () => {
    expect(inspectSchema.safeParse({ sessionId, memory: ['0x10010000', '0X1001000C', '268500992', '0']
      .map((address) => ({ address, length: 4 })) }).success).toBe(true);
    expect(modifySchema.safeParse({ sessionId, memory: ['-1', '0xff', '42', '0', '-9223372036854775808', '0xffffffffffffffff']
      .map((value) => ({ address: '0x10010000', value, width: 8 })) }).success).toBe(true);
  });

  it('names the field and the number in the tool reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    const sessions = new SessionStore();
    const get = vi.spyOn(sessions, 'get');
    const server = createMcpServer({
      workspace: await Workspace.create(root), sessions, run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError, text: (result.content as Array<{ text: string }>).map((item) => item.text).join('\n') };
    };
    try {
      expect(await call('rars_inspect', { sessionId, memory: [{ address: 'x', length: 4 }] })).toEqual({
        isError: true, text: expect.stringContaining('memory.0.address: address must be a hex or decimal number: "x"'),
      });
      expect(await call('rars_modify', { sessionId, memory: [{ address: '0x10010000', value: 'abc', width: 4 }] })).toEqual({
        isError: true, text: expect.stringContaining('memory.0.value: value must be a hex or decimal number: "abc"'),
      });
      expect(get).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

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

  it('reads a .dword beyond 2^53 exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 3000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const started = await handlers.debugStart({ source: '.data\nbig: .dword 0x7fffffffffffffff\n.text\nmain:\n  li a7, 10\n  ecall\n' });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;
    expect((await handlers.inspect({ sessionId, memory: [{ address: '0x10010000', length: 8 }] })).structuredContent).toMatchObject({
      memory: [{ address: '0x10010000', width: 8, hex: '0x7fffffffffffffff', signed: '9223372036854775807' }],
    });
    await handlers.sessionClose({ sessionId });
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

  it('refuses to write x0 and writes nothing else from that request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 3000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const started = await handlers.debugStart({ source: '.text\nmain:\n  li t1, 100\n  addi t1, t1, 2\n  li a7, 10\n  ecall\n' });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;
    await expect(handlers.modify({ sessionId, registers: { t0: '0x11', zero: '0x40' } }))
      .rejects.toThrow('Cannot write zero: x0 is hard-wired to zero');
    await expect(handlers.modify({ sessionId, registers: { x0: '0x40' } })).rejects.toThrow('Cannot write x0: x0 is hard-wired to zero');
    expect((await handlers.inspect({ sessionId, registers: ['zero', 't0'] })).structuredContent)
      .toMatchObject({ registers: { zero: { hex: '0x00000000' }, t0: { hex: '0x00000000' } } });
    expect((await handlers.debugCommand({ sessionId, action: 'continue' })).structuredContent).toMatchObject({ stopReason: 'exited' });
    expect((await handlers.inspect({ sessionId, registers: ['t1'] })).structuredContent).toMatchObject({ registers: { t1: { signed: 102 } } });
    await handlers.sessionClose({ sessionId });
  });

  it('caps program output at the output limit and returns only what is new in each reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 3000,
      maxOutputBytes: 4096, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });
    const line = '0123456789abcdef\n';
    const started = await handlers.debugStart({
      source: `.data\nline: .asciz "0123456789abcdef\\n"\n.text\nmain:\n  la a0, line\n  li a7, 4\nprint:\n  ecall\n  j print\n`,
    });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;
    const command = async (input: Omit<Parameters<typeof handlers.debugCommand>[0], 'sessionId'>) =>
      (await handlers.debugCommand({ sessionId, ...input })).structuredContent;
    const inspect = async () => (await handlers.inspect({ sessionId })).structuredContent;

    // la is two instructions, so the fourth is the first ecall.
    expect(await command({ action: 'continue', maxSteps: 4 }))
      .toMatchObject({ stdout: line, stderr: '', stdoutBytes: 17, stderrBytes: 0, truncated: false });
    expect(await inspect()).toMatchObject({ stdout: '', stderr: '', stdoutBytes: 17, truncated: false });
    expect(await command({ action: 'step' })).toMatchObject({ stdout: '', stdoutBytes: 17 });
    expect(await command({ action: 'step' })).toMatchObject({ stdout: line, stdoutBytes: 34, truncated: false });

    expect(await command({ action: 'continue', maxSteps: 100_000 })).toMatchObject({
      stopReason: 'step_limit', stdout: line.repeat(Math.ceil(4096 / 17)).slice(34, 4096), stderr: '',
      stdoutBytes: 4096, stderrBytes: 0, truncated: true,
    });
    expect(await command({ action: 'step' })).toMatchObject({ stdout: '', stderr: '', stdoutBytes: 4096, truncated: true });
    expect(await inspect()).toMatchObject({ stdout: '', stderr: '', stdoutBytes: 4096, truncated: true });

    expect(await command({ action: 'reset' })).toMatchObject({ stdout: '', stdoutBytes: 0, truncated: false });
    expect(await command({ action: 'continue', maxSteps: 4 })).toMatchObject({ stdout: line, stdoutBytes: 17, truncated: false });
    await handlers.sessionClose({ sessionId });
  });

  it('pauses a running continue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    execFileSync('cp', ['tests/fixtures/infinite.asm', join(root, 'infinite.asm')]);
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });
    const started = await handlers.debugStart({ files: ['infinite.asm'] });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;

    const running = handlers.debugCommand({ sessionId, action: 'continue', maxSteps: 2_147_483_647 });
    await new Promise((done) => setTimeout(done, 300));
    await handlers.debugCommand({ sessionId, action: 'pause' });

    expect((await running).structuredContent).toMatchObject({ status: 'paused', stopReason: 'paused' });
    await handlers.sessionClose({ sessionId });
  }, 15_000);

  it('removes a session whose bridge is killed and says how it exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-debug-tools-'));
    execFileSync('cp', ['tests/fixtures/debug.asm', join(root, 'debug.asm')]);
    // Its own token, so this test can find its bridge among the others.
    const bridgeToken = `kill-test-${randomUUID()}`;
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: async () => {
        throw new Error('not used');
      }, javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 60_000,
      maxOutputBytes: 1024, bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken,
    });
    const started = await handlers.debugStart({ files: ['debug.asm'] });
    const sessionId = (started.structuredContent as Record<string, unknown>).sessionId as string;

    execFileSync('pkill', ['-KILL', '-f', bridgeToken]);

    await vi.waitFor(async () => expect((await handlers.sessionList()).structuredContent).toEqual({ sessions: [] }), { timeout: 5_000 });
    const before = Date.now();
    await expect(handlers.debugCommand({ sessionId, action: 'step' })).rejects.toMatchObject({
      code: 'SESSION_FAILED', message: `Session ${sessionId} failed: RARS bridge exited on signal SIGKILL`,
    });
    expect(Date.now() - before).toBeLessThan(100);
  }, 15_000);
});
