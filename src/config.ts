import { resolve } from 'node:path';

import { RarsError } from './errors.js';

export interface AppConfig {
  workspaceRoot: string;
  rarsJar: string;
  executionTimeoutMs: number;
  maxOutputBytes: number;
  maxInspectionBytes: number;
  bridgeHost: string;
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

export function loadConfig(env: Environment = process.env): AppConfig {
  const workspaceRoot = resolve(env.RARS_WORKSPACE ?? 'workspace');
  const bridgeToken = env.RARS_BRIDGE_TOKEN;

  return {
    workspaceRoot,
    rarsJar: resolve(env.RARS_JAR ?? '/opt/rars/rars.jar'),
    executionTimeoutMs: positiveInteger(env, 'RARS_EXECUTION_TIMEOUT_MS', 10_000),
    maxOutputBytes: positiveInteger(env, 'RARS_MAX_OUTPUT_BYTES', 1_048_576),
    maxInspectionBytes: positiveInteger(env, 'RARS_MAX_INSPECTION_BYTES', 65_536),
    bridgeHost: env.RARS_BRIDGE_HOST ?? 'host.docker.internal',
    ...(bridgeToken === undefined ? {} : { bridgeToken }),
  };
}
