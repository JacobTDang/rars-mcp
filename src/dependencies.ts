import type { AppConfig } from './config.js';
import { runRars } from './rars/cli.js';
import { SessionStore } from './sessions/store.js';
import type { ToolDependencies } from './tools/handlers.js';
import { Workspace } from './workspace.js';

type Environment = Readonly<Record<string, string | undefined>>;

export async function createToolDependencies(config: AppConfig, env: Environment = process.env): Promise<ToolDependencies> {
  return {
    workspace: await Workspace.create(config.workspaceRoot),
    sessions: new SessionStore(),
    run: runRars,
    javaExecutable: env.JAVA_EXECUTABLE ?? 'java',
    rarsJar: config.rarsJar,
    timeoutMs: config.executionTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    bridgeJar: config.bridgeJar,
    bridgeToken: env.RARS_HEADLESS_BRIDGE_TOKEN ?? 'internal-headless-bridge',
    bridgeHost: config.bridgeHost,
    liveDiscoveryDir: config.liveDiscoveryDir,
  };
}
