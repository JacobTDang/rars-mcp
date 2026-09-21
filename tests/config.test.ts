import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('loadConfig', () => {
  it('loads bounded defaults', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rars-config-'));

    expect(loadConfig({ RARS_WORKSPACE: workspaceRoot })).toMatchObject({
      workspaceRoots: [workspaceRoot],
      executionTimeoutMs: 10_000,
      maxOutputBytes: 1_048_576,
      maxInspectionBytes: 65_536,
      sessionIdleMs: 1_800_000,
    });
    expect(loadConfig({ RARS_WORKSPACE: workspaceRoot, RARS_SESSION_IDLE_MS: '60000' }).sessionIdleMs).toBe(60_000);
  });

  it('defaults to the JAR files and runtime folder in this repository', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rars-config-'));

    expect(loadConfig({ RARS_WORKSPACE: workspaceRoot })).toMatchObject({
      rarsJar: join(repositoryRoot, '.cache', 'rars1_6.jar'),
      bridgeJar: join(repositoryRoot, 'java', 'bridge', 'build', 'rars-mcp-bridge.jar'),
      liveDiscoveryDir: join(repositoryRoot, '.runtime'),
      bridgeHost: '127.0.0.1',
    });
  });

  it('splits RARS_WORKSPACE into several folders', () => {
    const first = mkdtempSync(join(tmpdir(), 'rars-config-'));
    const second = mkdtempSync(join(tmpdir(), 'rars-config-'));

    expect(loadConfig({ RARS_WORKSPACE: `${first}${delimiter}${second}` }).workspaceRoots).toEqual([first, second]);
  });

  it('rejects a workspace list with no folders', () => {
    expect(() => loadConfig({ RARS_WORKSPACE: delimiter })).toThrow('RARS_WORKSPACE must name at least one folder');
  });

  it('rejects a non-positive execution timeout', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rars-config-'));

    expect(() =>
      loadConfig({
        RARS_WORKSPACE: workspaceRoot,
        RARS_EXECUTION_TIMEOUT_MS: '0',
      }),
    ).toThrow('RARS_EXECUTION_TIMEOUT_MS must be a positive integer');
  });
});
