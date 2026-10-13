import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { loadConfig } from '../src/config.js';
import { createToolDependencies } from '../src/dependencies.js';
import { createMcpServer } from '../src/server.js';
import { createVhdlHandlers } from '../src/tools/vhdl.js';
import { createWaveQuery } from '../src/tools/wave.js';
import { buildNvcArgs, createNvcSimulator } from '../src/vhdl/nvc.js';
import { parseNvcOutput } from '../src/vhdl/nvc-output.js';
import { Workspace } from '../src/workspace.js';

const simulator = process.env.VHDL_SIMULATOR ?? 'nvc';

// The leftover checks list the temporary folder for nvc work folders. The system one is shared with
// every other process on the machine, so a private one keeps other runs out of the count.
const systemTmpdir = process.env.TMPDIR;
let privateTmpdir: string;
beforeAll(async () => {
  privateTmpdir = await mkdtemp(join(tmpdir(), 'vhdl-tools-tmp-'));
  process.env.TMPDIR = privateTmpdir;
});
afterAll(async () => {
  if (systemTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = systemTmpdir;
  await rm(privateTmpdir, { recursive: true, force: true });
});
const fixtures = resolve('tests/fixtures/vhdl');
const waveFixtures = resolve('tests/fixtures/wave');

function simulatorAvailable(): boolean {
  const result = spawnSync(simulator, ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

async function workspaceWith(files: string[], from = fixtures) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vhdl-tools-')));
  await Promise.all(files.map((file) => copyFile(join(from, file), join(root, file))));
  return root;
}

async function handlersFor(root: string, limits: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return createVhdlHandlers({
    workspace: await Workspace.create(root),
    vhdl: createNvcSimulator({ executable: simulator }),
    timeoutMs: limits.timeoutMs ?? 10_000,
    maxOutputBytes: limits.maxOutputBytes ?? 1024 * 1024,
  });
}

async function libraryFolders(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('vhdl-work-'));
}

describe('parseNvcOutput', () => {
  it('parses an analysis error with its file, line and column', () => {
    expect(parseNvcOutput(
      '/project/syntax_error.vhd:6:1: error: unexpected begin while parsing signal declaration, expecting one of := or ;\n',
    )).toEqual({
      diagnostics: [{
        severity: 'error', file: '/project/syntax_error.vhd', line: 6, column: 1,
        message: 'unexpected begin while parsing signal declaration, expecting one of := or ;',
      }],
      messages: [],
    });
  });

  it('parses analysis warnings and errors in order', () => {
    expect(parseNvcOutput(
      '/project/warn.vhd:8:3: warning: potential infinite loop in process with no sensitivity list and no wait statements.\n'
      + '/project/warn.vhd:16:12: error: array C index 5 outside of NATURAL range 3 downto 0\n',
    ).diagnostics).toEqual([
      {
        severity: 'warning', file: '/project/warn.vhd', line: 8, column: 3,
        message: 'potential infinite loop in process with no sensitivity list and no wait statements.',
      },
      { severity: 'error', file: '/project/warn.vhd', line: 16, column: 12, message: 'array C index 5 outside of NATURAL range 3 downto 0' },
    ]);
  });

  it('reports a fatal message without a location as an error', () => {
    expect(parseNvcOutput('fatal: opening /project/missing.vhd: No such file or directory\n').diagnostics).toEqual([
      { severity: 'error', message: 'opening /project/missing.vhd: No such file or directory' },
    ]);
  });

  it('drops the (init) prefix from elaboration messages', () => {
    expect(parseNvcOutput(
      'warning: generic value for NOPE not used\n'
      + 'fatal: (init): failed to parse "banana" as type TIME for generic PERIOD\n',
    ).diagnostics).toEqual([
      { severity: 'warning', message: 'generic value for NOPE not used' },
      { severity: 'error', message: 'failed to parse "banana" as type TIME for generic PERIOD' },
    ]);
  });

  it('turns an unbound component into a warning that the testbench may silently pass', () => {
    const [diagnostic] = parseNvcOutput(
      '/project/unbound_tb.vhd:10:3: warning: (init): cannot find entity for component ADDER_CORE without binding indication\n',
    ).diagnostics;

    expect(diagnostic).toMatchObject({ severity: 'warning', file: '/project/unbound_tb.vhd', line: 10, column: 3 });
    expect(diagnostic?.message).toMatch(/ADDER_CORE is unbound/);
    expect(diagnostic?.message).toMatch(/may silently pass/);
  });

  it('parses report and assertion messages with their simulation time and source', () => {
    expect(parseNvcOutput(
      '/project/adder_tb.vhd:18:5: note: 10ns+0: half adder checked\n'
      + '/project/adder_tb.vhd:19:12: warning: 10ns+0: a warning here\n'
      + '/project/failing_tb.vhd:12:12: error: 20ns+1: count is 5, expected 4\n'
      + '/project/misc_tb.vhd:15:5: failure: 0ms+0: failing now\n',
    )).toEqual({
      diagnostics: [],
      messages: [
        { time: '10ns', severity: 'note', text: 'half adder checked', source: { file: '/project/adder_tb.vhd', line: 18, column: 5 } },
        { time: '10ns', severity: 'warning', text: 'a warning here', source: { file: '/project/adder_tb.vhd', line: 19, column: 12 } },
        { time: '20ns', severity: 'error', text: 'count is 5, expected 4', source: { file: '/project/failing_tb.vhd', line: 12, column: 12 } },
        { time: '0ms', severity: 'failure', text: 'failing now', source: { file: '/project/misc_tb.vhd', line: 15, column: 5 } },
      ],
    });
  });

  it('keeps a simulator fatal error as a fatal message', () => {
    expect(parseNvcOutput('/project/bounds_tb.vhd:13:39: fatal: 5ns+0: index 5 outside of INTEGER range 0 to 3\n').messages).toEqual([
      { time: '5ns', severity: 'fatal', text: 'index 5 outside of INTEGER range 0 to 3', source: { file: '/project/bounds_tb.vhd', line: 13, column: 39 } },
    ]);
  });

  it('keeps the lines of a multi-line report together', () => {
    expect(parseNvcOutput(
      '/project/misc_tb.vhd:14:5: note: 0ms+0: first line\nsecond line\n/project/misc_tb.vhd:15:5: failure: 0ms+0: failing now\n',
    ).messages.map((message) => message.text)).toEqual(['first line\nsecond line', 'failing now']);
  });
});

describe('buildNvcArgs', () => {
  it('analyses the files in order into a named library folder', () => {
    expect(buildNvcArgs({ files: ['/p/pkg.vhd', '/p/top.vhd'], std: '02', work: 'mylib' }, '/tmp/vhdl-work-1')).toEqual([
      '--messages=compact', '--std=2002', '--work=mylib:/tmp/vhdl-work-1/mylib', '-a', '/p/pkg.vhd', '/p/top.vhd',
    ]);
  });

  it('elaborates and runs the testbench with generics, a stop time and a wave file', () => {
    expect(buildNvcArgs({
      files: ['/p/tb.vhd'], std: '08', work: 'work', testbench: 'clock_tb',
      generics: { period: '20 ns', width: '8' }, stopTime: '1 us', wave: { file: '/p/out.vcd', format: 'vcd' },
    }, '/tmp/vhdl-work-2')).toEqual([
      '--messages=compact', '--std=2008', '--work=work:/tmp/vhdl-work-2/work', '-a', '/p/tb.vhd',
      '-e', '-gperiod=20 ns', '-gwidth=8', 'clock_tb',
      '-r', '--exit-severity=error', '--stop-time=1us', '--wave=/p/out.vcd', '--format=vcd',
    ]);
  });
});

describe('createNvcSimulator', () => {
  it('names the missing simulator', async () => {
    const vhdl = createNvcSimulator({ executable: '/nonexistent/nvc' });

    await expect(vhdl.compile({ files: [join(fixtures, 'half_adder.vhd')], std: '08', work: 'work' }, {
      timeoutMs: 5000, maxOutputBytes: 1024,
    })).rejects.toThrow('VHDL simulator not found: /nonexistent/nvc');
    await expect(vhdl.version({ timeoutMs: 5000, maxOutputBytes: 1024 })).rejects.toThrow('VHDL simulator not found: /nonexistent/nvc');
  });

  it('names itself and the executable it runs', () => {
    const vhdl = createNvcSimulator({ executable: '/opt/nvc/bin/nvc' });

    expect({ name: vhdl.name, executable: vhdl.executable }).toEqual({ name: 'nvc', executable: '/opt/nvc/bin/nvc' });
  });
});

describe('vhdl_run replies', () => {
  it('shows the raw output of a failure the parser does not recognise', async () => {
    const root = await workspaceWith(['half_adder.vhd']);
    const failure = {
      ok: false, exitCode: 134, signal: null, stdout: '', stderr: '*** Caught signal 11 (SEGV_MAPERR)\n',
      timedOut: false, truncated: false, diagnostics: [], messages: [],
    };
    const handlers = createVhdlHandlers({
      workspace: await Workspace.create(root),
      vhdl: {
        name: 'fake', executable: 'fake-simulator', version: async () => { throw new Error('vhdl_run never reads the version'); },
        compile: async () => failure, run: async () => failure,
      },
      timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ testbench: 'half_adder', files: ['half_adder.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Simulation failed\n*** Caught signal 11 (SEGV_MAPERR)' }]);
  });

  it('names a wave file folder that does not exist before running the simulator', async () => {
    const root = await workspaceWith(['half_adder.vhd']);
    const notRun = async () => {
      throw new Error('the simulator is not run');
    };
    const handlers = createVhdlHandlers({
      workspace: await Workspace.create(root),
      vhdl: { name: 'fake', executable: 'fake-simulator', version: notRun, compile: notRun, run: notRun },
      timeoutMs: 1000, maxOutputBytes: 1024,
    });

    await expect(handlers.run({ testbench: 'half_adder', files: ['half_adder.vhd'], wave: { file: 'nodir/out.vcd' } }))
      .rejects.toThrow(/^folder nodir does not exist in the workspace$/);
  });

  it('refuses to run without a configured simulator', async () => {
    const root = await workspaceWith(['half_adder.vhd']);
    const handlers = createVhdlHandlers({ workspace: await Workspace.create(root), timeoutMs: 1000, maxOutputBytes: 1024 });

    await expect(handlers.compile({ files: ['half_adder.vhd'] })).rejects.toThrow('VHDL simulator is not configured');
  });
});

describe('VHDL simulator configuration', () => {
  it('defaults to nvc and reads VHDL_SIMULATOR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vhdl-config-'));

    expect(loadConfig({ RARS_WORKSPACE: root }).vhdlSimulator).toBe('nvc');
    expect(loadConfig({ RARS_WORKSPACE: root, VHDL_SIMULATOR: '/opt/nvc/bin/nvc' }).vhdlSimulator).toBe('/opt/nvc/bin/nvc');
  });

  it('builds the tool dependencies with the configured simulator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vhdl-config-'));
    const dependencies = await createToolDependencies(loadConfig({ RARS_WORKSPACE: root, VHDL_SIMULATOR: '/nonexistent/sim' }), {});

    await expect(dependencies.vhdl!.compile({ files: [join(fixtures, 'half_adder.vhd')], std: '08', work: 'work' }, {
      timeoutMs: 5000, maxOutputBytes: 1024,
    })).rejects.toThrow('VHDL simulator not found: /nonexistent/sim');
  });
});

describe('VHDL tools on the MCP server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const workspace = await Workspace.create(await mkdtemp(join(tmpdir(), 'vhdl-server-')));
    const server = createMcpServer({ workspace } as never);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  it('advertises vhdl_compile and vhdl_run with their options', async () => {
    const client = await connect();

    const tools = (await client.listTools()).tools;
    const compile = tools.find((tool) => tool.name === 'vhdl_compile');
    const run = tools.find((tool) => tool.name === 'vhdl_run');
    expect(compile?.inputSchema).toMatchObject({
      type: 'object',
      properties: { files: { type: 'array' }, std: { enum: ['93', '02', '08', '19'] }, work: { type: 'string' } },
      required: ['files'],
    });
    expect(run?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        testbench: { type: 'string' }, files: { type: 'array' }, std: { enum: ['93', '02', '08', '19'] },
        stopTime: { type: 'string' }, generics: { type: 'object' },
        wave: { type: 'object', properties: { file: { type: 'string' }, format: { enum: ['vcd', 'fst'] } } },
      },
      required: ['testbench', 'files'],
    });
  });

  it('rejects invalid VHDL options before running anything', async () => {
    const client = await connect();

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['vhdl_compile', { files: ['a.vhd'], std: '87' }, 'std'],
      ['vhdl_compile', { files: [] }, 'files'],
      ['vhdl_compile', { files: ['a.vhd'], work: '../lib' }, 'work'],
      ['vhdl_run', { testbench: '-rf', files: ['a.vhd'] }, 'testbench'],
      ['vhdl_run', { testbench: 'tb', files: ['a.vhd'], stopTime: 'soon' }, 'stopTime'],
      ['vhdl_run', { testbench: 'tb', files: ['a.vhd'], generics: { 'bad name': '1' } }, 'generics'],
      ['vhdl_run', { testbench: 'tb', files: ['a.vhd'], wave: { file: 'out.vcd', format: 'ghw' } }, 'wave'],
    ];
    for (const [name, input, message] of cases) {
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.stringify(result.content), JSON.stringify(input)).toContain(message);
    }
  });
});

describe.runIf(simulatorAvailable())('VHDL tools with nvc', () => {
  it('reads the version nvc reports', async () => {
    const version = await createNvcSimulator({ executable: simulator }).version({ timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });

    expect(version).toMatch(/^\d+\.\d+/);
  });

  it('compiles correct files', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.compile({ files: ['half_adder.vhd', 'half_adder_tb.vhd'] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, diagnostics: [], stderr: '' });
  });

  it('reports a syntax error with its file and line', async () => {
    const root = await workspaceWith(['syntax_error.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.compile({ files: ['syntax_error.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      diagnostics: [{ severity: 'error', file: join(root, 'syntax_error.vhd'), line: 6, column: 1 }],
    });
    expect(JSON.stringify(result.content)).toContain('syntax_error.vhd:6:1');
  });

  it('refuses a file outside the workspace', async () => {
    const root = await workspaceWith([]);
    const handlers = await handlersFor(root);

    await expect(handlers.compile({ files: [join(fixtures, 'half_adder.vhd')] })).rejects.toThrow(
      'outside the configured workspace folders',
    );
  });

  it('compiles VHDL-2008 code only under a 2008 or later standard', async () => {
    const root = await workspaceWith(['vhdl2008_tb.vhd']);
    const handlers = await handlersFor(root);

    const strict = await handlers.compile({ files: ['vhdl2008_tb.vhd'], std: '93' });
    const modern = await handlers.compile({ files: ['vhdl2008_tb.vhd'], std: '08' });

    expect(strict.structuredContent).toMatchObject({
      ok: false, diagnostics: [{ severity: 'error', file: join(root, 'vhdl2008_tb.vhd'), line: 7 }],
    });
    expect(modern.structuredContent).toMatchObject({ ok: true, diagnostics: [] });
  });

  it('runs a passing testbench and returns its report', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    const handlers = await handlersFor(root);
    const before = await libraryFolders();

    const result = await handlers.run({ testbench: 'half_adder_tb', files: ['half_adder.vhd', 'half_adder_tb.vhd'] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      exitCode: 0,
      diagnostics: [],
      messages: [{
        time: '10ns', severity: 'note', text: 'half adder passed',
        source: { file: join(root, 'half_adder_tb.vhd'), line: 18, column: 5 },
      }],
    });
    expect((await readdir(root)).sort()).toEqual(['half_adder.vhd', 'half_adder_tb.vhd']);
    expect(await libraryFolders()).toEqual(before);
  });

  it('stops at a failed assertion and reports its message and time', async () => {
    const root = await workspaceWith(['failing_tb.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.run({ testbench: 'failing_tb', files: ['failing_tb.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      exitCode: 1,
      messages: [{
        time: '20ns', severity: 'error', text: 'count is 5, expected 4',
        source: { file: join(root, 'failing_tb.vhd'), line: 12, column: 12 },
      }],
    });
    expect(JSON.stringify(result.content)).toContain('count is 5, expected 4');
  });

  it('warns that a testbench with an unbound component may silently pass', async () => {
    const root = await workspaceWith(['unbound_tb.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.run({ testbench: 'unbound_tb', files: ['unbound_tb.vhd'], std: '93' });

    const content = result.structuredContent as { diagnostics: Array<{ severity: string; message: string }> };
    expect(content).toMatchObject({
      ok: true,
      diagnostics: [{ severity: 'warning', file: join(root, 'unbound_tb.vhd'), line: 10 }],
      messages: [{ time: '10ns', text: 'unbound testbench finished' }],
    });
    expect(content.diagnostics[0]?.message).toMatch(/ADDER_CORE is unbound.*may silently pass/);
    expect(JSON.stringify(result.content)).toContain('ADDER_CORE is unbound');
  });

  it('does not run a testbench whose files fail to analyse', async () => {
    const root = await workspaceWith(['syntax_error.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.run({ testbench: 'broken', files: ['syntax_error.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false, messages: [], diagnostics: [{ severity: 'error', line: 6 }],
    });
  });

  it('applies generics and the stop time', async () => {
    const root = await workspaceWith(['clock_tb.vhd']);
    const handlers = await handlersFor(root);

    const result = await handlers.run({
      testbench: 'clock_tb', files: ['clock_tb.vhd'], generics: { period: '20 ns' }, stopTime: '1 us',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true, messages: [{ time: '100ns', text: 'rising edges in 100 ns: 5' }],
    });
  });

  it('writes a VCD wave file into the workspace that wave_query reads', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    await mkdir(join(root, 'waves'));
    const workspace = await Workspace.create(root);
    const handlers = await handlersFor(root);

    const result = await handlers.run({
      testbench: 'half_adder_tb', files: ['half_adder.vhd', 'half_adder_tb.vhd'], wave: { file: 'waves/adder.vcd' },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true, wave: { file: join(root, 'waves', 'adder.vcd'), format: 'vcd' },
    });
    const query = await createWaveQuery({ workspace, waveMaxBytes: 1024 * 1024 })({
      file: 'waves/adder.vcd', signals: ['half_adder_tb.sum', 'half_adder_tb.carry'], times: ['10 ns'],
    });
    expect(query.structuredContent).toMatchObject({
      values: [{ time: '10 ns', 'half_adder_tb.sum': { bits: '0' }, 'half_adder_tb.carry': { bits: '1' } }],
    });
  });

  it('writes an FST wave file that wave_query reads the same as the VCD of the same run', async () => {
    const root = await workspaceWith(['alu.vhd', 'tb_alu.vhd'], waveFixtures);
    const handlers = await handlersFor(root);
    const run = (file: string) => handlers.run({ testbench: 'tb_alu', files: ['alu.vhd', 'tb_alu.vhd'], wave: { file } });

    expect((await run('alu.fst')).structuredContent).toMatchObject({ ok: true, wave: { file: join(root, 'alu.fst'), format: 'fst' } });
    expect((await run('alu.vcd')).structuredContent).toMatchObject({ ok: true, wave: { file: join(root, 'alu.vcd'), format: 'vcd' } });
    const query = createWaveQuery({ workspace: await Workspace.create(root), waveMaxBytes: 1024 * 1024 });
    const signals = ['tb_alu.s_a', 'tb_alu/dut/s_sum', 'TB_ALU.S_OVFL', 'tb_alu.s_late', 'tb_alu.s_ratio', 'tb_alu.s_step', 'tb_alu.s_phase'];
    const times = ['0 ns', '10 ns', '20 ns', '35 ns', '1 us'];

    const fst = await query({ file: 'alu.fst', signals, times });

    expect(fst).toEqual(await query({ file: 'alu.vcd', signals, times }));
    expect(fst.structuredContent).toMatchObject({
      startTime: '0 fs',
      endTime: '40 ns',
      values: [
        { time: '0 ns', 'tb_alu.s_a': { hex: '0x3' }, 'tb_alu.s_late': { bits: 'u' }, 'tb_alu.s_phase': { string: 'setup' } },
        { time: '10 ns', 'tb_alu.dut.s_sum': { signed: -8 }, 'tb_alu.s_ovfl': { bits: '1' }, 'tb_alu.s_ratio': { real: 0.25 } },
        { time: '20 ns', 'tb_alu.dut.s_sum': { hex: '0x7' }, 'tb_alu.s_late': { bits: '1' }, 'tb_alu.s_step': { signed: 2 } },
        { time: '35 ns', 'tb_alu.s_a': { bits: '01zx' }, 'tb_alu.s_ovfl': { bits: 'x' }, 'tb_alu.s_step': { signed: -1 } },
        { time: '1 us', beyond: 'after', 'tb_alu.dut.s_sum': { bits: 'xxxx' }, 'tb_alu.s_phase': { string: 'done' } },
      ],
    });
  });

  it('refuses a wave file outside the workspace', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    const handlers = await handlersFor(root);

    await expect(handlers.run({
      testbench: 'half_adder_tb', files: ['half_adder.vhd', 'half_adder_tb.vhd'], wave: { file: '../escape.vcd' },
    })).rejects.toThrow('outside the configured workspace folders');
  });

  it('refuses a wave file that is a dangling symlink leading out of the workspace', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    const outside = await mkdtemp(join(tmpdir(), 'vhdl-outside-'));
    await symlink(join(outside, 'escaped.vcd'), join(root, 'link.vcd'));
    const handlers = await handlersFor(root);

    await expect(handlers.run({
      testbench: 'half_adder_tb', files: ['half_adder.vhd', 'half_adder_tb.vhd'], wave: { file: 'link.vcd' },
    })).rejects.toThrow('Workspace output path is a symlink whose target does not exist: link.vcd');
    expect(await readdir(outside)).toEqual([]);
  });

  it('kills a run that passes the wall-clock limit', async () => {
    const root = await workspaceWith(['clock_tb.vhd']);
    const handlers = await handlersFor(root, { timeoutMs: 1500 });
    const before = await libraryFolders();

    const result = await handlers.run({ testbench: 'clock_tb', files: ['clock_tb.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, timedOut: true });
    expect(result.content).toEqual([{ type: 'text', text: 'Simulation timed out' }]);
    expect(await libraryFolders()).toEqual(before);
  });

  it('stops a run whose output passes the size limit', async () => {
    const root = await workspaceWith(['half_adder.vhd', 'half_adder_tb.vhd']);
    const handlers = await handlersFor(root, { maxOutputBytes: 40 });

    const result = await handlers.run({ testbench: 'half_adder_tb', files: ['half_adder.vhd', 'half_adder_tb.vhd'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, truncated: true });
  });
});
