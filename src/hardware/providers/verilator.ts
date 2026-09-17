import { join, relative, sep } from 'node:path';

import { RarsError } from '../../errors.js';
import type { ArtifactRecord, HardwareDiagnostic, HardwareResult, ProcessResult, ProviderCapability, ProviderCommand, ProviderContext, ResolvedTarget } from '../types.js';
import type { HardwareProvider } from './provider.js';

export class VerilatorProvider implements HardwareProvider {
  constructor(private readonly version: string | null) {}

  async capability(): Promise<ProviderCapability> {
    return { id: 'verilator', version: this.version ?? 'unavailable', available: this.version !== null, ...(this.version === null ? { unavailableReason: 'verilator executable not found' } : {}), actions: ['lint', 'simulate'], languages: ['verilog', 'systemverilog'], standards: ['1364-2005', '1800-2017'], artifactFormats: ['vcd', 'fst'] };
  }

  validate(target: ResolvedTarget): void {
    if (!['lint', 'simulate'].includes(target.action)) throw new RarsError('INVALID_PROJECT', `Unsupported Verilator action: ${target.action}`);
    if (!target.top) throw new RarsError('INVALID_PROJECT', 'Verilator target requires top');
  }

  async commands(context: ProviderContext): Promise<ProviderCommand[]> {
    this.validate(context.target);
    const target = context.target;
    const common = ['--language', target.standard ?? '1800-2017', '--top-module', target.top as string];
    for (const define of target.defines) common.push(`-D${define}`);
    for (const directory of target.includeDirs) common.push(`-I${join(context.snapshotRoot, directory)}`);
    for (const [name, value] of Object.entries(target.parameters)) common.push(`-G${name}=${String(value)}`);
    const sources = target.sources.map((source) => join(context.snapshotRoot, source));
    const args = target.action === 'lint'
      ? ['--lint-only', ...common, ...sources]
      : ['--binary', '--timing', '--Mdir', context.buildRoot, ...this.traceArgs(target, context.artifactRoot), ...common, ...sources];
    return [{ executable: 'verilator', args, cwd: context.buildRoot, env: { PATH: process.env.PATH ?? '' }, limits: target.effectiveLimits }];
  }

  async parseResult(context: ProviderContext, results: ProcessResult[], artifacts: ArtifactRecord[]): Promise<HardwareResult> {
    const diagnostics: HardwareDiagnostic[] = [];
    const pattern = /^%(Error|Warning)(?:-[A-Z0-9_]+)?:\s+(.+?):(\d+):(\d+):\s*(.*)$/u;
    for (const result of results) {
      for (const line of result.stderr.split(/\r?\n/u)) {
        const match = pattern.exec(line);
        if (!match) continue;
        const [, level, file, lineNumber, column, message] = match;
        if (!level || !file || !lineNumber || !column || !message) continue;
        const normalized = relative(context.snapshotRoot, file).split(sep).join('/');
        diagnostics.push({ severity: level === 'Error' ? 'error' : 'warning', provider: 'verilator', phase: context.target.action, file: normalized, line: Number(lineNumber), column: Number(column), message, original: line });
      }
    }
    const last = results.at(-1);
    const success = results.length > 0 && results.every((result) => result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.truncated);
    return { success, summary: success ? 'Verilator completed' : 'Verilator failed', diagnostics, artifacts, exitCode: last?.exitCode ?? null, signal: last?.signal ?? null, ...this.reason(last) };
  }

  private traceArgs(target: ResolvedTarget, artifactRoot: string): string[] {
    const waveform = target.artifacts.waveform;
    if (waveform === 'fst') return ['--trace-fst'];
    if (waveform === 'vcd') return ['--trace-vcd'];
    return [];
  }

  private reason(result: ProcessResult | undefined): Pick<HardwareResult, 'reason'> {
    if (!result) return { reason: 'exit' };
    if (result.timedOut) return { reason: 'timeout' };
    if (result.cancelled) return { reason: 'cancelled' };
    if (result.truncated) return { reason: 'output_limit' };
    return { reason: 'exit' };
  }
}
