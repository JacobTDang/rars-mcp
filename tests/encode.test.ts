import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createEncodeHandler } from '../src/tools/encode.js';
import type { ToolDependencies } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

async function dependencies(bridge: Partial<ToolDependencies> = {}): Promise<ToolDependencies> {
  return {
    workspace: await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-encode-'))), sessions: new SessionStore(),
    run: async () => { throw new Error('not used'); },
    javaExecutable: 'java', rarsJar: process.env.RARS_JAR ?? '', timeoutMs: 5000, maxOutputBytes: 1024,
    ...bridge,
  };
}

describe('rars_encode', () => {
  it('needs the RARS bridge', async () => {
    const encode = createEncodeHandler(await dependencies());
    await expect(encode({ instructions: ['nop'] })).rejects.toThrow('rars_encode needs the RARS bridge, which is not configured');
  });
});

describe.runIf(process.env.RARS_JAR)('rars_encode with RARS', () => {
  const bridge = { bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token' };

  it('encodes each instruction with its format and fields', async () => {
    const encode = createEncodeHandler(await dependencies(bridge));

    const result = await encode({
      instructions: ['sub x5, x6, x7', 'lw t2, 64(t0)', 'sw t2, -4(sp)', 'beq x1, x2, -8', 'lui t0, 0xfeed2', 'jal ra, 16',
        'slli t0, t0, 12', 'li t1, 0xFEED2050', 'addi t0, t0'],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'Encoded 8 of 9 instructions\naddi t0, t0: "addi": Too few or incorrectly formatted operands. Expected: addi t1,t2,-100' }]);
    expect(result.structuredContent).toEqual({
      instructions: [
        { source: 'sub x5, x6, x7', basic: ['sub x5,x6,x7'], words: [
          { hex: '0x407302b3', format: 'R', fields: { opcode: 0x33, rd: 5, funct3: 0, rs1: 6, rs2: 7, funct7: 0x20 } },
        ] },
        { source: 'lw t2, 64(t0)', basic: [expect.stringMatching(/^lw x7,/)], words: [
          { hex: '0x0402a383', format: 'I', fields: { opcode: 0x03, rd: 7, funct3: 2, rs1: 5, imm: 64 } },
        ] },
        { source: 'sw t2, -4(sp)', basic: [expect.stringMatching(/^sw x7,/)], words: [
          { hex: '0xfe712e23', format: 'S', fields: { opcode: 0x23, funct3: 2, rs1: 2, rs2: 7, imm: -4 } },
        ] },
        { source: 'beq x1, x2, -8', basic: [expect.stringMatching(/^beq x1,x2,/)], words: [
          { hex: '0xfe208ce3', format: 'B', fields: { opcode: 0x63, funct3: 0, rs1: 1, rs2: 2, imm: -8 } },
        ] },
        { source: 'lui t0, 0xfeed2', basic: [expect.stringMatching(/^lui x5,/)], words: [
          { hex: '0xfeed22b7', format: 'U', fields: { opcode: 0x37, rd: 5, imm: 0xfeed2 } },
        ] },
        { source: 'jal ra, 16', basic: [expect.stringMatching(/^jal x1,/)], words: [
          { hex: '0x010000ef', format: 'J', fields: { opcode: 0x6f, rd: 1, imm: 16 } },
        ] },
        { source: 'slli t0, t0, 12', basic: ['slli x5,x5,12'], words: [
          { hex: '0x00c29293', format: 'I', fields: { opcode: 0x13, rd: 5, funct3: 1, rs1: 5, shamt: 12, funct7: 0 } },
        ] },
        { source: 'li t1, 0xFEED2050', basic: [expect.stringMatching(/^lui x6,/), expect.stringMatching(/^addi x6,x6,/)], words: [
          { hex: '0xfeed2337', format: 'U', fields: { opcode: 0x37, rd: 6, imm: 0xfeed2 } },
          { hex: '0x05030313', format: 'I', fields: { opcode: 0x13, rd: 6, funct3: 0, rs1: 6, imm: 0x50 } },
        ] },
        { source: 'addi t0, t0', error: '"addi": Too few or incorrectly formatted operands. Expected: addi t1,t2,-100' },
      ],
    });
  });

  it('fails with every message when no instruction encodes', async () => {
    const encode = createEncodeHandler(await dependencies(bridge));

    const result = await encode({ instructions: ['nope x1', 'beq x1, x2, 3'] });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: 'text',
      text: 'No instruction encoded\nnope x1: "nope" is not a recognized operator\nbeq x1, x2, 3: Branch and jump offsets must be even, not 3',
    }]);
    expect(result.structuredContent).toEqual({
      instructions: [
        { source: 'nope x1', error: '"nope" is not a recognized operator' },
        { source: 'beq x1, x2, 3', error: 'Branch and jump offsets must be even, not 3' },
      ],
    });
  });
});
