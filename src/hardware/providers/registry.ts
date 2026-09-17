import { RarsError } from '../../errors.js';
import type { ProviderCapability } from '../types.js';
import { GhdlProvider } from './ghdl.js';
import type { HardwareProvider } from './provider.js';
import { RepositoryCommandProvider } from './repository-command.js';
import { VerilatorProvider } from './verilator.js';

export interface ProviderRegistry {
  get(id: string): HardwareProvider;
  capabilities(): Promise<ProviderCapability[]>;
}

export function createProviderRegistry(options: { executableVersions: Record<string, string | null>; allowRepositoryCommands: boolean }): ProviderRegistry {
  const providers = new Map<string, HardwareProvider>([
    ['verilator', new VerilatorProvider(options.executableVersions.verilator ?? null)],
    ['ghdl', new GhdlProvider(options.executableVersions.ghdl ?? null)],
    ['repository-command', new RepositoryCommandProvider(options.allowRepositoryCommands)],
  ]);
  return {
    get(id) { const provider = providers.get(id); if (!provider) throw new RarsError('PROVIDER_UNAVAILABLE', `Unknown provider: ${id}`, { id }); return provider; },
    capabilities: async () => Promise.all([...providers.values()].map((provider) => provider.capability())),
  };
}
