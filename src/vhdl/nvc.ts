import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { parseNvcOutput } from './nvc-output.js';
import { runSimulatorProcess } from './process.js';
import type { VhdlCompileRequest, VhdlLimits, VhdlRunRequest, VhdlSimulator, VhdlStandard } from './simulator.js';

const STANDARDS: Record<VhdlStandard, string> = { '93': '1993', '02': '2002', '08': '2008', '19': '2019' };

// One nvc call analyses, then elaborates and runs; nvc stops at the first command that fails.
export function buildNvcArgs(request: VhdlCompileRequest | VhdlRunRequest, directory: string): string[] {
  const args = [
    '--messages=compact',
    `--std=${STANDARDS[request.std]}`,
    // "name:path" names the library and puts it in its own folder (nvc takes ";" on Windows).
    `--work=${request.work}${delimiter}${join(directory, request.work)}`,
    '-a', ...request.files,
  ];
  if (!('testbench' in request)) return args;
  args.push('-e', ...Object.entries(request.generics ?? {}).map(([name, value]) => `-g${name}=${value}`), request.testbench);
  // An assertion of severity error ends the run with a non-zero exit code.
  args.push('-r', '--exit-severity=error');
  if (request.stopTime !== undefined) args.push(`--stop-time=${request.stopTime.replace(/\s+/g, '')}`);
  if (request.wave !== undefined) args.push(`--wave=${request.wave.file}`, `--format=${request.wave.format}`);
  return args;
}

export function createNvcSimulator(options: { executable: string }): VhdlSimulator {
  // The library is written to a private folder that is removed afterwards, so nothing lands in the workspace.
  const execute = async (request: VhdlCompileRequest | VhdlRunRequest, limits: VhdlLimits) => {
    const directory = await mkdtemp(join(tmpdir(), 'vhdl-work-'));
    try {
      const result = await runSimulatorProcess({
        executable: options.executable,
        args: buildNvcArgs(request, directory),
        cwd: directory,
        // Compact messages are plain already; this keeps any other nvc output free of colour codes.
        env: { ...process.env, NVC_COLORS: 'never' },
        ...limits,
      });
      const { diagnostics, messages } = parseNvcOutput(result.stderr);
      const ok = result.exitCode === 0 && !result.timedOut && !result.truncated &&
        !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
      return { ok, ...result, diagnostics, messages };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return {
    name: 'nvc',
    executable: options.executable,
    // The first line reads like "nvc 1.23.0 (Using LLVM 23.1.1)".
    version: async (limits) => {
      const result = await runSimulatorProcess({
        executable: options.executable, args: ['--version'], cwd: tmpdir(), env: { ...process.env, NVC_COLORS: 'never' }, ...limits,
      });
      const output = `${result.stdout}${result.stderr}`.trim().slice(0, 200);
      if (result.timedOut) throw new Error(`${options.executable} --version did not finish within ${limits.timeoutMs} ms`);
      if (result.truncated) throw new Error(`${options.executable} --version printed more than ${limits.maxOutputBytes} bytes`);
      if (result.exitCode !== 0) throw new Error(`${options.executable} --version failed (exit ${result.exitCode ?? result.signal}): ${output}`);
      const version = /^nvc (\S+)/.exec(result.stdout)?.[1];
      if (version === undefined) throw new Error(`Unrecognised ${options.executable} --version output: ${output}`);
      return version;
    },
    // Analysis alone simulates nothing, so it has no messages.
    compile: async (request, limits) => {
      const { messages: _messages, ...result } = await execute(request, limits);
      return result;
    },
    run: (request, limits) => execute(request, limits),
  };
}
