import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { HeadlessSession } from '../src/sessions/headless.js';

describe.runIf(process.env.RARS_JAR)('HeadlessSession', () => {
  beforeAll(() => execFileSync('scripts/build-java-bridge.sh', { stdio: 'inherit' }));

  it('controls a stateful RARS process and closes it', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java',
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!,
      token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')],
      timeoutMs: 3_000,
    });

    const initial = await session.inspect({ registers: ['a0'] }) as { programCounter: number };
    await session.command({ action: 'step' });
    const stepped = await session.inspect({ registers: ['a0'] }) as { programCounter: number };
    expect(stepped.programCounter).toBe(initial.programCounter + 4);
    await session.modify({ registers: { a0: '41' }, memory: [{ address: '0x10010000', width: 4, value: '1234' }] });
    expect(await session.inspect({ registers: ['a0'], memory: [{ address: '0x10010000', length: 4 }] })).toMatchObject({
      registers: { a0: 41 }, memory: [{ value: 1234 }],
    });
    await session.command({ action: 'backstep' });
    expect((await session.summary()).state).toBe('paused');
    await session.close();
    expect(session.isClosed()).toBe(true);
  });

  it('rejects a wrong authentication token', async () => {
    await expect(HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'client-token', bridgeToken: 'different-token',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000,
    })).rejects.toThrow('Invalid bridge token');
  });
});
