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

    const initial = await session.inspect({ registers: ['a0'] }) as { programCounter: string };
    expect(initial.programCounter).toBe('0x00400000');
    await session.command({ action: 'step' });
    const stepped = await session.inspect({ registers: ['a0'] }) as { programCounter: string };
    expect(stepped.programCounter).toBe('0x00400004');
    expect(await session.command({ action: 'breakpoint_add', address: '4194312' })).toMatchObject({ breakpoints: ['0x00400008'] });
    await session.modify({ registers: { a0: '-4096' }, memory: [{ address: '0x10010000', width: 4, value: '1234' }] });
    expect(await session.inspect({
      registers: ['a0'], memory: [{ address: '0x10010000', length: 4 }, { address: '0x10010000', length: 1 }],
    })).toMatchObject({
      registers: { a0: { hex: '0xfffff000', signed: -4096 } },
      memory: [
        { address: '0x10010000', width: 4, hex: '0x000004d2', signed: 1234 },
        { address: '0x10010000', width: 1, hex: '0xd2', signed: -46 },
      ],
    });
    await session.command({ action: 'backstep' });
    expect((await session.summary()).state).toBe('paused');
    await session.close();
    expect(session.isClosed()).toBe(true);
  });

  it('reports a step-limit stop on continue', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/infinite.asm')], timeoutMs: 3_000,
    });

    expect(await session.command({ action: 'continue', maxSteps: 50 })).toMatchObject({ status: 'paused', stopReason: 'step_limit' });
    await session.close();
  });

  it('reads pc and names an unknown register in the error', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000,
    });

    const state = await session.inspect({ registers: ['pc'] }) as { programCounter: string; registers: { pc: { hex: string } } };
    expect(state.registers.pc.hex).toBe(state.programCounter);
    await expect(session.inspect({ registers: ['nope'] })).rejects.toThrow('Unknown register: nope');
    await session.close();
  });

  it('returns symbols only when they are requested', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000,
    });

    const withSymbols = await session.inspect({ includeSymbols: true }) as { programCounter: string; symbols: unknown[] };
    expect(withSymbols.symbols).toEqual([
      { name: 'main', address: withSymbols.programCounter, type: 'text', global: false },
      { name: 'value', address: '0x10010000', type: 'data', global: false },
    ]);
    expect(await session.inspect({})).not.toHaveProperty('symbols');
    await session.close();
  });

  it('reports the RARS assembly errors when a debug program fails to assemble', async () => {
    await expect(HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/invalid.asm')], timeoutMs: 3_000,
    })).rejects.toThrow(/invalid\.asm line 3.*definitely_not_an_instruction/);
  });

  it('rejects a wrong authentication token', async () => {
    await expect(HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'client-token', bridgeToken: 'different-token',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000,
    })).rejects.toThrow('Invalid bridge token');
  });
});
