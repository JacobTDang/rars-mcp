import { copyFile, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runRars } from '../src/rars/cli.js';
import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

describe.runIf(process.env.RARS_JAR)('rars_run with RARS', () => {
  it('reports the instruction count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ files: ['hello.asm'], instructionCount: true });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ instructionCount: 5 });
    expect((result.structuredContent as { stderr: string }).stderr).not.toMatch(/^5$/m);
  });
});

describe.runIf(process.env.RARS_JAR)('rars_run dumps with RARS', () => {
  it('returns requested registers and memory as structured values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['hello.asm'], instructionCount: true, registers: ['a7'], memoryRanges: ['0x10010000-0x10010004'],
    });

    expect(result.structuredContent).toMatchObject({
      instructionCount: 5,
      registers: { a7: { hex: '0x0000000a', signed: 10 } },
      memory: [
        { address: '0x10010000', hex: '0x6c6c6568', signed: 1819043176 },
        { address: '0x10010004', hex: '0x7266206f', signed: 1919295599 },
      ],
    });
    expect((result.structuredContent as { stderr: string }).stderr).not.toContain('a7\t');
  });
});

describe('headless tool handlers', () => {
  it('resolves files and returns structured assembly diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'bad.asm'), 'bad');
    const run = vi.fn(async () => ({
      exitCode: 1, signal: null, stdout: '',
      stderr: `Error in ${join(root, 'bad.asm')} line 1 column 1: bad instruction\n`,
      timedOut: false, truncated: false,
    }));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.assemble({ files: ['bad.asm'] });

    const canonicalRoot = await realpath(root);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: canonicalRoot,
      request: expect.objectContaining({ mode: 'assemble', files: [join(canonicalRoot, 'bad.asm')] }),
    }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ diagnostics: [{ line: 1, column: 1 }] });
  });

  it('reports timeouts as readable run results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'loop.asm'), 'loop');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, truncated: false }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['loop.asm'], programArgs: ['one'] });
    expect(result).toMatchObject({ isError: true, structuredContent: { timedOut: true } });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('timed out') });
  });

  it('lists and closes sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const sessions = new SessionStore();
    const close = vi.fn(async () => undefined);
    const id = sessions.add({
      summary: async () => ({ kind: 'headless', state: 'paused' }),
      command: async () => ({ status: 'paused' }), inspect: async () => ({}),
      modify: async () => ({ status: 'paused' }), close,
    });
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions,
      run: vi.fn(), javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    expect((await handlers.sessionList()).structuredContent).toMatchObject({ sessions: [{ id }] });
    await handlers.sessionClose({ sessionId: id });
    expect(close).toHaveBeenCalledOnce();
  });
});
