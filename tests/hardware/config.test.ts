import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('hardware configuration', () => {
  it('loads disabled bounded defaults', () => {
    const config = loadConfig({ RARS_WORKSPACE: '/tmp/work' });

    expect(config.hardware).toEqual({
      enabled: false,
      workerUrl: 'http://hardware-worker:3010',
      stateDir: '/state',
      allowRepositoryCommands: false,
      limits: {
        concurrency: 1,
        wallTimeSeconds: 120,
        memoryMb: 2048,
        pids: 256,
        outputBytes: 4_194_304,
        artifactMb: 512,
        sourceFiles: 10_000,
        sourceBytes: 268_435_456,
      },
    });
  });

  it('loads explicit hardware settings', () => {
    const config = loadConfig({
      HARDWARE_ENABLED: 'true',
      HARDWARE_WORKER_URL: 'http://127.0.0.1:3010',
      HARDWARE_WORKER_TOKEN: 'secret',
      HARDWARE_STATE_DIR: '/tmp/hardware-state',
      HARDWARE_ALLOW_REPOSITORY_COMMANDS: 'true',
      HARDWARE_MAX_PIDS: '64',
    });

    expect(config.hardware).toMatchObject({
      enabled: true,
      workerUrl: 'http://127.0.0.1:3010',
      workerToken: 'secret',
      stateDir: '/tmp/hardware-state',
      allowRepositoryCommands: true,
      limits: { pids: 64 },
    });
  });

  it('rejects invalid booleans and non-positive limits', () => {
    expect(() => loadConfig({ HARDWARE_ENABLED: 'yes' })).toThrow(/HARDWARE_ENABLED/);
    expect(() => loadConfig({ HARDWARE_MAX_PIDS: '0' })).toThrow(/HARDWARE_MAX_PIDS/);
  });
});
