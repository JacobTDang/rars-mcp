import { join } from 'node:path';

import { RarsError } from '../../errors.js';
import type { ArtifactRecord, HardwareResult, ProcessResult, ProviderCapability, ProviderCommand, ProviderContext, ResolvedTarget } from '../types.js';
import type { HardwareProvider } from './provider.js';

export class GhdlProvider implements HardwareProvider {
  constructor(private readonly version: string | null) {}
  async capability(): Promise<ProviderCapability> { return { id: 'ghdl', version: this.version ?? 'unavailable', available: this.version !== null, ...(this.version === null ? { unavailableReason: 'ghdl executable not found' } : {}), actions: ['analyze', 'simulate'], languages: ['vhdl'], standards: ['87', '93', '02', '08'], artifactFormats: ['vcd', 'fst', 'ghw'], optionSchema: { assertLevel: { type: 'string', enum: ['note', 'warning', 'error', 'failure', 'none'] }, stopTime: { type: 'string', pattern: '^[1-9][0-9]*(fs|ps|ns|us|ms|sec)$' } } }; }
  validate(target: ResolvedTarget): void { if (!target.top) throw new RarsError('INVALID_PROJECT', 'GHDL target requires top'); }
  async commands(context: ProviderContext): Promise<ProviderCommand[]> {
    this.validate(context.target);
    const target = context.target;
    const standard = `--std=${target.standard ?? '93'}`;
    const workdir = `--workdir=${context.buildRoot}`;
    const base = { executable: 'ghdl', cwd: context.buildRoot, env: { PATH: process.env.PATH ?? '' }, limits: target.effectiveLimits };
    const analyze: ProviderCommand = { ...base, args: ['-a', standard, workdir, ...target.sources.map((source) => join(context.snapshotRoot, source))] };
    if (target.action === 'analyze') return [analyze];
    if (target.action !== 'simulate') throw new RarsError('INVALID_PROJECT', `Unsupported GHDL action: ${target.action}`);
    const runArgs = ['-r', standard, workdir, target.top as string];
    if (typeof target.options.assertLevel === 'string') runArgs.push(`--assert-level=${target.options.assertLevel}`);
    if (typeof target.options.stopTime === 'string') runArgs.push(`--stop-time=${target.options.stopTime}`);
    const waveform = target.artifacts.waveform;
    if (waveform) runArgs.push(`--${waveform === 'ghw' ? 'wave' : waveform}=${join(context.artifactRoot, `wave.${waveform}`)}`);
    return [analyze, { ...base, args: ['-e', standard, workdir, target.top as string] }, { ...base, args: runArgs }];
  }
  async parseResult(_context: ProviderContext, results: ProcessResult[], artifacts: ArtifactRecord[]): Promise<HardwareResult> {
    const last = results.at(-1); const success = results.length > 0 && results.every((result) => result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.truncated);
    return { success, summary: success ? 'GHDL completed' : 'GHDL failed', diagnostics: [], artifacts, exitCode: last?.exitCode ?? null, signal: last?.signal ?? null, reason: last?.timedOut ? 'timeout' : last?.cancelled ? 'cancelled' : last?.truncated ? 'output_limit' : 'exit' };
  }
}
