import { access, copyFile, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runRars } from '../src/rars/cli.js';
import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { assembleSchema, runSchema } from '../src/tools/schemas.js';
import { Workspace } from '../src/workspace.js';

describe.runIf(process.env.RARS_JAR)('rars_run with RARS', () => {
  it('runs a single inline source string', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      source: '.data\nmessage: .asciz "inline\\n"\n.text\nmain:\n  li a7, 4\n  la a0, message\n  ecall\n  li a7, 10\n  ecall\n',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ stdout: 'inline\n' });
  });

  it('runs several named inline source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ source: [
      { name: 'main.s', text: '.text\nmain:\n  jal answer\n  li a7, 1\n  ecall\n  li a7, 10\n  ecall\n' },
      { name: 'lib.s', text: '.globl answer\n.text\nanswer:\n  li a0, 42\n  ret\n' },
    ] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ stdout: '42' });
  });

  it('reports an inline diagnostic with its given name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.assemble({
      source: [{ name: 'main.s', text: '.text\nmain:\n  definitely_not_an_instruction a0, a1\n' }],
    });

    expect(result.structuredContent).toMatchObject({
      diagnostics: [{ file: 'main.s', line: 3, severity: 'error' }],
    });
  });

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

describe.runIf(process.env.RARS_JAR)('rars_assemble dumps with RARS', () => {
  it('writes a memory image inside the workspace and reports it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.assemble({
      files: ['hello.asm'],
      dump: [{ segment: '.text', format: 'HexText', file: 'imem.hex' }],
    });

    expect(result.isError).toBeFalsy();
    const image = await readFile(join(await realpath(root), 'imem.hex'), 'utf8');
    expect(image.split('\n')[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(result.structuredContent).toMatchObject({
      dumps: [{ segment: '.text', format: 'HexText', file: join(await realpath(root), 'imem.hex') }],
    });
  });

  it('rejects a dump format RARS does not accept', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    await expect(handlers.assemble({
      files: ['hello.asm'],
      dump: [{ segment: '.text', format: 'NotAFormat' as never, file: 'imem.hex' }],
    })).rejects.toThrow(/format/);
  });
});

describe('headless tool handlers', () => {
  it('removes the temporary source folder after a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    let sourceFolder: string | undefined;
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => {
        sourceFolder = dirname(options.request.files[0]!);
        expect(await readFile(options.request.files[0]!, 'utf8')).toBe('inline program');
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false };
      },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    await handlers.run({ source: 'inline program' });

    expect(sourceFolder).toBeTruthy();
    await expect(access(sourceFolder!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces assembly diagnostics in text content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'bad.asm'), 'bad');
    const run = vi.fn(async () => ({
      exitCode: 0, signal: null, stdout: '',
      stderr: `Error in ${join(root, 'bad.asm')} line 1 column 1: bad instruction\nProcessing terminated due to errors.\n`,
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
    expect(result.content).toEqual([{
      type: 'text',
      text: `Assembly failed\n${join(root, 'bad.asm')}:1:1: bad instruction`,
    }]);
  });

  it('surfaces a runtime exception in text content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'fault.asm'), 'fault');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({
        exitCode: 1, signal: null, stdout: '',
        stderr: 'Runtime exception at 0x00400010: address out of range\n',
        timedOut: false, truncated: false,
      }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['fault.asm'] });

    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution failed\nRuntime exception at 0x00400010: address out of range',
    }]);
  });

  it('surfaces the stderr message when a program exits non-zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'exit.asm'), 'exit');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({
        exitCode: 7, signal: null, stdout: '', stderr: 'Program exited with status 7\n',
        timedOut: false, truncated: false,
      }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['exit.asm'] });

    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution failed\nProgram exited with status 7',
    }]);
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

describe('inline source schemas', () => {
  it('rejects files and source together', () => {
    const result = runSchema.safeParse({ files: ['main.s'], source: '.text' });

    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      message: 'files and source are mutually exclusive',
    }));
  });

  it('requires files or source', () => {
    const result = assembleSchema.safeParse({});

    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      message: 'Either files or source is required',
    }));
  });

  it.each(['.', '../main.s', 'dir/main.s', 'dir\\main.s', 'main..s'])('rejects the source name %s', (name) => {
    const result = assembleSchema.safeParse({ source: [{ name, text: '.text' }] });

    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      message: 'source name must be a bare file name without path separators or ..',
    }));
  });

  it('rejects duplicate source names', () => {
    const result = assembleSchema.safeParse({ source: [
      { name: 'main.s', text: 'first' },
      { name: 'main.s', text: 'second' },
    ] });

    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      message: 'source names must be unique',
    }));
  });
});
