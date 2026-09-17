import { describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../src/hardware/providers/registry.js';
import { VerificationProvider } from '../../src/hardware/providers/verification.js';
import type { ProviderContext, ResolvedTarget } from '../../src/hardware/types.js';

const limits = { concurrency: 1, wallTimeSeconds: 30, memoryMb: 128, pids: 32, outputBytes: 1024, artifactMb: 1, sourceFiles: 10, sourceBytes: 1024 };
const context = (target: ResolvedTarget): ProviderContext => ({ target, snapshotRoot: '/snapshot', buildRoot: '/build', artifactRoot: '/artifacts' });

describe('hardware providers', () => {
  it('reports optional verification and reference providers without silently enabling missing tools', async () => {
    const registry = createProviderRegistry({ executableVersions: {}, allowRepositoryCommands: false });
    const capabilities = await registry.capabilities();
    expect(capabilities.find((item) => item.id === 'sby')).toMatchObject({ available: false, actions: expect.arrayContaining(['prove']) });
    expect(capabilities.find((item) => item.id === 'spike')).toMatchObject({ available: false, actions: ['trace'] });
    expect(capabilities.find((item) => item.id === 'spike')?.optionSchema).toMatchObject({ isa: { type: 'string' }, maxInstructions: { type: 'integer' } });
  });
  it('constructs argument-array Yosys commands', async () => {
    const provider = new VerificationProvider('yosys', 'Yosys 1');
    const target = { name: 'synth', provider: 'yosys', action: 'synthesize', language: 'verilog', top: 'flow.ys', sources: ['flow.ys'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: {}, effectiveLimits: limits };
    expect((await provider.commands({ target, snapshotRoot: '/source', buildRoot: '/build', artifactRoot: '/artifacts' }))[0]).toMatchObject({ executable: 'yosys', args: ['-l', '/artifacts/yosys.log', '-s', '/source/flow.ys'] });
  });
  it('builds exact Verilator lint arguments', async () => {
    const registry = createProviderRegistry({ executableVersions: { verilator: '5.0', ghdl: '4.0' }, allowRepositoryCommands: true });
    const target: ResolvedTarget = { name: 'lint', provider: 'verilator', action: 'lint', language: 'systemverilog', standard: '1800-2017', top: 'adder', sources: ['rtl/adder.sv'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: {}, effectiveLimits: limits };
    const commands = await registry.get('verilator').commands(context(target));
    expect(commands).toEqual([expect.objectContaining({ executable: 'verilator', args: ['--lint-only', '--language', '1800-2017', '--top-module', 'adder', '/snapshot/rtl/adder.sv'] })]);
  });

  it('builds GHDL analyze, elaborate, and run commands', async () => {
    const registry = createProviderRegistry({ executableVersions: { verilator: '5.0', ghdl: '4.0' }, allowRepositoryCommands: true });
    const target: ResolvedTarget = { name: 'sim', provider: 'ghdl', action: 'simulate', language: 'vhdl', standard: '08', top: 'adder', sources: ['rtl/adder.vhd'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: { waveform: 'ghw' }, effectiveLimits: limits };
    const commands = await registry.get('ghdl').commands(context(target));
    expect(commands.map((command) => command.args)).toEqual([
      ['-a', '--std=08', '--workdir=/build', '/snapshot/rtl/adder.vhd'],
      ['-e', '--std=08', '--workdir=/build', 'adder'],
      ['-r', '--std=08', '--workdir=/build', 'adder', '--wave=/artifacts/wave.ghw'],
    ]);
  });

  it('keeps repository commands inside the snapshot and never uses a shell', async () => {
    const registry = createProviderRegistry({ executableVersions: {}, allowRepositoryCommands: true });
    const target: ResolvedTarget = { name: 'course', provider: 'repository-command', action: 'test', sources: ['run.sh'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: {}, command: ['./run.sh', 'test'], effectiveLimits: limits };
    const [command] = await registry.get('repository-command').commands(context(target));
    expect(command).toMatchObject({ executable: '/snapshot/run.sh', args: ['test'], cwd: '/build' });
  });

  it('normalizes provider diagnostics and reports unavailable executables', async () => {
    const registry = createProviderRegistry({ executableVersions: { verilator: null, ghdl: '4.0' }, allowRepositoryCommands: false });
    expect((await registry.capabilities()).find((item) => item.id === 'verilator')).toMatchObject({ available: false });
    const target: ResolvedTarget = { name: 'lint', provider: 'verilator', action: 'lint', language: 'systemverilog', standard: '1800-2017', top: 'adder', sources: ['rtl/adder.sv'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: {}, effectiveLimits: limits };
    const result = await registry.get('verilator').parseResult(context(target), [{ exitCode: 1, signal: null, stdout: '', stderr: '%Error: /snapshot/rtl/adder.sv:3:4: syntax error\n', timedOut: false, cancelled: false, truncated: false, durationMs: 1, executable: 'verilator', args: [] }], []);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', file: 'rtl/adder.sv', line: 3, column: 4 });
  });
});
