import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildRarsArgs, runRars } from '../src/rars/cli.js';
import { parseDiagnostics } from '../src/rars/diagnostics.js';

describe('buildRarsArgs', () => {
  it('puts program arguments after all source files', () => {
    expect(
      buildRarsArgs({
        mode: 'run',
        files: ['main.asm', 'library.asm'],
        programArgs: ['one', 'two'],
      }),
    ).toEqual(['nc', 'me', 'main.asm', 'library.asm', 'pa', 'one', 'two']);
  });

  it('asks for the instruction count before register and file arguments', () => {
    expect(buildRarsArgs({ mode: 'run', files: ['main.asm'], instructionCount: true, registers: ['t0'] })).toEqual([
      'nc', 'me', 'ic', 't0', 'main.asm',
    ]);
  });

  it('uses assemble-only mode', () => {
    expect(buildRarsArgs({ mode: 'assemble', files: ['main.asm'] })).toEqual([
      'nc',
      'me',
      'a',
      'main.asm',
    ]);
  });
});

describe.runIf(process.env.RARS_JAR)('runRars', () => {
  it('runs a program and captures output', async () => {
    const result = await runRars({
      javaExecutable: 'java',
      rarsJar: process.env.RARS_JAR!,
      cwd: resolve('tests/fixtures'),
      request: { mode: 'run', files: ['hello.asm'] },
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect(result.stdout).toContain('hello from rars');
  });

  it('returns structured assembly diagnostics', async () => {
    const result = await runRars({
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!,
      cwd: resolve('tests/fixtures'), request: { mode: 'assemble', files: ['invalid.asm'] },
      timeoutMs: 2_000, maxOutputBytes: 64 * 1024,
    });

    expect(parseDiagnostics(result.stderr)).toMatchObject([
      { severity: 'error', line: 3, column: 3 },
    ]);
  });

  it('kills a program that exceeds its wall-clock limit', async () => {
    const result = await runRars({
      javaExecutable: 'java', rarsJar: process.env.RARS_JAR!,
      cwd: resolve('tests/fixtures'), request: { mode: 'run', files: ['infinite.asm'] },
      timeoutMs: 250, maxOutputBytes: 64 * 1024,
    });

    expect(result.timedOut).toBe(true);
  });
});
