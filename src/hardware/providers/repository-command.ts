import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RarsError } from '../../errors.js';
import type { ArtifactRecord, HardwareResult, ProcessResult, ProviderCapability, ProviderCommand, ProviderContext, ResolvedTarget } from '../types.js';
import type { HardwareProvider } from './provider.js';

export class RepositoryCommandProvider implements HardwareProvider {
  constructor(private readonly allowed: boolean) {}
  async capability(): Promise<ProviderCapability> { return { id: 'repository-command', version: '1', available: this.allowed, ...(this.allowed ? {} : { unavailableReason: 'repository commands disabled' }), actions: ['test', 'compile', 'simulate'], languages: [], standards: [], artifactFormats: [] }; }
  validate(target: ResolvedTarget): void { if (!this.allowed || !target.command?.length) throw new RarsError('INVALID_PROJECT', 'Repository command is disabled or missing'); }
  async commands(context: ProviderContext): Promise<ProviderCommand[]> {
    this.validate(context.target);
    const [rawExecutable, ...args] = context.target.command as string[];
    if (!rawExecutable || isAbsolute(rawExecutable)) throw new RarsError('INVALID_PROJECT', 'Repository executable must be snapshot-relative');
    const executable = resolve(context.snapshotRoot, rawExecutable);
    const rel = relative(context.snapshotRoot, executable);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RarsError('PATH_OUTSIDE_WORKSPACE', 'Repository executable is outside the snapshot');
    return [{ executable, args, cwd: context.buildRoot, env: { PATH: process.env.PATH ?? '', HARDWARE_ARTIFACT_DIR: context.artifactRoot, HARDWARE_SOURCE_DIR: context.snapshotRoot }, limits: context.target.effectiveLimits }];
  }
  async parseResult(_context: ProviderContext, results: ProcessResult[], artifacts: ArtifactRecord[]): Promise<HardwareResult> { const last = results.at(-1); const success = Boolean(last && last.exitCode === 0 && !last.timedOut && !last.cancelled && !last.truncated); return { success, summary: success ? 'Repository command completed' : 'Repository command failed', diagnostics: [], artifacts, exitCode: last?.exitCode ?? null, signal: last?.signal ?? null, reason: last?.timedOut ? 'timeout' : last?.cancelled ? 'cancelled' : last?.truncated ? 'output_limit' : 'exit' }; }
}
