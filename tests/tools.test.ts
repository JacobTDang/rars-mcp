import { access, copyFile, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { runRars } from '../src/rars/cli.js';
import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers, type ToolDependencies } from '../src/tools/handlers.js';
import { assembleSchema, dumpSchema, runSchema } from '../src/tools/schemas.js';
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

  it('reports inline source that does not assemble with its given name throughout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ source: [{ name: 'main.s', text: '.text\nmain:\n  bogus a0\n' }] });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Assembly failed\nmain.s:3:3: "bogus" is not a recognized operator' }],
      structuredContent: { stderr: expect.stringMatching(/^Error in main\.s line 3 column 3: /) },
    });
    expect(JSON.stringify(result)).not.toContain('rars-inline-');
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

  it('reports a run that stopped at its step limit as an error and keeps what RARS printed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      source: '.text\nmain:\n  addi a0, a0, 1\n  j main\n', maxSteps: 100, instructionCount: true, registers: ['a0'],
      dump: [{ segment: { address: '0x00400000', words: 2 }, format: 'HexText' }, { segment: '0x10040000-0x10040008', format: 'HexText' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution stopped at the step limit of 100, and RARS wrote no file for dump[1] (0x10040000-0x10040008)\n'
        + 'Program terminated when maximum step limit 100 reached.\n'
        + 'This segment has not been written to, there is nothing to dump.',
    }]);
    expect(result.structuredContent).toMatchObject({
      stepLimitReached: true, instructionCount: 100, registers: { a0: { hex: '0x00000032', signed: 50 } },
      dumps: [{ words: [expect.stringMatching(/^0x[0-9a-f]{8}$/), expect.stringMatching(/^0x[0-9a-f]{8}$/)] }, { format: 'HexText' }],
    });
  });

  it('reports a run that ended before its step limit as completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ files: ['hello.asm'], maxSteps: 100 });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'Execution completed' }]);
    expect(result.structuredContent).toMatchObject({ stepLimitReached: false });
  });

  it('names the time limit when a run times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'loop.s'), '.text\nmain:\n  j main\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ files: ['loop.s'], timeoutMs: 1500 });

    expect(result).toMatchObject({ isError: true, structuredContent: { timedOut: true } });
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^Execution timed out after 1500 ms/) });
  });
});

describe.runIf(process.env.RARS_JAR)('rars_run dumps with RARS', () => {
  it('returns an inline HexText dump matching the requested memory range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['hello.asm'], memoryRanges: ['0x10010000-0x10010004'],
      dump: [{ segment: { address: '0x10010000', words: 2 }, format: 'HexText' }],
    });
    const structured = result.structuredContent as {
      memory: Array<{ hex: string }>;
      dumps: Array<{ text: string; words: string[] }>;
    };

    expect(structured.dumps[0]!.words).toEqual(structured.memory.map(({ hex }) => hex));
    expect(structured.dumps[0]!.text).toContain('6c6c6568');
  });

  it('returns an inline binary dump as base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.assemble({
      files: ['dump-array.asm'],
      dump: [{ segment: { address: '0x10010000', words: 2 }, format: 'Binary' }],
    });
    const dump = (result.structuredContent as { dumps: Array<{ bytesBase64: string }> }).dumps[0]!;

    expect(Buffer.from(dump.bytesBase64, 'base64')).toHaveLength(8);
  });

  it('returns exactly the requested number of words for an address dump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.assemble({
      files: ['dump-array.asm'],
      dump: [{ segment: { address: '0x10010000', words: 3 }, format: 'HexText' }],
    });

    expect((result.structuredContent as { dumps: Array<{ words: string[] }> }).dumps[0]!.words).toEqual([
      '0x00000001', '0x00000002', '0x00000003',
    ]);
  });

  it('resolves a label dump through the headless bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const result = await handlers.assemble({
      files: ['dump-array.asm'],
      dump: [{ segment: { label: 'results', words: 4 }, format: 'HexText' }],
    });

    expect((result.structuredContent as { dumps: Array<{ words: string[] }> }).dumps[0]!.words).toEqual([
      '0x00000001', '0x00000002', '0x00000003', '0x00000004',
    ]);
  });

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

  it('rejects a label dump whose address is not word aligned before running RARS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\nfirst: .byte 1\nsecond: .byte 2\n.text\nmain:\n  li a7, 10\n  ecall\n');
    const run = vi.fn(runRars);
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    await expect(handlers.run({
      files: ['prog.s'], dump: [{ segment: { label: 'second', words: 1 }, format: 'HexText' }],
    })).rejects.toThrow('dump label second at 0x10010001 is not word aligned');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports the error RARS gives when it writes no inline dump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['dump-array.asm'], dump: [{ segment: { address: '0x10040000', words: 2 }, format: 'HexText' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution completed, but RARS wrote no file for dump[0] (0x10040000-0x10040008)\n'
        + 'Program terminated by calling exit\nThis segment has not been written to, there is nothing to dump.',
    }]);
    expect(result.structuredContent).not.toHaveProperty('dumps.0.text');
  });

  it('keeps the run result when RARS refuses a dump range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\nvalues: .word 1, 2, 3\n.text\nmain:\n  li a0, 42\n  li a7, 1\n  ecall\n  li a7, 10\n  ecall\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({ files: ['prog.s'], dump: [{ segment: '0x10010008-0x10010000', format: 'HexText' }] });

    expect(result).toMatchObject({ isError: true, structuredContent: { exitCode: 0, stdout: '42' } });
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution completed, but RARS wrote no file for dump[0] (0x10010008-0x10010000)\n'
        + 'Program terminated by calling exit\n'
        + 'Error while attempting to save dump, segment/address-range 0x10010008-0x10010000 is invalid!',
    }]);
  });

  it('still reads the count and registers when RARS writes no inline dump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['dump-array.asm'], instructionCount: true, registers: ['a7'],
      dump: [{ segment: { address: '0x10040000', words: 2 }, format: 'HexText' }],
    });

    expect(result).toMatchObject({
      isError: true, structuredContent: { instructionCount: 1, registers: { a7: { hex: '0x0000000a' } } },
    });
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution completed, but RARS wrote no file for dump[0] (0x10040000-0x10040008)\n'
        + 'Program terminated by calling exit\nThis segment has not been written to, there is nothing to dump.',
    }]);
  });

  it('keeps the temporary dump path out of the reply when RARS names the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    let dumpFile: string | undefined;
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: (options) => {
        dumpFile = options.request.dumps![0]!.file;
        return runRars(options);
      },
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['dump-array.asm'], dump: [{ segment: { address: '0x00000000', words: 4 }, format: 'HexText' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('Error while attempting to save dump, file dump[0]!  Could not access address: 0!'),
    });
    expect(dumpFile).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(dumpFile!);
  });

  // Stores 77 at slot, then faults on line 8.
  const storesThenFaults = '.data\nslot: .word 0\n.text\nmain:\n  li t0, 77\n  la t1, slot\n  sw t0, 0(t1)\n'
    + '  lw t2, 1(zero)\n  li a7, 10\n  ecall\n';
  const faultText = 'inline.s:8: Runtime exception at 0x00400010: Load address not aligned to word boundary 0x00000001\n'
    + 'Simulation terminated due to errors.';

  it('returns the dumps RARS wrote before the program faulted, inline and to a workspace file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const result = await handlers.run({
      source: storesThenFaults,
      dump: [
        { segment: { label: 'slot', words: 1 }, format: 'HexText' },
        { segment: { label: 'slot', words: 1 }, format: 'HexText', file: 'slot.hex' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: `Execution failed\n${faultText}` }]);
    expect(result.structuredContent).toMatchObject({
      dumps: [{ words: ['0x0000004d'] }, { file: join(await realpath(root), 'slot.hex') }],
    });
    expect(await readFile(join(root, 'slot.hex'), 'utf8')).toBe('0000004d\n');
  });

  it('names the dump RARS wrote no file for after the program faulted, and why', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      source: storesThenFaults,
      dump: [
        { segment: { address: '0x10010000', words: 1 }, format: 'HexText' },
        { segment: { address: '0x10040000', words: 2 }, format: 'HexText' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution failed, and RARS wrote no file for dump[1] (0x10040000-0x10040008)\n'
        + `${faultText}\nThis segment has not been written to, there is nothing to dump.`,
    }]);
    expect(result.structuredContent).toMatchObject({ dumps: [{ words: ['0x0000004d'] }, { format: 'HexText' }] });
    expect(result.structuredContent).not.toHaveProperty('dumps.1.text');
  });

  const doesNotAssemble = '.data\nslot: .word 0\n.text\nmain:\n  li a7, 10\n  bogus a0\n  ecall\n';

  it.each(['assemble', 'run'] as const)('reports inline source with a label dump that does not assemble as rars_%s does', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    const result = await handlers[mode]({ source: doesNotAssemble, dump: [{ segment: { label: 'slot', words: 1 }, format: 'HexText' }] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Assembly failed\ninline.s:6:3: "bogus" is not a recognized operator' }]);
    expect(result.structuredContent).toMatchObject({
      exitCode: 0, diagnostics: [{ severity: 'error', file: 'inline.s', line: 6, column: 3 }],
      stderr: expect.stringContaining('Error in inline.s line 6 column 3: "bogus" is not a recognized operator'),
    });
    expect(JSON.stringify(result)).not.toContain('rars-inline-');
  });

  it('refuses a label dump when RARS assembles the program the label lookup could not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false }),
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    });

    await expect(handlers.run({ source: doesNotAssemble, dump: [{ segment: { label: 'slot', words: 1 }, format: 'HexText' }] }))
      .rejects.toThrow(/^Error in inline\.s line 6 column 3: "bogus" is not a recognized operator$/);
  });

  it('lists no unwritten dumps when the program does not assemble', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.assemble({
      source: '.text\nmain:\n  bogus a0\n', dump: [{ segment: '.text', format: 'HexText' }],
    });

    expect(result).toMatchObject({ isError: true, structuredContent: { dumps: [{ segment: '.text', format: 'HexText' }] } });
    expect(result.content).toEqual([{ type: 'text', text: 'Assembly failed\ninline.s:3:3: "bogus" is not a recognized operator' }]);
  });

  it('reports a workspace dump file that RARS did not write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/dump-array.asm', join(root, 'dump-array.asm'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    const result = await handlers.run({
      files: ['dump-array.asm'],
      dump: [{ segment: { address: '0x10040000', words: 2 }, format: 'HexText', file: 'heap.hex' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('This segment has not been written to, there is nothing to dump.'),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('RARS wrote no file for dump[0] (0x10040000-0x10040008)'),
    });
  });
});

describe.runIf(process.env.RARS_JAR)('rars_run register and memory options on the MCP server with RARS', () => {
  async function connect() {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const deps: ToolDependencies = {
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(deps);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const run = async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'rars_run', arguments: { files: ['hello.asm'], ...input } });
      return { isError: result.isError, text: (result.content as Array<{ text: string }>).map((item) => item.text).join('\n') };
    };
    return { handlers: createToolHandlers(deps), run, close: async () => { await client.close(); await server.close(); } };
  }

  it('refuses pc and points to rars_inspect', async () => {
    const { run, close } = await connect();
    try {
      const result = await run({ registers: ['a0', 'pc'] });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('registers.1: "pc"');
      expect(result.text).toContain('rars_inspect');
    } finally {
      await close();
    }
  });

  it('refuses register entries that RARS would take as a dump to a file outside the workspace', async () => {
    const { handlers, run, close } = await connect();
    const outside = join(await mkdtemp(join(tmpdir(), 'rars-outside-')), 'escaped.hex');
    const registers = ['dump', '.text', 'HexText', outside];
    try {
      const result = await run({ registers });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('registers.0: "dump" is not a register');
      await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
      // A direct handler call skips the tool schema.
      await expect(handlers.run({ files: ['hello.asm'], registers })).rejects.toThrow('"dump" is not a register');
      await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await close();
    }
  });

  it('refuses a, which RARS takes as assemble only', async () => {
    const { run, close } = await connect();
    try {
      const result = await run({ registers: ['a'] });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('registers.0: "a" is not a register');
    } finally {
      await close();
    }
  });

  it('refuses memory ranges RARS does not take', async () => {
    const { run, close } = await connect();
    try {
      for (const [range, message] of [['foo', 'is not a memory range'], ['0x10010004-0x10010000', 'lower address first']]) {
        const result = await run({ memoryRanges: [range], instructionCount: true });

        expect(result.isError, range).toBe(true);
        expect(result.text, range).toContain(`memoryRanges.0: "${range}" `);
        expect(result.text, range).toContain(message);
      }
    } finally {
      await close();
    }
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

  it('refuses a rars_run dump file that is a dangling symlink leading out of the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'rars-outside-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    await symlink(join(outside, 'escaped.hex'), join(root, 'link.hex'));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: runRars,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    await expect(handlers.run({
      files: ['hello.asm'],
      dump: [{ segment: '.text', format: 'HexText', file: 'link.hex' }],
    })).rejects.toThrow('Workspace output path is a symlink whose target does not exist: link.hex');
    expect(await readdir(outside)).toEqual([]);
  });

  it('names a dump file folder that does not exist before running RARS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await copyFile('tests/fixtures/hello.asm', join(root, 'hello.asm'));
    const run = vi.fn(runRars);
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    });

    await expect(handlers.run({
      files: ['hello.asm'], dump: [{ segment: '.text', format: 'HexText', file: 'nodir/imem.hex' }],
    })).rejects.toThrow(/^folder nodir does not exist in the workspace$/);
    expect(run).not.toHaveBeenCalled();
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
  it('errors clearly when a label dump has no bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'program.asm'), '.data\nresults: .word 1\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run: vi.fn(),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    await expect(handlers.assemble({
      files: ['program.asm'],
      dump: [{ segment: { label: 'results', words: 1 }, format: 'HexText' }],
    })).rejects.toThrow(/label dumps require.*bridge/i);
  });

  it('removes the temporary inline dump file after reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    let dumpFolder: string | undefined;
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => {
        const file = options.request.dumps![0]!.file;
        dumpFolder = dirname(file);
        await writeFile(file, '00000001\n');
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false };
      },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.assemble({
      source: '.data\n.word 1\n', dump: [{ segment: '.data', format: 'HexText' }],
    });

    expect((result.structuredContent as { dumps: Array<{ words: string[] }> }).dumps[0]!.words)
      .toEqual(['0x00000001']);
    expect(dumpFolder).toBeTruthy();
    await expect(access(dumpFolder!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves assembly diagnostics when an inline dump was not created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'bad.asm'), 'bad');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({
        exitCode: 0, signal: null, stdout: '',
        stderr: `Error in ${join(root, 'bad.asm')} line 1 column 1: bad instruction\n`,
        timedOut: false, truncated: false,
      }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.assemble({
      files: ['bad.asm'], dump: [{ segment: '.text', format: 'HexText' }],
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { diagnostics: [{ message: 'bad instruction' }] },
    });
  });

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

  it.each([
    'Invalid Command Argument: pc',
    'Invalid/unaligned address or invalid range: 0x10010004-0x10010000',
  ])('reports a run whose argument RARS rejected as an error: %s', async (line) => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'main.asm'), 'nop');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: `${line}\n`, timedOut: false, truncated: false }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['main.asm'], registers: ['a0'], memoryRanges: ['0x10010000-0x10010000'], instructionCount: true });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(line) }]);
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
    expect(result.content).toEqual([{ type: 'text', text: 'Execution timed out after 1000 ms' }]);
  });

  it('names the timeoutMs given in the input when a run times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'loop.asm'), 'loop');
    const run = vi.fn(async () => ({
      exitCode: null, signal: 'SIGKILL' as const, stdout: '', stderr: '', timedOut: true, truncated: false,
    }));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['loop.asm'], timeoutMs: 1500 });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1500 }));
    expect(result.content).toEqual([{ type: 'text', text: 'Execution timed out after 1500 ms' }]);
  });

  it('rejects an unaligned dump address before running RARS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1, 2, 3\n');
    const run = vi.fn();
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    await expect(handlers.run({
      files: ['prog.s'], dump: [{ segment: { address: '0x10010001', words: 2 }, format: 'HexText' }],
    })).rejects.toThrow('dump address 0x10010001 is not word aligned');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports what RARS printed when it wrote no inline dump file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => ({
        exitCode: 0, signal: null, stdout: '',
        stderr: `\nProgram terminated by calling exit\nError while attempting to save dump, file ${options.request.dumps![0]!.file} was not found!\n`,
        timedOut: false, truncated: false,
      }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['prog.s'], dump: [{ segment: '.data', format: 'HexText' }] });

    expect(result).toMatchObject({ isError: true, structuredContent: { dumps: [{ segment: '.data', format: 'HexText' }] } });
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Execution completed, but RARS wrote no file for dump[0] (.data)\n'
        + 'Program terminated by calling exit\nError while attempting to save dump, file dump[0] was not found!',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/ENOENT|rars-dumps-/);
  });

  it('returns each inline dump RARS wrote when it wrote no file for another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => {
        await writeFile(options.request.dumps![0]!.file, '00000001\n');
        return {
          exitCode: 0, signal: null, stdout: '',
          stderr: '\nProgram terminated by calling exit\nThis segment has not been written to, there is nothing to dump.\n',
          timedOut: false, truncated: false,
        };
      },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({
      files: ['prog.s'], dump: [{ segment: '.data', format: 'HexText' }, { segment: '0x10040000-0x10040008', format: 'HexText' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/^Execution completed, but RARS wrote no file for dump\[1\] \(0x10040000-0x10040008\)\n/),
    });
    expect(result.structuredContent).toMatchObject({ dumps: [{ words: ['0x00000001'] }, { format: 'HexText' }] });
    expect(result.structuredContent).not.toHaveProperty('dumps.1.text');
  });

  it('returns an inline dump RARS wrote though the program then failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => {
        await writeFile(options.request.dumps![0]!.file, '0000004d\n');
        return {
          exitCode: 0, signal: null, stdout: '',
          stderr: `Error in ${join(root, 'prog.s')} line 4: Runtime exception at 0x00400008: address out of range 0x00000000\n\n`
            + 'Simulation terminated due to errors.\n',
          timedOut: false, truncated: false,
        };
      },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['prog.s'], dump: [{ segment: '.data', format: 'HexText' }] });

    expect(result).toMatchObject({ isError: true, structuredContent: { dumps: [{ words: ['0x0000004d'] }] } });
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^Execution failed\n/) });
  });

  it('reads no inline dump from a run that timed out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1\n');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async (options) => {
        await writeFile(options.request.dumps![0]!.file, '0000');
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, truncated: false };
      },
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['prog.s'], dump: [{ segment: '.data', format: 'HexText' }] });

    expect(result).toMatchObject({ isError: true, structuredContent: { dumps: [{ segment: '.data', format: 'HexText' }] } });
    expect(result.structuredContent).not.toHaveProperty('dumps.0.text');
    expect(result.content).toEqual([{ type: 'text', text: 'Execution timed out after 1000 ms' }]);
  });

  it.each<[{ address: string; words: number }, string]>([
    [{ address: '0xfffffffc', words: 2 }, 'dump range 0xfffffffc-0x100000004 ends past 0xffffffff'],
    [{ address: '0xfffffffc', words: 1 }, 'dump range 0xfffffffc-0x100000000 ends past 0xffffffff'],
  ])('rejects the dump %j before running RARS', async (segment, message) => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'prog.s'), '.data\n.word 1\n');
    const run = vi.fn();
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    await expect(handlers.run({ files: ['prog.s'], dump: [{ segment, format: 'HexText' }] })).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('lists and closes sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const sessions = new SessionStore();
    const close = vi.fn(async () => undefined);
    const id = sessions.add({
      summary: async () => ({ kind: 'headless', state: 'paused' }),
      command: async () => ({ status: 'paused' }), inspect: async () => ({ status: 'paused' }),
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

describe('run register and memory range schema', () => {
  const issues = (input: Record<string, unknown>) => runSchema.safeParse({ files: ['main.s'], ...input }).error?.issues;

  it('accepts the register names and word-aligned ranges RARS prints', () => {
    expect(issues({
      registers: ['x0', 'x31', 'zero', 'fp', 's11', 'a7', 'f0', 'f31', 'ft11', 'fs11', 'fa7', 'fcsr', 'instreth'],
      memoryRanges: ['0x10010000-0x10010000', '0x10010000-0x1001000C', '0x80000000-0xfffffffc'],
    })).toBeUndefined();
  });

  it('refuses pc and points to rars_inspect', () => {
    expect(issues({ registers: ['a0', 'pc'] })).toEqual([expect.objectContaining({
      path: ['registers', 1], message: expect.stringMatching(/^"pc" .*rars_inspect/),
    })]);
  });

  it.each(['a', 'dump', '.text', 'HexText', '/tmp/outside.hex', 'ic', '5', 'A0', 'x32', 'x05', 'hi', 'lo', ''])(
    'refuses the register %j',
    (name) => {
      expect(issues({ registers: [name] })).toEqual([expect.objectContaining({
        path: ['registers', 0], message: expect.stringContaining(`${JSON.stringify(name)} is not a register`),
      })]);
    },
  );

  it.each([
    ['foo', 'is not a memory range'],
    ['0x10010000', 'is not a memory range'],
    ['268500992-268500996', 'is not a memory range'],
    ['0x10010000-0x10010004 ', 'is not a memory range'],
    ['0x10010004-0x10010000', 'lower address first'],
    ['0x10010001-0x10010004', 'word boundary'],
    ['0x10010000-0x10010006', 'word boundary'],
    ['0x100000000-0x100000004', 'above 0xffffffff'],
    ['0x7ffffffc-0x80000000', 'spans 0x80000000'],
  ])('refuses the memory range %j', (range, message) => {
    const found = issues({ memoryRanges: [range] });

    expect(found).toEqual([expect.objectContaining({ path: ['memoryRanges', 0] })]);
    expect(found![0]!.message.startsWith(`${JSON.stringify(range)} `)).toBe(true);
    expect(found![0]!.message).toContain(message);
  });
});

describe('dump schema', () => {
  it.each([0, 1.5, 65537])('rejects an invalid word count of %s', (words) => {
    expect(dumpSchema.safeParse({
      segment: { address: '0x10010000', words }, format: 'HexText',
    }).success).toBe(false);
  });

  it.each<[unknown, string[]]>([
    [{ address: '0x10010001', words: 2 }, ['0x10010001']],
    [{ address: '0x1001000E', words: 1 }, ['0x1001000E']],
    ['0x10010001-0x10010009', ['0x10010001', '0x10010009']],
    ['0x10010000-0x10010006', ['0x10010006']],
  ])('rejects the unaligned segment %j', (segment, addresses) => {
    const result = dumpSchema.safeParse({ segment, format: 'HexText' });

    expect(result.error?.issues.map(({ message }) => message))
      .toEqual(addresses.map((address) => `dump address ${address} is not word aligned`));
  });

  it.each<[unknown, string]>([
    [{ address: '0x100000000', words: 1 }, '0x100000000'],
    ['0xfffffff0-0x100000000', '0x100000000'],
  ])('rejects the segment %j past 32 bits', (segment, address) => {
    const result = dumpSchema.safeParse({ segment, format: 'HexText' });

    expect(result.error?.issues.map(({ message }) => message)).toEqual([`dump address ${address} is past 0xffffffff`]);
  });

  it.each<unknown>([
    { address: '0x10010004', words: 1 }, { address: '0x1001000C', words: 1 }, '0x10010000-0x1001000c', '.data',
    '0xfffffff8-0xfffffffc',
  ])('accepts the word-aligned segment %j', (segment) => {
    expect(dumpSchema.safeParse({ segment, format: 'HexText' }).success).toBe(true);
  });
});
