import { join } from 'node:path';
import { RarsError } from '../../errors.js';
import type { ArtifactRecord, HardwareResult, ProcessResult, ProviderCapability, ProviderCommand, ProviderContext, ResolvedTarget } from '../types.js';
import type { HardwareProvider } from './provider.js';

type ToolKind = 'cocotb' | 'yosys' | 'sby' | 'riscv-formal' | 'spike' | 'rars-trace';

export class VerificationProvider implements HardwareProvider {
  constructor(private readonly kind: ToolKind, private readonly version: string | null) {}
  async capability(): Promise<ProviderCapability> {
    const definitions = {
      cocotb: { actions: ['test'], languages: ['verilog', 'systemverilog', 'vhdl'], formats: ['vcd', 'fst', 'ghw'] },
      yosys: { actions: ['synthesize', 'analyze'], languages: ['verilog', 'systemverilog'], formats: ['json'] },
      sby: { actions: ['prove', 'cover', 'bmc'], languages: ['verilog', 'systemverilog'], formats: ['vcd'] },
      'riscv-formal': { actions: ['prove'], languages: ['verilog', 'systemverilog'], formats: ['vcd'] },
      spike: { actions: ['trace'], languages: ['riscv'], formats: ['jsonl'] },
      'rars-trace': { actions: ['trace'], languages: ['riscv'], formats: ['jsonl'] },
    }[this.kind];
    return { id: this.kind, version: this.version ?? 'unavailable', available: this.version !== null, ...(this.version ? {} : { unavailableReason: `${this.kind} executable not found` }), actions: definitions.actions, languages: definitions.languages, standards: [], artifactFormats: definitions.formats };
  }
  validate(target: ResolvedTarget): void { if (!target.top) throw new RarsError('INVALID_PROJECT', `${this.kind} target requires top to name a source script, test, or executable`); if (target.top.includes('..') || target.top.startsWith('/')) throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Invalid ${this.kind} top path`); }
  async commands(context: ProviderContext): Promise<ProviderCommand[]> {
    this.validate(context.target); const target = context.target; const source = join(context.snapshotRoot, target.top as string);
    const base = { cwd: context.buildRoot, env: { PATH: process.env.PATH ?? '', PYTHONPATH: context.snapshotRoot }, limits: target.effectiveLimits };
    if (this.kind === 'cocotb') return [{ ...base, executable: 'python3', args: ['-m', 'pytest', '-q', source, `--junitxml=${join(context.artifactRoot, 'cocotb-junit.xml')}`] }];
    if (this.kind === 'yosys') return [{ ...base, executable: 'yosys', args: ['-l', join(context.artifactRoot, 'yosys.log'), '-s', source] }];
    if (this.kind === 'sby' || this.kind === 'riscv-formal') return [{ ...base, cwd: context.artifactRoot, executable: 'sby', args: ['-f', source, ...target.action === 'bmc' ? ['bmc'] : []] }];
    if (this.kind === 'rars-trace') return [{ ...base, env: { ...base.env, HOME: context.buildRoot }, executable: 'java', args: ['-XX:+UseSerialGC', '-Xss256k', '-Xmx256m', '-XX:CompressedClassSpaceSize=64m', '-XX:MaxMetaspaceSize=128m', '-cp', '/opt/rars/rars-mcp-bridge.jar:/opt/rars/rars.jar', 'dev.rarsmcp.sim.TraceMain', source, join(context.artifactRoot, 'rars-trace.jsonl'), String(target.parameters.max_steps ?? 100000)] }];
    return [{ ...base, executable: 'spike', args: ['--log-commits', source] }];
  }
  async parseResult(_context: ProviderContext, results: ProcessResult[], artifacts: ArtifactRecord[]): Promise<HardwareResult> { const last = results.at(-1); const success = results.length > 0 && results.every((item) => item.exitCode === 0 && !item.timedOut && !item.cancelled && !item.truncated); return { success, summary: `${this.kind} ${success ? 'completed' : 'failed'}`, diagnostics: [], artifacts, exitCode: last?.exitCode ?? null, signal: last?.signal ?? null, reason: last?.timedOut ? 'timeout' : last?.cancelled ? 'cancelled' : last?.truncated ? 'output_limit' : 'exit' }; }
}
