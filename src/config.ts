import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RarsError } from './errors.js';

export interface AppConfig {
  workspaceRoot: string;
  rarsJar: string;
  executionTimeoutMs: number;
  maxOutputBytes: number;
  maxInspectionBytes: number;
  bridgeHost: string;
  bridgeJar: string;
  liveDiscoveryDir: string;
  bridgeToken?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RarsError(
      'INVALID_CONFIGURATION',
      `${name} must be a positive integer`,
      { name, value: rawValue },
    );
  }
  return value;
}

// The folder holding package.json, whether this module runs from src/ or dist/src/.
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new RarsError('INVALID_CONFIGURATION', 'Cannot find the rars-mcp package root', {
        start: dirname(fileURLToPath(import.meta.url)),
      });
    }
    directory = parent;
  }
  return directory;
}

// Defaults point at this checkout; the Docker image sets every path explicitly.
export function loadConfig(env: Environment = process.env): AppConfig {
  const root = packageRoot();
  const workspaceRoot = resolve(env.RARS_WORKSPACE ?? 'workspace');
  const bridgeToken = env.RARS_BRIDGE_TOKEN;

  return {
    workspaceRoot,
    rarsJar: resolve(env.RARS_JAR ?? join(root, '.cache', 'rars1_6.jar')),
    executionTimeoutMs: positiveInteger(env, 'RARS_EXECUTION_TIMEOUT_MS', 10_000),
    maxOutputBytes: positiveInteger(env, 'RARS_MAX_OUTPUT_BYTES', 1_048_576),
    maxInspectionBytes: positiveInteger(env, 'RARS_MAX_INSPECTION_BYTES', 65_536),
    bridgeHost: env.RARS_BRIDGE_HOST ?? '127.0.0.1',
    bridgeJar: resolve(env.RARS_BRIDGE_JAR ?? join(root, 'java', 'bridge', 'build', 'rars-mcp-bridge.jar')),
    liveDiscoveryDir: resolve(env.RARS_LIVE_DISCOVERY_DIR ?? join(root, '.runtime')),
    ...(bridgeToken === undefined ? {} : { bridgeToken }),
  };
}
