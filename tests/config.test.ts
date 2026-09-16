import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads bounded defaults', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rars-config-'));

    expect(loadConfig({ RARS_WORKSPACE: workspaceRoot })).toMatchObject({
      workspaceRoot,
      executionTimeoutMs: 10_000,
      maxOutputBytes: 1_048_576,
      maxInspectionBytes: 65_536,
      bridgeHost: 'host.docker.internal',
    });
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
