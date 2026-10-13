import { access, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
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
  steps: Array<{ command: string; args: string[]; folder?: string }>;
  compiles: Array<{ file: string; resolved: string; exists: boolean; library: string; std?: string; list?: string; order: number }>;
  missing: string[];
  libraries: string[];
  simulate?: { top?: string; args: string[] };
  errors: Array<{ message: string; file?: string; line?: number; step?: number }>;
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

    expect(report.errors).toEqual([{ file: join(root, 'syntax.do'), line: 3, message: 'missing close-brace', step: 2 }]);
    expect(report.steps.map((step) => step.command)).toEqual(['vlib', 'vcom']);
    expect(report.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(text).toContain('syntax.do:3: missing close-brace');
  });

  it('reports an error inside a nested do file once, at its own file and line', async () => {
    const { report, root } = await check({ path: 'nested-error.do' });

    expect(report.errors).toEqual([{ file: join(root, 'syntax.do'), line: 3, message: 'missing close-brace', step: 4 }]);
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

    expect(report.errors).toEqual([{ file: join(root, 'run.do'), line: 3, message: 'No such file: absent.do', step: 2 }]);
    expect(report.ok).toBe(false);
  });

  it('does not reveal files outside the workspace', async () => {
    const root = await scratchWorkspace({ 'run.do': 'vcom ../outside.vhd\ndo ../outside.do\n' });

    const { text, report } = await check({ path: 'run.do' }, root);

    expect(text).toContain('1. ../outside.vhd into work, outside the workspace');
    expect(report.compiles).toEqual([expect.objectContaining({ file: '../outside.vhd', exists: false })]);
    expect(report.missing).toEqual([]);
    expect(report.errors).toEqual([
      { file: join(root, 'run.do'), line: 2, message: 'Path is outside the workspace folders: ../outside.do', step: 2 },
      { message: 'Compiled file is outside the workspace folders: ../outside.vhd' },
    ]);
  });

  it('runs the script without shell or file access', async () => {
    const root = await scratchWorkspace({ 'run.do': 'exec touch pwned\n' });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([{ file: join(root, 'run.do'), line: 1, message: 'invalid command name "exec"', step: 0 }]);
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

  it('compiles the files a recursive glob finds, packages first', async () => {
    const { result, report, root } = await check({ path: 'glob/compile.do' });
    const folder = join(root, 'glob');

    expect(report.errors).toEqual([]);
    expect(report.compiles.map(({ file, exists, std, order }) => ({ file, exists, std, order }))).toEqual([
      { file: 'src/cpu_pkg.vhd', exists: true, std: '2008', order: 1 },
      { file: 'src/alu.vhd', exists: true, std: '2008', order: 2 },
      { file: 'src/regfile.vhd', exists: true, std: '2008', order: 3 },
      { file: 'src/control/decoder.vhd', exists: true, std: '2008', order: 4 },
      { file: 'src/control/fsm.vhd', exists: true, std: '2008', order: 5 },
      { file: join(folder, 'tb/cpu_tb.vhd'), exists: true, std: '2008', order: 6 },
    ]);
    expect(report.cwd).toBe(folder);
    expect(report.simulate?.top).toBe('work.cpu_tb');
    expect(report.ok).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('fails loudly when a glob leads outside the workspace, even with -nocomplain', async () => {
    const recurse = 'proc vhd_files_under {dir} {\n'
      + '  set found [glob -nocomplain -type f [file join $dir *.vhd]]\n'
      + '  foreach sub [glob -nocomplain -type d [file join $dir *]] { set found [concat $found [vhd_files_under $sub]] }\n'
      + '  return $found\n'
      + '}\n';
    const parent = await scratchWorkspace({
      'outside/secret.vhd': '',
      'project/a.vhd': '',
      'project/parent.do': `${recurse}foreach file [vhd_files_under ..] { vcom $file }\n`,
      'project/directory.do': 'vlib work\nvcom [glob -nocomplain -directory ../outside *.vhd]\n',
      'project/link.do': 'vlib work\nvcom [glob -nocomplain -type f link/*.vhd]\n',
    });
    const root = join(parent, 'project');
    await symlink(join(parent, 'outside'), join(root, 'link'));

    const scripts = [['parent.do', 6, '..', 0], ['directory.do', 2, '../outside', 1], ['link.do', 2, 'link', 1]] as const;
    for (const [script, line, path, step] of scripts) {
      const { result, report } = await check({ path: script }, root);

      expect(report.errors).toEqual([{ file: join(root, script), line, message: `Path is outside the workspace folders: ${path}`, step }]);
      expect(report.compiles).toEqual([]);
      expect(JSON.stringify(report)).not.toContain('secret');
      expect(result.isError).toBe(true);
    }
  });

  it('supports the glob forms Questa scripts use and returns paths as the script wrote them', async () => {
    const script = [
      'puts [glob rtl/*.vhd]',
      'puts [glob ./rtl/*.vhd tb/*.vhd]',
      'puts [glob -directory rtl -type f *]',
      'puts [glob -tails -directory rtl *.vhd]',
      'puts [glob -types d rtl/*]',
      'puts [glob -dir rtl -types {f d} -- *]',
      'puts [glob -nocomplain *.missing]',
      'puts [glob rtl/a.vhd rtl/absent.vhd]',
      'puts [glob */*.vhd]',
      'puts [glob "{rtl,tb}/*.vhd"]',
      'puts [glob [file join [pwd] tb *.vhd]]',
      'puts [pwd]',
    ].join('\n');
    const root = await scratchWorkspace({
      'rtl/a.vhd': '', 'rtl/b.vhd': '', 'rtl/.hidden.vhd': '', 'rtl/notes.txt': '', 'rtl/sub/c.vhd': '', 'tb/tb.vhd': '',
      'run.do': `${script}\n`,
    });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([]);
    expect(report.steps.map((step) => step.args)).toEqual([
      ['rtl/a.vhd rtl/b.vhd'],
      ['./rtl/a.vhd ./rtl/b.vhd tb/tb.vhd'],
      ['rtl/a.vhd rtl/b.vhd rtl/notes.txt'],
      ['a.vhd b.vhd'],
      ['rtl/sub'],
      ['rtl/a.vhd rtl/b.vhd rtl/notes.txt rtl/sub'],
      [''],
      ['rtl/a.vhd'],
      ['rtl/a.vhd rtl/b.vhd tb/tb.vhd'],
      ['rtl/a.vhd rtl/b.vhd tb/tb.vhd'],
      [join(root, 'tb/tb.vhd')],
      [root],
    ]);
  });

  it('names an unsupported glob option instead of matching nothing', async () => {
    const script = [
      'glob -join rtl *.vhd',
      'glob -path rtl/ *.vhd',
      'glob -types l *',
      'glob -bogus *',
      'glob -tails *',
      'glob nothing*',
      'glob nothing* none*',
      'glob -directory',
      'glob',
      'glob ~/*.vhd',
      'pwd extra',
    ].map((command) => `catch {${command}} message; puts $message`).join('\n');
    const root = await scratchWorkspace({ 'run.do': `${script}\nglob -nocomplain -type f -join rtl *.vhd\nvcom never.vhd\n` });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.steps.map((step) => step.args[0])).toEqual([
      'glob -join is not available in a dry run',
      'glob -path is not available in a dry run',
      'glob -types l is not available in a dry run',
      'bad option "-bogus": must be -directory, -nocomplain, -tails, -types, or --',
      '"-tails" must be used with "-directory"',
      'no files matched glob pattern "nothing*"',
      'no files matched glob patterns "nothing* none*"',
      'missing argument to "-directory"',
      'wrong # args: should be "glob ?switches? name ?name ...?"',
      'glob cannot expand ~ in a dry run: ~/*.vhd',
      'wrong # args: should be "pwd"',
    ]);
    expect(report.errors).toEqual([{ file: join(root, 'run.do'), line: 12, message: 'glob -join is not available in a dry run', step: 11 }]);
    expect(report.compiles).toEqual([]);
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

  it('runs a Questa tutorial script and the wave.do it loads through to the end', async () => {
    const { result, report } = await check({ path: 'tutorial.do' });

    expect(report.errors).toEqual([]);
    expect(report.steps.map((step) => step.command)).toEqual([
      'onbreak', 'transcript', 'vlib', 'vmap', 'vcom', 'vsim', 'do',
      'onerror', 'WaveActivateNextPane', 'add', 'add', 'add', 'SetDefaultTree', 'TreeUpdate', 'WaveRestoreCursors', 'wave',
      ...Array<string>(13).fill('configure'), 'WaveRestoreZoom',
      'log', 'nolog', 'property', 'vcd', 'vcd', 'when', 'bp', 'force', 'run', 'examine', 'echo', 'bookmark', 'step', 'bd',
      'nowhen', 'noforce', 'run', 'wave', 'write', 'coverage', 'simstats', 'quit',
    ]);
    expect(report.steps.find((step) => step.command === 'when')?.args)
      .toEqual(['-label', 'reached', '/counter_tb/count = "1000"', '\n  echo "count reached 8 at $now"\n  stop\n']);
    expect(report.compiles.map(({ file, exists }) => ({ file, exists }))).toEqual([
      { file: 'rtl/counter.vhd', exists: true },
      { file: 'tb/counter_tb.vhd', exists: true },
    ]);
    expect(report.simulate?.top).toBe('work.counter_tb');
    expect(report.ok).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('records the other Questa simulator commands as steps and carries on', async () => {
    const commands = [
      'when', 'nowhen', 'examine', 'describe', 'find', 'bp', 'bd', 'bookmark', 'step', 'change', 'vcd', 'nolog', 'property',
      'delete', 'virtual', 'dataset', 'compare', 'mem', 'coverage', 'vcover', 'toggle', 'profile', 'assertion', 'layout',
      'noview', 'write', 'simstats', 'vdir', 'WaveActivateNextPane', 'WaveRestoreCursors', 'WaveRestoreZoom', 'TreeUpdate',
      'SetDefaultTree',
    ];
    const root = await scratchWorkspace({ 'run.do': `${commands.map((command) => `${command} -option value`).join('\n')}\nvsim tb\n` });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([]);
    expect(report.steps).toEqual([
      ...commands.map((command) => ({ command, args: ['-option', 'value'] })),
      { command: 'vsim', args: ['tb'] },
    ]);
  });

  it('resolves paths from the folder cd moves to and reports each move', async () => {
    const root = await scratchWorkspace({
      'rtl/a.vhd': '', 'rtl/b.vhd': '', 'rtl/files.txt': 'b.vhd\n', 'tb/tb.vhd': '', 'tb/setup.do': 'cd ../tb\n',
      'run.do': [
        'cd rtl',
        'vcom a.vhd',
        'puts [pwd]',
        'puts [glob *.vhd]',
        'puts [file exists b.vhd]',
        'vcom -f files.txt',
        'do ../tb/setup.do',
        'vcom tb.vhd',
        'cd ..',
        'vcom rtl/b.vhd',
      ].join('\n'),
    });

    const { result, text, report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([]);
    expect(report.steps).toEqual([
      { command: 'cd', args: ['rtl'], folder: join(root, 'rtl') },
      { command: 'vcom', args: ['a.vhd'] },
      { command: 'puts', args: [join(root, 'rtl')] },
      { command: 'puts', args: ['a.vhd b.vhd'] },
      { command: 'puts', args: ['1'] },
      { command: 'vcom', args: ['-f', 'files.txt'] },
      { command: 'do', args: ['../tb/setup.do'] },
      { command: 'cd', args: ['../tb'], folder: join(root, 'tb') },
      { command: 'vcom', args: ['tb.vhd'] },
      { command: 'cd', args: ['..'], folder: root },
      { command: 'vcom', args: ['rtl/b.vhd'] },
    ]);
    expect(report.compiles.map(({ file, resolved, exists }) => ({ file, resolved, exists }))).toEqual([
      { file: 'a.vhd', resolved: join(root, 'rtl/a.vhd'), exists: true },
      { file: 'b.vhd', resolved: join(root, 'rtl/b.vhd'), exists: true },
      { file: 'tb.vhd', resolved: join(root, 'tb/tb.vhd'), exists: true },
      { file: 'rtl/b.vhd', resolved: join(root, 'rtl/b.vhd'), exists: true },
    ]);
    expect(report.cwd).toBe(root);
    expect(report.ok).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(text).toContain(`cd moves to ${join(root, 'rtl')}, then ${join(root, 'tb')}, then ${root}.`);
    expect(text).toContain('1. a.vhd (rtl/a.vhd) into work');
    expect(text).toContain('4. rtl/b.vhd into work');
  });

  it('refuses a cd outside the workspace, to a missing folder or to a file', async () => {
    const parent = await scratchWorkspace({ 'outside/secret.vhd': '', 'project/a.vhd': '', 'project/sub/b.vhd': '' });
    const root = join(parent, 'project');
    await symlink(join(parent, 'outside'), join(root, 'link'));
    const attempts = ['cd ..', 'cd link', 'cd absent', 'cd a.vhd', 'cd', 'cd sub extra', 'cd ~', 'cd ~/sub']
      .map((command) => `catch {${command}} message; puts $message`);
    await writeFile(join(root, 'run.do'), `${attempts.join('\n')}\nputs [pwd]\ncd ../..\nvcom never.vhd\n`);

    const { result, report } = await check({ path: 'run.do' }, root);

    expect(report.steps.filter((step) => step.command === 'puts').map((step) => step.args[0])).toEqual([
      'Path is outside the workspace folders: ..',
      'Path is outside the workspace folders: link',
      'couldn\'t change working directory to "absent": no such file or directory',
      'couldn\'t change working directory to "a.vhd": not a directory',
      'cd without a folder is not available in a dry run',
      'wrong # args: should be "cd ?dirName?"',
      'cd cannot expand ~ in a dry run: ~',
      'cd cannot expand ~ in a dry run: ~/sub',
      root,
    ]);
    expect(report.steps.filter((step) => step.command === 'cd')).toEqual([
      { command: 'cd', args: ['..'] }, { command: 'cd', args: ['link'] }, { command: 'cd', args: ['absent'] },
      { command: 'cd', args: ['a.vhd'] }, { command: 'cd', args: [] }, { command: 'cd', args: ['sub', 'extra'] },
      { command: 'cd', args: ['~'] }, { command: 'cd', args: ['~/sub'] }, { command: 'cd', args: ['../..'] },
    ]);
    expect(report.errors).toEqual([
      { file: join(root, 'run.do'), line: 10, message: 'Path is outside the workspace folders: ../..', step: 18 },
    ]);
    expect(report.compiles).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(result.isError).toBe(true);
  });

  it('keeps each lookup answer on one line when a path has a line break', async () => {
    const script = 'catch {cd "x\\ny"} message; puts $message\ncatch {do "x\\ny"} message; puts $message\nputs [file exists rtl]\n';
    const root = await scratchWorkspace({ 'rtl/a.vhd': '', 'run.do': script });

    const { report } = await check({ path: 'run.do' }, root);

    expect(report.errors).toEqual([]);
    expect(report.steps.filter((step) => step.command === 'puts').map((step) => step.args[0])).toEqual([
      'couldn\'t change working directory to "x y": no such file or directory',
      'No such file: x y',
      '1',
    ]);
  });

  it('continues past errors after onerror {resume}, recording each with the steps before it', async () => {
    const root = await scratchWorkspace({
      'a.vhd': '',
      'run.do': 'onerror { resume }\nvlib work\nbogus arg\nvcom a.vhd\ndo absent.do\nif {1} {\n  error "inside a block"\n}\nvsim tb\n',
    });

    const { result, report } = await check({ path: 'run.do' }, root);

    expect(report.steps.map((step) => step.command)).toEqual(['onerror', 'vlib', 'vcom', 'do', 'vsim']);
    expect(report.errors).toEqual([
      { file: join(root, 'run.do'), line: 3, message: 'invalid command name "bogus"', step: 2 },
      { file: join(root, 'run.do'), line: 5, message: 'No such file: absent.do', step: 4 },
      { file: join(root, 'run.do'), line: 7, message: 'inside a block', step: 4 },
    ]);
    expect(report.compiles.map((entry) => entry.file)).toEqual(['a.vhd']);
    expect(report.simulate?.top).toBe('tb');
    expect(report.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('stops at the first error with onerror {quit -f}, with no handler, and once the handler is cleared', async () => {
    const scripts = {
      'quit.do': 'onerror {quit -f}\nvlib work\nbogus\nvcom never.vhd\n',
      'none.do': 'vlib work\nbogus\nvcom never.vhd\n',
      'cleared.do': 'onerror {resume}\nbogus\nonerror {}\nbogus\nvcom never.vhd\n',
      'quits.do': 'onerror {resume}\nquit -f\nvcom never.vhd\n',
    };
    const root = await scratchWorkspace(scripts);

    const results = await Promise.all(Object.keys(scripts).map(async (path) => (await check({ path }, root)).report));

    expect(results.map((report) => report.steps.map((step) => step.command))).toEqual([
      ['onerror', 'vlib'], ['vlib'], ['onerror', 'onerror'], ['onerror', 'quit'],
    ]);
    expect(results.map((report) => report.errors.map(({ line, step }) => ({ line, step })))).toEqual([
      [{ line: 3, step: 2 }], [{ line: 2, step: 1 }], [{ line: 2, step: 1 }, { line: 4, step: 2 }], [],
    ]);
    expect(results.every((report) => report.compiles.length === 0)).toBe(true);
  });

  it('applies onerror to the do file that sets it and the files it runs', async () => {
    const root = await scratchWorkspace({
      'a.vhd': '',
      'wave.do': 'onerror {resume}\nbad_in_wave\nadd wave /tb/x\n',
      'loads-wave.do': 'do wave.do\nbad_after_wave\nvcom a.vhd\n',
      'inner.do': 'bad_inner\nvlog b.v\n',
      'inherits.do': 'onerror {resume}\ndo inner.do\nvcom a.vhd\n',
      'strict.do': 'onerror {}\nbad_strict\nvlog never.v\n',
      'resumes-after-nested.do': 'onerror {resume}\ndo strict.do\nvcom a.vhd\n',
    });

    const loadsWave = (await check({ path: 'loads-wave.do' }, root)).report;
    expect(loadsWave.steps.map((step) => step.command)).toEqual(['do', 'onerror', 'add']);
    expect(loadsWave.errors).toEqual([
      { file: join(root, 'wave.do'), line: 2, message: 'invalid command name "bad_in_wave"', step: 2 },
      { file: join(root, 'loads-wave.do'), line: 2, message: 'invalid command name "bad_after_wave"', step: 3 },
    ]);

    const inherits = (await check({ path: 'inherits.do' }, root)).report;
    expect(inherits.steps.map((step) => step.command)).toEqual(['onerror', 'do', 'vlog', 'vcom']);
    expect(inherits.errors).toEqual([{ file: join(root, 'inner.do'), line: 1, message: 'invalid command name "bad_inner"', step: 2 }]);

    const resumes = (await check({ path: 'resumes-after-nested.do' }, root)).report;
    expect(resumes.steps.map((step) => step.command)).toEqual(['onerror', 'do', 'onerror', 'vcom']);
    expect(resumes.errors).toEqual([{ file: join(root, 'strict.do'), line: 2, message: 'invalid command name "bad_strict"', step: 3 }]);
  });

  it('reports a compiled path that is a folder as a folder, not as missing', async () => {
    const root = await scratchWorkspace({ 'rtl/a.vhd': '', 'run.do': 'vcom rtl\nvlog rtl/\n' });

    const { result, text, report } = await check({ path: 'run.do' }, root);

    expect(report.compiles.map(({ file, exists }) => ({ file, exists }))).toEqual([{ file: 'rtl', exists: true }, { file: 'rtl/', exists: true }]);
    expect(report.missing).toEqual([]);
    expect(report.errors).toEqual([
      { message: 'Compiled path is a directory, not a file: rtl' },
      { message: 'Compiled path is a directory, not a file: rtl/' },
    ]);
    expect(text).toContain('2 files to compile, 0 missing.');
    expect(text).toContain('1. rtl into work, a directory');
    expect(result.isError).toBe(true);
  });

  it('compiles the files a vcom -f list names, as if written inline', async () => {
    const root = await scratchWorkspace({
      'rtl/pkg.vhd': '', 'rtl/a.vhd': '', 'tb/tb.vhd': '',
      'files.txt': '# RTL, packages first\n-2008\nrtl/pkg.vhd\n\nrtl/a.vhd   # the ALU\n// a Verilog-style comment\r\nrtl/absent.vhd\n-f lists/more.txt\n',
      'lists/more.txt': 'tb/tb.vhd',
      'run.do': 'vlib mylib\nvcom -work mylib -f files.txt\nvsim mylib.tb\n',
    });

    const { result, text, report } = await check({ path: 'run.do' }, root);

    expect(report.steps[1]).toEqual({ command: 'vcom', args: ['-work', 'mylib', '-f', 'files.txt'] });
    expect(report.compiles).toEqual([
      { file: 'rtl/pkg.vhd', resolved: join(root, 'rtl/pkg.vhd'), exists: true, library: 'mylib', std: '2008', list: 'files.txt', order: 1 },
      { file: 'rtl/a.vhd', resolved: join(root, 'rtl/a.vhd'), exists: true, library: 'mylib', std: '2008', list: 'files.txt', order: 2 },
      { file: 'rtl/absent.vhd', resolved: join(root, 'rtl/absent.vhd'), exists: false, library: 'mylib', std: '2008', list: 'files.txt', order: 3 },
      { file: 'tb/tb.vhd', resolved: join(root, 'tb/tb.vhd'), exists: true, library: 'mylib', std: '2008', list: 'lists/more.txt', order: 4 },
    ]);
    expect(report.missing).toEqual(['rtl/absent.vhd']);
    expect(report.errors).toEqual([]);
    expect(text).toContain('3. rtl/absent.vhd into mylib, std 2008, listed in files.txt, missing');
    expect(result.isError).toBe(true);
  });

  it('resolves a -F list from its own folder and names a list file it cannot read', async () => {
    const parent = await scratchWorkspace({
      'outside.f': 'secret.vhd\n',
      'project/a.vhd': '', 'project/end.vhd': '', 'project/ip/core.vhd': '', 'project/ip/sources.f': 'core.vhd\n',
      'project/loop.f': '-f loop.f\nend.vhd\n',
      'project/run.do': 'vcom -F ip/sources.f\nvcom -f absent.txt a.vhd\nvlog -f ip\nvcom -f ../outside.f\nvcom -f loop.f\n',
    });
    const root = join(parent, 'project');

    const { result, report } = await check({ path: 'run.do' }, root);

    expect(report.compiles.map(({ file, resolved, exists, list }) => ({ file, resolved, exists, list }))).toEqual([
      { file: 'core.vhd', resolved: join(root, 'ip/core.vhd'), exists: true, list: 'ip/sources.f' },
      { file: 'a.vhd', resolved: join(root, 'a.vhd'), exists: true, list: undefined },
      { file: 'end.vhd', resolved: join(root, 'end.vhd'), exists: true, list: 'loop.f' },
    ]);
    expect(report.errors).toEqual([
      { message: 'No such list file: absent.txt' },
      { message: 'List file is not a file: ip' },
      { message: 'List file is outside the workspace folders: ../outside.f' },
      { message: 'List file includes itself: loop.f' },
    ]);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(result.isError).toBe(true);
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
  it('skips vlog options and their values, reads -f lists and follows cd', async () => {
    const lists: Record<string, string> = { '/project/files.f': '-93 b.vhd\n', '/project/sim/tb.f': 'tb.vhd\n' };
    const readList = async (path: string, folder: string) => {
      const listPath = join(folder, path);
      const text = lists[listPath];
      return text === undefined ? { error: `No such list file: ${path}` } : { path: listPath, text };
    };

    const analysis = await analyzeSteps([
      { command: 'vlog', args: ['-sv', '+incdir+inc', '-work', 'lib', '-L', 'other', 'top.sv', 'pkg.sv'] },
      { command: 'vcom', args: ['-f', 'files.f', '-suppress', '1234', 'a.vhd'] },
      { command: 'vcom', args: ['-f', 'absent.f'] },
      { command: 'cd', args: ['sim'], folder: '/project/sim' },
      { command: 'vcom', args: ['-f', 'tb.f'] },
    ], { folder: '/project', readList });

    expect(analysis.compiles).toEqual([
      { file: 'top.sv', folder: '/project', library: 'lib', std: 'sv', order: 1 },
      { file: 'pkg.sv', folder: '/project', library: 'lib', std: 'sv', order: 2 },
      { file: 'b.vhd', folder: '/project', library: 'work', std: '93', list: 'files.f', order: 3 },
      { file: 'a.vhd', folder: '/project', library: 'work', std: '93', order: 4 },
      { file: 'tb.vhd', folder: '/project/sim', library: 'work', list: 'tb.f', order: 5 },
    ]);
    expect(analysis.errors).toEqual([{ message: 'No such list file: absent.f' }]);
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
