import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { loadConfig } from '../src/config.js';
import { createToolDependencies } from '../src/dependencies.js';
import { createMcpServer } from '../src/server.js';
import { createDoFileCheckHandler, type DoFileCheckInput } from '../src/tools/dofile.js';
import { analyzeSteps } from '../src/vhdl/dofile.js';
import { Workspace } from '../src/workspace.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'do');
const tclshExecutable = process.env.TCLSH ?? 'tclsh';

interface CheckReport {
  ok: boolean;
  cwd: string;
  steps: Array<{ command: string; args: string[] }>;
  compiles: Array<{ file: string; resolved: string; exists: boolean; library: string; std?: string; order: number }>;
  missing: string[];
  libraries: string[];
  simulate?: { top?: string; args: string[] };
  errors: Array<{ message: string; file?: string; line?: number }>;
}

// Canonical, as the temporary folder may sit behind a symlink.
async function scratchWorkspace(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rars-dofile-')));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

async function check(input: DoFileCheckInput, root = fixtures, limits: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const workspace = await Workspace.create(root);
  const handler = createDoFileCheckHandler({
    workspace, tclshExecutable, timeoutMs: limits.timeoutMs ?? 5000, maxOutputBytes: limits.maxOutputBytes ?? 64 * 1024,
  });
  const result = await handler(input);
  const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  return { result, text, report: result.structuredContent as unknown as CheckReport, root: workspace.root };
}

describe('do_file_check', () => {
  it('lists what compile.do compiles, in order, and flags the missing file', async () => {
    const { result, text, report, root } = await check({ path: 'compile.do' });

    expect(report.compiles).toEqual([
      { file: 'rtl/counter.vhd', resolved: join(root, 'rtl/counter.vhd'), exists: true, library: 'work', std: '2008', order: 1 },
      { file: 'rtl/alu.vhd', resolved: join(root, 'rtl/alu.vhd'), exists: false, library: 'work', std: '2008', order: 2 },
      { file: 'tb/counter_tb.vhd', resolved: join(root, 'tb/counter_tb.vhd'), exists: true, library: 'work', std: '2008', order: 3 },
    ]);
    expect(report.missing).toEqual(['rtl/alu.vhd']);
    expect(report.libraries).toEqual(['work']);
    expect(report.simulate).toEqual({ top: 'work.counter_tb', args: ['-t', '1ns', 'work.counter_tb'] });
    expect(report.steps).toEqual([
      { command: 'vlib', args: ['work'] },
      { command: 'vmap', args: ['work', 'work'] },
      { command: 'vcom', args: ['-2008', '-work', 'work', 'rtl/counter.vhd'] },
      { command: 'vcom', args: ['-2008', 'rtl/alu.vhd'] },
      { command: 'vcom', args: ['-2008', 'tb/counter_tb.vhd'] },
      { command: 'vsim', args: ['-t', '1ns', 'work.counter_tb'] },
      { command: 'add', args: ['wave', '-r', '/*'] },
      { command: 'run', args: ['-all'] },
      { command: 'quit', args: ['-f'] },
    ]);
    expect(report.errors).toEqual([]);
    expect(report.cwd).toBe(root);
    expect(report.ok).toBe(false);
    expect(result.isError).toBe(true);

    expect(text).toContain('3 files');
    expect(text).toMatch(/1\. rtl\/counter\.vhd/);
    expect(text).toMatch(/2\. rtl\/alu\.vhd.*missing/);
    expect(text).toContain('work.counter_tb');
    expect(text).toContain(root);
  });

  it('follows a nested do file and resolves its paths from the folder the script runs in', async () => {
    const { result, report } = await check({ path: 'nested.do' });

    expect(report.steps.map((step) => step.command)).toEqual(['vlib', 'do', 'vcom', 'vcom', 'vsim', 'run']);
    expect(report.steps[1]).toEqual({ command: 'do', args: ['include/rtl.do'] });
    expect(report.compiles.map(({ file, exists, order }) => ({ file, exists, order }))).toEqual([
      { file: 'rtl/counter.vhd', exists: true, order: 1 },
      { file: 'tb/counter_tb.vhd', exists: true, order: 2 },
    ]);
    expect(report.simulate?.top).toBe('counter_tb');
    expect(report.missing).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('reports a Tcl syntax error with its line and keeps the steps before it', async () => {
    const { result, text, report, root } = await check({ path: 'syntax.do' });

    expect(report.errors).toEqual([{ file: join(root, 'syntax.do'), line: 3, message: 'missing close-brace' }]);
    expect(report.steps.map((step) => step.command)).toEqual(['vlib', 'vcom']);
    expect(report.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(text).toContain('syntax.do:3: missing close-brace');
  });

  it('reports an error inside a nested do file once, at its own file and line', async () => {
    const { report, root } = await check({ path: 'nested-error.do' });

    expect(report.errors).toEqual([{ file: join(root, 'syntax.do'), line: 3, message: 'missing close-brace' }]);
    expect(report.steps.map((step) => step.command)).toEqual(['vlib', 'do', 'vlib', 'vcom']);
    expect(report.simulate).toBeUndefined();
  });

  it('reads the standard and work library from vcom options', async () => {
    const { report } = await check({ path: 'library.do' });

    expect(report.compiles.map(({ file, library, std, order }) => ({ file, library, std, order }))).toEqual([
      { file: 'rtl/counter.vhd', library: 'mylib', std: '2008', order: 1 },
      { file: 'tb/counter_tb.vhd', library: 'mylib', std: '93', order: 2 },
    ]);
    expect(report.libraries).toEqual(['mylib']);
    expect(report.simulate).toEqual({ top: 'mylib.counter_tb', args: ['-L', 'mylib', 'mylib.counter_tb'] });
    expect(report.ok).toBe(true);
  });

  it('applies std to vcom calls that give no standard', async () => {
    const root = await scratchWorkspace({ 'a.vhd': '', 'b.vhd': '', 'run.do': 'vcom a.vhd\nvcom -93 b.vhd\n' });

    const withDefault = await check({ path: 'run.do', std: '2019' }, root);
    expect(withDefault.report.compiles.map((entry) => entry.std)).toEqual(['2019', '93']);

    const withoutDefault = await check({ path: 'run.do' }, root);
    expect(withoutDefault.report.compiles[0]).not.toHaveProperty('std');
  });

  it('refuses a do file outside the workspace', async () => {
    await expect(check({ path: '../hello.asm' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('refuses a do file that does not exist', async () => {
    await expect(check({ path: 'absent.do' })).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });

  it('reports a nested do file that does not exist at the line that names it', async () => {
    const root = await scratchWorkspace({ 'run.do': 'vlib work\n\ndo absent.do\nvsim top\n' });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([{ file: join(root, 'run.do'), line: 3, message: 'No such file: absent.do' }]);
    expect(report.ok).toBe(false);
  });

  it('does not reveal files outside the workspace', async () => {
    const root = await scratchWorkspace({ 'run.do': 'vcom ../outside.vhd\ndo ../outside.do\n' });

    const { text, report } = await check({ path: 'run.do' }, root);

    expect(text).toContain('1. ../outside.vhd into work, outside the workspace');
    expect(report.compiles).toEqual([expect.objectContaining({ file: '../outside.vhd', exists: false })]);
    expect(report.missing).toEqual([]);
    expect(report.errors).toEqual([
      { file: join(root, 'run.do'), line: 2, message: 'Path is outside the workspace folders: ../outside.do' },
      { message: 'Compiled file is outside the workspace folders: ../outside.vhd' },
    ]);
  });

  it('runs the script without shell or file access', async () => {
    const root = await scratchWorkspace({ 'run.do': 'exec touch pwned\n' });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([{ file: join(root, 'run.do'), line: 1, message: 'invalid command name "exec"' }]);
    await expect(access(join(root, 'pwned'))).rejects.toThrow();
  });

  it('answers file exists from the workspace and supports quietly', async () => {
    const script = 'if {[file exists work]} { vdel -all }\nquietly set top tb\nvlib work\nvsim $top\n';
    const root = await scratchWorkspace({ 'run.do': script });

    const fresh = await check({ path: 'run.do' }, root);
    expect(fresh.report.steps).toEqual([{ command: 'vlib', args: ['work'] }, { command: 'vsim', args: ['tb'] }]);

    await mkdir(join(root, 'work'));
    const existing = await check({ path: 'run.do' }, root);
    expect(existing.report.steps.map((step) => step.command)).toEqual(['vdel', 'vlib', 'vsim']);
  });

  it('stops at quit but not at quit -sim', async () => {
    const root = await scratchWorkspace({
      'run.do': 'puts "start \\"quoted\\"\\ttab"\nvsim tb\nquit -sim\nvcom a.vhd\nquit -f\nvcom never.vhd\n',
    });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.steps[0]).toEqual({ command: 'puts', args: ['start "quoted"\ttab'] });
    expect(report.steps.map((step) => step.command)).toEqual(['puts', 'vsim', 'quit', 'vcom', 'quit']);
    expect(report.compiles.map((entry) => entry.file)).toEqual(['a.vhd']);
    expect(report.errors).toEqual([]);
  });

  it('stops a script that runs past the time limit', async () => {
    const root = await scratchWorkspace({ 'run.do': 'vlib work\nwhile 1 {}\n' });

    const { result, report } = await check({ path: 'run.do' }, root, { timeoutMs: 300 });

    expect(report.errors).toEqual([{ message: 'The check did not finish within 300 ms' }]);
    expect(report.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('stops a script that exceeds the output limit', async () => {
    const root = await scratchWorkspace({ 'run.do': 'while 1 { run 1ns }\n' });

    const { report } = await check({ path: 'run.do' }, root, { maxOutputBytes: 1024 });

    expect(report.errors).toEqual([{ message: 'The check exceeded its 1024-byte output limit' }]);
    expect(report.ok).toBe(false);
  });

  it('fails loudly when tclsh cannot be started', async () => {
    const handler = createDoFileCheckHandler({
      workspace: await Workspace.create(fixtures), tclshExecutable: '/nonexistent/tclsh', timeoutMs: 5000, maxOutputBytes: 1024,
    });

    await expect(handler({ path: 'compile.do' })).rejects.toThrow('/nonexistent/tclsh');
  });
});

describe('analyzeSteps', () => {
  it('skips vlog options and their values', () => {
    const analysis = analyzeSteps([
      { command: 'vlog', args: ['-sv', '+incdir+inc', '-work', 'lib', '-L', 'other', 'top.sv', 'pkg.sv'] },
      { command: 'vcom', args: ['-f', 'files.f', '-suppress', '1234', 'a.vhd'] },
    ]);

    expect(analysis.compiles).toEqual([
      { file: 'top.sv', library: 'lib', std: 'sv', order: 1 },
      { file: 'pkg.sv', library: 'lib', std: 'sv', order: 2 },
      { file: 'a.vhd', library: 'work', order: 3 },
    ]);
  });
});

describe('TCLSH', () => {
  it('names the Tcl shell, tclsh by default', async () => {
    const config = loadConfig({ RARS_WORKSPACE: fixtures });

    expect((await createToolDependencies(config, {})).tclshExecutable).toBe('tclsh');
    expect((await createToolDependencies(config, { TCLSH: '/opt/tcl/bin/tclsh8.6' })).tclshExecutable).toBe('/opt/tcl/bin/tclsh8.6');
  });
});

describe('do_file_check over MCP', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      workspace: await Workspace.create(fixtures), tclshExecutable, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
    } as never);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  it('publishes do_file_check with a path and an optional standard', async () => {
    const client = await connect();

    const tool = (await client.listTools()).tools.find((item) => item.name === 'do_file_check');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, std: { enum: ['87', '93', '2002', '2008', '2019'] } },
      required: ['path'],
    });
  });

  it('checks a do file through the server', async () => {
    const client = await connect();

    const result = await client.callTool({ name: 'do_file_check', arguments: { path: 'library.do' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, libraries: ['mylib'] });
  });

  it('rejects an unknown standard', async () => {
    const client = await connect();

    const result = await client.callTool({ name: 'do_file_check', arguments: { path: 'library.do', std: '2010' } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('std');
  });
});
