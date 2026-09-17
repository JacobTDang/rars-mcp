import type { ArtifactRecord, HardwareResult, ProcessResult, ProviderCapability, ProviderCommand, ProviderContext, ResolvedTarget } from '../types.js';

export interface HardwareProvider {
  capability(): Promise<ProviderCapability>;
  validate(target: ResolvedTarget): void;
  commands(context: ProviderContext): Promise<ProviderCommand[]>;
  parseResult(context: ProviderContext, results: ProcessResult[], artifacts: ArtifactRecord[]): Promise<HardwareResult>;
}
