import { resolve } from 'node:path';

import { RarsError } from './errors.js';
import type { HardwareConfig } from './hardware/types.js';

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
  hardware: HardwareConfig;
}

function booleanValue(env: Environment, name: string, fallback: boolean): boolean {
  const rawValue = env[name];
  if (rawValue === undefined) return fallback;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  throw new RarsError('INVALID_CONFIGURATION', `${name} must be true or false`, { name, value: rawValue });
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
    bridgeJar: resolve(env.RARS_BRIDGE_JAR ?? '/opt/rars/rars-mcp-bridge.jar'),
    liveDiscoveryDir: resolve(env.RARS_LIVE_DISCOVERY_DIR ?? '.runtime'),
    hardware: {
      enabled: booleanValue(env, 'HARDWARE_ENABLED', false),
      workerUrl: env.HARDWARE_WORKER_URL ?? 'http://hardware-worker:3010',
      ...(env.HARDWARE_WORKER_TOKEN === undefined ? {} : { workerToken: env.HARDWARE_WORKER_TOKEN }),
      stateDir: resolve(env.HARDWARE_STATE_DIR ?? '/state'),
      allowRepositoryCommands: booleanValue(env, 'HARDWARE_ALLOW_REPOSITORY_COMMANDS', false),
      limits: {
        concurrency: positiveInteger(env, 'HARDWARE_CONCURRENCY', 1),
        wallTimeSeconds: positiveInteger(env, 'HARDWARE_MAX_WALL_TIME_SECONDS', 120),
        memoryMb: positiveInteger(env, 'HARDWARE_MAX_MEMORY_MB', 2048),
        pids: positiveInteger(env, 'HARDWARE_MAX_PIDS', 256),
        outputBytes: positiveInteger(env, 'HARDWARE_MAX_OUTPUT_BYTES', 4_194_304),
        artifactMb: positiveInteger(env, 'HARDWARE_MAX_ARTIFACT_MB', 512),
        sourceFiles: positiveInteger(env, 'HARDWARE_MAX_SOURCE_FILES', 10_000),
        sourceBytes: positiveInteger(env, 'HARDWARE_MAX_SOURCE_BYTES', 268_435_456),
      },
    },
    ...(bridgeToken === undefined ? {} : { bridgeToken }),
  };
}
