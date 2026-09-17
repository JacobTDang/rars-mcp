import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadHardwareProject } from '../../src/hardware/manifest.js';
import type { HardwareLimits, ProviderCapability } from '../../src/hardware/types.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hardware');
const limits: HardwareLimits = {
  concurrency: 1, wallTimeSeconds: 120, memoryMb: 2048, pids: 256,
  outputBytes: 4_194_304, artifactMb: 512, sourceFiles: 10_000, sourceBytes: 268_435_456,
};
const capabilities: ProviderCapability[] = [
  { id: 'verilator', version: 'test', available: true, actions: ['lint', 'simulate'], languages: ['systemverilog'], standards: ['1800-2017'], artifactFormats: ['vcd', 'fst'], optionSchema: { traceDepth: { type: 'integer', minimum: 0, maximum: 99 } } },
  { id: 'ghdl', version: 'test', available: true, actions: ['analyze', 'simulate'], languages: ['vhdl'], standards: ['08'], artifactFormats: ['vcd', 'fst', 'ghw'] },
  { id: 'repository-command', version: '1', available: true, actions: ['test'], languages: [], standards: [], artifactFormats: [] },
];

describe('hardware project manifest', () => {
  it('loads a valid target with deterministic sources and reduced limits', async () => {
    const root = join(fixtureRoot, 'systemverilog');
    const project = await loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false);

    expect(project.name).toBe('sv-adder');
    expect(project.targets.unit).toMatchObject({
      provider: 'verilator',
      sources: ['rtl/adder.sv'],
      effectiveLimits: { wallTimeSeconds: 30, memoryMb: 2048 },
    });
  });

  it('rejects source traversal and empty source expansion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hardware-manifest-'));
    await writeFile(join(root, 'hardware.project.yaml'), `
version: 1
name: bad
sources: [../outside.sv]
targets:
  unit: { provider: verilator, language: systemverilog, standard: "1800-2017", top: x, action: lint }
`);
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/workspace|source/i);

    await writeFile(join(root, 'hardware.project.yaml'), `
version: 1
name: empty
sources: [rtl/**/*.sv]
targets:
  unit: { provider: verilator, language: systemverilog, standard: "1800-2017", top: x, action: lint }
`);
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/no source/i);
  });

  it('rejects a symlink source that escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hardware-manifest-'));
    const outside = await mkdtemp(join(tmpdir(), 'hardware-outside-'));
    await mkdir(join(root, 'rtl'));
    await writeFile(join(outside, 'escape.sv'), 'module escape; endmodule');
    await symlink(join(outside, 'escape.sv'), join(root, 'rtl', 'escape.sv'));
    await writeFile(join(root, 'hardware.project.yaml'), `
version: 1
name: escape
sources: [rtl/*.sv]
targets:
  unit: { provider: verilator, language: systemverilog, standard: "1800-2017", top: escape, action: lint }
`);

    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/outside/i);
  });

  it('requires both opt-ins for repository commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hardware-manifest-'));
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(root, 'hardware.project.yaml'), `
version: 1
name: course
sources: [run.sh]
targets:
  course:
    provider: repository-command
    action: test
    command: [./run.sh]
    allow_repository_command: true
`);

    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/disabled/i);
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, true)).resolves.toMatchObject({ name: 'course' });
  });

  it('rejects unsupported capabilities and raised limits', async () => {
    const root = join(fixtureRoot, 'vhdl');
    const unavailable = capabilities.map((capability) => capability.id === 'ghdl' ? { ...capability, available: false } : capability);
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, unavailable, false)).rejects.toThrow(/unavailable/i);

    const tiny = { ...limits, wallTimeSeconds: 1 };
    await expect(loadHardwareProject(join(fixtureRoot, 'systemverilog'), 'hardware.project.yaml', tiny, capabilities, false)).rejects.toThrow(/wall_time_seconds/i);
  });

  it('accepts typed provider options and rejects unknown or ill-typed options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hardware-options-'));
    await writeFile(join(root, 'top.sv'), 'module top; endmodule\n');
    const writeManifest = async (options: string) => writeFile(join(root, 'hardware.project.yaml'), `
version: 1
name: options
sources: [top.sv]
targets:
  unit:
    provider: verilator
    action: lint
    language: systemverilog
    standard: "1800-2017"
    top: top
    options: ${options}
`);
    await writeManifest('{ traceDepth: 4 }');
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).resolves.toMatchObject({ targets: { unit: { options: { traceDepth: 4 } } } });
    await writeManifest('{ shell: bash }');
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/unknown provider option/i);
    await writeManifest('{ traceDepth: huge }');
    await expect(loadHardwareProject(root, 'hardware.project.yaml', limits, capabilities, false)).rejects.toThrow(/traceDepth/i);
  });
});
