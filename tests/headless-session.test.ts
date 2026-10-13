import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { RarsError } from '../src/errors.js';
import { HeadlessSession } from '../src/sessions/headless.js';

// Writes a shell script that stands in for java. It ignores the bridge arguments, and
// "$(dirname "$0")" is the folder it can leave files in for the test.
async function fakeJava(lines: string[]): Promise<{ executable: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'rars-fake-java-'));
  const executable = join(directory, 'java');
  await writeFile(executable, `#!/bin/sh\n${lines.join('\n')}\n`);
  await chmod(executable, 0o755);
  return { executable, directory };
}

function startBridge(javaExecutable: string, timeoutMs: number): Promise<HeadlessSession> {
  return HeadlessSession.create({
    javaExecutable, bridgeJar: '/unused/bridge.jar', rarsJar: '/unused/rars.jar', token: 'test-secret',
    files: ['/unused/program.asm'], timeoutMs, maxOutputBytes: 65_536,
  });
}

async function recordedPids(directory: string): Promise<number[]> {
  return (await readFile(join(directory, 'pids'), 'utf8')).trim().split(/\s+/).map(Number);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

// A killed grandchild is reaped by init, so it can take a moment to disappear.
async function expectStopped(pids: number[]): Promise<void> {
  await vi.waitFor(() => expect(pids.filter(isRunning)).toEqual([]), { timeout: 3_000 });
}

describe('HeadlessSession startup', () => {
  it('kills a bridge that never prints its port and reports the limit and its output', async () => {
    const { executable, directory } = await fakeJava([
      'echo "JVM warming up"',
      'echo "still loading classes" >&2',
      'sleep 60 &',
      'echo "$$ $!" > "$(dirname "$0")/pids"',
      'wait',
    ]);

    const attempt = startBridge(executable, 1_500);

    await expect(attempt).rejects.toThrow(RarsError);
    await expect(attempt).rejects.toMatchObject({
      code: 'BRIDGE_START_TIMEOUT',
      message: expect.stringMatching(/^RARS bridge did not start within 1500 ms\n[\s\S]*JVM warming up[\s\S]*still loading classes/),
      details: { timeoutMs: 1_500, stdout: 'JVM warming up\n', stderr: 'still loading classes\n' },
    });
    await expectStopped(await recordedPids(directory));
  }, 15_000);

  it('fails as soon as the bridge exits before it is ready, with what it printed', async () => {
    const { executable } = await fakeJava([
      'echo "RARS_MCP_PORT=not-a-port"',
      'echo "#@!garbage%%"',
      'echo "Error: Could not find or load main class dev.rarsmcp.server.BridgeServer" >&2',
      'exit 3',
    ]);
    const started = Date.now();

    const attempt = startBridge(executable, 60_000);

    await expect(attempt).rejects.toThrow(RarsError);
    await expect(attempt).rejects.toMatchObject({
      code: 'BRIDGE_START_FAILED',
      message: expect.stringMatching(/^RARS bridge exited during startup with code 3\n[\s\S]*#@!garbage%%[\s\S]*Could not find or load main class/),
      details: {
        exitCode: 3, signal: null,
        stdout: 'RARS_MCP_PORT=not-a-port\n#@!garbage%%\n',
        stderr: 'Error: Could not find or load main class dev.rarsmcp.server.BridgeServer\n',
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('keeps the first 64 KiB of each stream in the startup error', async () => {
    const { executable } = await fakeJava(['head -c 70000 /dev/zero | tr "\\000" x', 'exit 1']);

    const error = await startBridge(executable, 60_000).then(() => undefined, (reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'BRIDGE_START_FAILED', details: { stderr: '' } });
    expect((error as RarsError).details!.stdout).toBe(`${'x'.repeat(65_536)}\n[cut at 65536 of 70000 bytes]`);
    expect((error as RarsError).message).toContain('stderr: (none)');
  }, 15_000);

  it('counts the wait for the hello reply against the same limit', async () => {
    const connections: Socket[] = [];
    // Accepts the bridge connection and never answers it.
    const silent = createServer((socket) => connections.push(socket));
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
    const { port } = silent.address() as AddressInfo;
    const { executable, directory } = await fakeJava([
      'echo "$$" > "$(dirname "$0")/pids"',
      `echo "RARS_MCP_PORT=${port}" >&2`,
      'exec sleep 60',
    ]);

    try {
      await expect(startBridge(executable, 1_500)).rejects.toMatchObject({
        code: 'BRIDGE_START_TIMEOUT',
        message: expect.stringMatching(new RegExp(`^RARS bridge did not start within 1500 ms\\n[\\s\\S]*RARS_MCP_PORT=${port}`)),
      });
      await expectStopped(await recordedPids(directory));
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((done) => silent.close(() => done()));
    }
  }, 15_000);
});

describe.runIf(process.env.RARS_JAR)('HeadlessSession', () => {
  it('controls a stateful RARS process and closes it', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java',
      bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!,
      token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')],
      timeoutMs: 3_000, maxOutputBytes: 65_536,
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

  it('applies none of a modify request when one entry is rejected', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    await expect(session.modify({ registers: { t0: '0x11', nosuch: '0x22', t1: '0x33' } })).rejects.toThrow('Unknown register: nosuch');
    await expect(session.modify({
      memory: [
        { address: '0x10010000', width: 4, value: '0x55' },
        { address: '0x7', width: 4, value: '0x66' },
        { address: '0x10010004', width: 4, value: '0x77' },
      ],
    })).rejects.toThrow('Store address not aligned to word boundary 0x00000007');
    await expect(session.modify({ registers: { t0: '0x11' }, memory: [{ address: '0x10010000', width: 1, value: '0x1ff' }] }))
      .rejects.toThrow('Value for 0x10010000 does not fit in 1 byte: 0x1ff');
    expect(await session.inspect({
      registers: ['t0', 't1'], memory: [{ address: '0x10010000', length: 4 }, { address: '0x10010004', length: 4 }],
    })).toMatchObject({
      registers: { t0: { hex: '0x00000000' }, t1: { hex: '0x00000000' } },
      memory: [{ hex: '0x00000000' }, { hex: '0x00000000' }],
    });
    await session.close();
  });

  it('writes and reads 8-byte memory exactly, with signed as a decimal string', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    await session.modify({
      memory: [
        { address: '0x10010000', width: 8, value: '0x7fffffffffffffff' },
        { address: '0x10010008', width: 8, value: '0x8000000000000000' },
        { address: '0x10010010', width: 8, value: '-2' },
        { address: '0x10010018', width: 8, value: '9223372036854775807' },
      ],
    });
    const state = await session.inspect({
      memory: [
        { address: '0x10010000', length: 8 }, { address: '0x10010008', length: 8 },
        { address: '0x10010010', length: 8 }, { address: '0x10010018', length: 8 },
        { address: '0x10010004', length: 4 },
      ],
    });
    expect(state.memory).toEqual([
      { address: '0x10010000', width: 8, hex: '0x7fffffffffffffff', signed: '9223372036854775807' },
      { address: '0x10010008', width: 8, hex: '0x8000000000000000', signed: '-9223372036854775808' },
      { address: '0x10010010', width: 8, hex: '0xfffffffffffffffe', signed: '-2' },
      { address: '0x10010018', width: 8, hex: '0x7fffffffffffffff', signed: '9223372036854775807' },
      { address: '0x10010004', width: 4, hex: '0x7fffffff', signed: 2147483647 },
    ]);
    await expect(session.modify({ memory: [{ address: '0x10010000', width: 8, value: '0x10000000000000000' }] }))
      .rejects.toThrow('Value for 0x10010000 does not fit in 8 bytes: 0x10000000000000000');
    await session.close();
  });

  it('reports a step-limit stop on continue', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/infinite.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    expect(await session.command({ action: 'continue', maxSteps: 50 })).toMatchObject({ status: 'paused', stopReason: 'step_limit' });
    await session.close();
  });

  it('sets breakpoints by label and by file:line', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    expect(await session.command({ action: 'breakpoint_add', address: 'debug.asm:7' })).toMatchObject({ breakpoints: ['0x00400008'] });
    expect(await session.command({ action: 'continue' })).toMatchObject({ programCounter: '0x00400008', stopReason: 'breakpoint' });
    expect(await session.command({ action: 'breakpoint_add', address: 'main' })).toMatchObject({ breakpoints: ['0x00400000', '0x00400008'] });
    await expect(session.command({ action: 'breakpoint_add', address: 'nope' })).rejects.toThrow('Unknown label: nope');
    await session.close();
  });

  it('terminates a program and refuses to run it until it is reset', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    await session.command({ action: 'step' });
    expect(await session.command({ action: 'terminate' })).toMatchObject({ status: 'terminated', stopReason: 'terminated' });
    await expect(session.command({ action: 'step' })).rejects.toThrow('The program has terminated; reset the session to run it again');
    expect(await session.command({ action: 'reset' })).toMatchObject({ status: 'paused', programCounter: '0x00400000' });
    expect(await session.command({ action: 'step' })).toMatchObject({ status: 'paused', stopReason: 'step' });
    await session.close();
  });

  it('forgets the backstep history on reset', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    expect(await session.command({ action: 'continue' })).toMatchObject({ stopReason: 'exited' });
    await session.command({ action: 'reset' });
    await expect(session.command({ action: 'backstep' })).rejects.toThrow('No backstep history');
    expect(await session.inspect({ registers: ['a0', 'a7'] })).toMatchObject({
      status: 'paused', programCounter: '0x00400000',
      registers: { a0: { hex: '0x00000000' }, a7: { hex: '0x00000000' } },
    });
    await session.close();
  });

  it('reads pc and names an unknown register in the error', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    const state = await session.inspect({ registers: ['pc'] });
    expect(state.registers?.pc?.hex).toBe(state.programCounter);
    await expect(session.inspect({ registers: ['nope'] })).rejects.toThrow('Unknown register: nope');
    await session.close();
  });

  it('returns symbols only when they are requested', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    const withSymbols = await session.inspect({ includeSymbols: true }) as { programCounter: string; symbols: unknown[] };
    expect(withSymbols.symbols).toEqual([
      { name: 'main', address: withSymbols.programCounter, type: 'text', global: false },
      { name: 'value', address: '0x10010000', type: 'data', global: false },
    ]);
    expect(await session.inspect({})).not.toHaveProperty('symbols');
    await session.close();
  });

  it('returns the assembled instructions only when they are requested', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    const state = await session.inspect({ includeInstructions: true }) as { instructions: unknown[] };
    expect(state.instructions).toHaveLength(4);
    expect(state.instructions[0]).toMatchObject({ address: '0x00400000', code: '0x00100513', source: 'li a0, 1', line: 5 });
    expect(await session.inspect({})).not.toHaveProperty('instructions');
    await session.close();
  });

  it('returns a window of instructions around a location or between two locations', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm'), resolve('tests/fixtures/debug-helper.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });
    const addresses = async (request: Parameters<HeadlessSession['inspect']>[0]) =>
      ((await session.inspect(request)) as { instructions: Array<{ address: string }> }).instructions.map((item) => item.address);

    await expect(addresses({ instructions: {} })).resolves.toEqual(['0x00400000', '0x00400004', '0x00400008', '0x0040000c', '0x00400010']);
    await session.command({ action: 'step' });
    await expect(addresses({ instructions: { around: 'pc', count: 2 } })).resolves.toEqual(['0x00400004', '0x00400008']);
    await expect(addresses({ instructions: { around: 'helper', count: 3 } })).resolves.toEqual(['0x0040000c', '0x00400010']);
    await expect(addresses({ instructions: { from: 'main', to: '0x00400008' } })).resolves.toEqual(['0x00400000', '0x00400004', '0x00400008']);
    expect(((await session.inspect({ instructions: { around: 'main', count: 1 } })) as { instructions: unknown[] }).instructions[0])
      .toMatchObject({ address: '0x00400000', code: '0x00100513', source: 'li a0, 1', line: 5 });
    await expect(session.inspect({ instructions: { around: 'nope' } })).rejects.toThrow('Unknown label: nope');
    await expect(session.inspect({ includeInstructions: true, instructions: {} }))
      .rejects.toThrow('includeInstructions and instructions cannot be combined');
    await session.close();
  });

  it('ends the window at the last instruction once pc has moved past the program', async () => {
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });
    const addresses = async (request: Parameters<HeadlessSession['inspect']>[0]) =>
      ((await session.inspect(request)) as { instructions: Array<{ address: string }> }).instructions.map((item) => item.address);

    expect(await session.command({ action: 'continue' })).toMatchObject({ stopReason: 'exited', programCounter: '0x00400010' });
    await expect(addresses({ instructions: {} })).resolves.toEqual(['0x00400000', '0x00400004', '0x00400008', '0x0040000c']);
    await expect(addresses({ instructions: { around: 'pc', count: 2 } })).resolves.toEqual(['0x00400008', '0x0040000c']);
    await expect(session.inspect({ instructions: { around: '0x00400010' } })).rejects.toThrow('No instruction at 0x00400010');
    await session.close();
  });

  it('refuses an instruction range longer than 200 instructions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rars-window-'));
    await writeFile(join(directory, 'long.asm'), `.text\nmain:\n${'  addi t0, t0, 1\n'.repeat(250)}`);
    const session = await HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [join(directory, 'long.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    });

    expect(await session.inspect({ instructions: { from: 'main', to: '0x0040031c' } })).toHaveProperty('instructions.length', 200);
    await expect(session.inspect({ instructions: { from: 'main', to: '0x004003e4' } }))
      .rejects.toThrow('The range main to 0x004003e4 holds 250 instructions; the limit is 200');
    await session.close();
  });

  it('reports the RARS assembly errors when a debug program fails to assemble', async () => {
    await expect(HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'test-secret',
      files: [resolve('tests/fixtures/invalid.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    })).rejects.toThrow(/invalid\.asm line 3.*definitely_not_an_instruction/);
  });

  it('rejects a wrong authentication token', async () => {
    await expect(HeadlessSession.create({
      javaExecutable: 'java', bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'),
      rarsJar: process.env.RARS_JAR!, token: 'client-token', bridgeToken: 'different-token',
      files: [resolve('tests/fixtures/debug.asm')], timeoutMs: 3_000, maxOutputBytes: 65_536,
    })).rejects.toThrow('Invalid bridge token');
  });
});
