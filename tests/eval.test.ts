import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { runRars } from '../src/rars/cli.js';
import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import { createEvalHandler, evalSchema, type EvalInput } from '../src/tools/eval.js';
import type { ToolDependencies, ToolResult } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

async function dependencies(overrides: Partial<ToolDependencies> = {}): Promise<ToolDependencies> {
  return {
    workspace: await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-eval-'))),
    sessions: new SessionStore(),
    run: vi.fn(runRars),
    javaExecutable: 'java', rarsJar: process.env.RARS_JAR ?? '/rars.jar', timeoutMs: 10_000, maxOutputBytes: 64 * 1024,
    bridgeJar: resolve('java/bridge/build/rars-mcp-bridge.jar'), bridgeToken: 'test-token',
    ...overrides,
  };
}

interface EvalResult {
  op: string;
  rs1: string;
  rs2?: string;
  imm?: number;
  rd: { hex: string; signed: number; unsigned: number };
  zero: boolean;
}

function results(result: ToolResult): EvalResult[] {
  return (result.structuredContent as { results: EvalResult[] }).results;
}

function rd(result: ToolResult): string[] {
  return results(result).map(({ rd: value }) => value.hex);
}

function text(result: ToolResult): string {
  const [content] = result.content;
  return content?.type === 'text' ? content.text : '';
}

describe.runIf(process.env.RARS_JAR)('rars_eval with RARS', () => {
  it('compares signed and unsigned, as in the issue', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'slt', rs1: '0xFFFFFFFB', rs2: '0x7FFFFFFF' },
      { op: 'sltu', rs1: '0xFFFFFFFB', rs2: '0x7FFFFFFF' },
    ] });

    expect(result.isError).toBeFalsy();
    expect(results(result)).toEqual([
      { op: 'slt', rs1: '0xfffffffb', rs2: '0x7fffffff', rd: { hex: '0x00000001', signed: 1, unsigned: 1 }, zero: false },
      { op: 'sltu', rs1: '0xfffffffb', rs2: '0x7fffffff', rd: { hex: '0x00000000', signed: 0, unsigned: 0 }, zero: true },
    ]);
  });

  it('reports rd as hex, signed and unsigned', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [{ op: 'sub', rs1: 0, rs2: '1' }] });

    expect(results(result)[0]).toEqual({
      op: 'sub', rs1: '0x00000000', rs2: '0x00000001',
      rd: { hex: '0xffffffff', signed: -1, unsigned: 4294967295 }, zero: false,
    });
  });

  it('shifts arithmetically and logically by register and immediate', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'sra', rs1: '0x80000000', rs2: 4 },
      { op: 'srl', rs1: '0x80000000', rs2: 4 },
      { op: 'srai', rs1: '0x80000000', imm: 4 },
      { op: 'srli', rs1: '0x80000000', imm: '0x4' },
      { op: 'slli', rs1: 1, imm: 31 },
    ] });

    expect(rd(result)).toEqual(['0xf8000000', '0x08000000', '0xf8000000', '0x08000000', '0x80000000']);
    expect(results(result)[2]).toMatchObject({ op: 'srai', rs1: '0x80000000', imm: 4 });
    expect(results(result)[2]).not.toHaveProperty('rs2');
  });

  it('returns the upper word of signed and unsigned products', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'mul', rs1: '0x80000000', rs2: 2 },
      { op: 'mulh', rs1: '0x80000000', rs2: 2 },
      { op: 'mulhu', rs1: '0x80000000', rs2: 2 },
      { op: 'mulhsu', rs1: '0x80000000', rs2: 2 },
    ] });

    expect(rd(result)).toEqual(['0x00000000', '0xffffffff', '0x00000001', '0xffffffff']);
  });

  it('follows RISC-V division semantics, including division by zero', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'div', rs1: -7, rs2: 2 },
      { op: 'rem', rs1: '-7', rs2: 2 },
      { op: 'div', rs1: 1234, rs2: 0 },
      { op: 'rem', rs1: 1234, rs2: 0 },
      { op: 'divu', rs1: 1234, rs2: 0 },
      { op: 'remu', rs1: 1234, rs2: 0 },
      { op: 'div', rs1: '0x80000000', rs2: -1 },
      { op: 'rem', rs1: '0x80000000', rs2: -1 },
    ] });

    expect(results(result).map(({ rd: value }) => value.signed)).toEqual([-3, -1, -1, 1234, -1, 1234, -2147483648, 0]);
  });

  it('sign-extends the immediate operand', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'addi', rs1: 5, imm: -1 },
      { op: 'addi', rs1: 5, imm: '0xFFF' },
      { op: 'sltiu', rs1: '0xFFFFFFFB', imm: -1 },
      { op: 'slti', rs1: -5, imm: 2047 },
      { op: 'andi', rs1: '0x12345678', imm: '-2048' },
      { op: 'ori', rs1: 0, imm: '0x800' },
      { op: 'xori', rs1: '0xFFFFFFFF', imm: -1 },
    ] });

    expect(rd(result)).toEqual([
      '0x00000004', '0x00000004', '0x00000001', '0x00000001', '0x12345000', '0xfffff800', '0x00000000',
    ]);
    expect(results(result).map(({ imm }) => imm)).toEqual([-1, -1, -1, 2047, -2048, -2048, -1]);
  });

  it('evaluates 100 cases in one run', async () => {
    const deps = await dependencies();
    const cases: EvalInput['cases'] = Array.from({ length: 100 }, (_, index) => (
      { op: 'add', rs1: index, rs2: index * 1000 }
    ));

    const result = await createEvalHandler(deps)({ cases });

    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(results(result).map(({ rd: value }) => value.signed)).toEqual(cases.map((_, index) => index * 1001));
  });

  it('summarises the cases in a compact table', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [
      { op: 'slt', rs1: '0xFFFFFFFB', rs2: '0x7FFFFFFF' },
      { op: 'addi', rs1: 5, imm: -1 },
    ] });

    expect(text(result).split('\n')).toEqual([
      'Evaluated 2 cases',
      'op | rs1 | rs2/imm | rd',
      'slt | 0xfffffffb | 0x7fffffff | 0x00000001',
      'addi | 0x00000005 | -1 | 0x00000004',
    ]);
  });

  it('returns a VHDL constant table with the immediate in b', async () => {
    const result = await createEvalHandler(await dependencies())({ format: 'vhdl', cases: [
      { op: 'slt', rs1: '0xFFFFFFFB', rs2: '0x7FFFFFFF' },
      { op: 'mulhsu', rs1: '0x80000000', rs2: 2 },
      { op: 'addi', rs1: 5, imm: -1 },
    ] });
    const vhdl = (result.structuredContent as { vhdl: string }).vhdl;

    expect(vhdl).toContain('type case_t is record');
    expect(vhdl).toContain('op : string(1 to 6);');
    expect(vhdl).toContain('a, b, expected : std_logic_vector(31 downto 0);');
    expect(vhdl).toContain('type case_array is array (natural range <>) of case_t;');
    expect(vhdl).toContain('constant CASES : case_array := (');
    expect(vhdl).toContain('0 => ("slt   ", x"FFFFFFFB", x"7FFFFFFF", x"00000001"),');
    expect(vhdl).toContain('1 => ("mulhsu", x"80000000", x"00000002", x"FFFFFFFF"),');
    expect(vhdl).toContain('2 => ("addi  ", x"00000005", x"FFFFFFFF", x"00000004")\n);');
  });

  it('writes a one-case VHDL table as a valid aggregate', async () => {
    const result = await createEvalHandler(await dependencies())({ format: 'vhdl', cases: [
      { op: 'add', rs1: 1, rs2: 2 },
    ] });

    expect((result.structuredContent as { vhdl: string }).vhdl).toContain(
      'constant CASES : case_array := (\n  0 => ("add   ", x"00000001", x"00000002", x"00000003")\n);',
    );
  });

  it('leaves the VHDL table out of a json result', async () => {
    const result = await createEvalHandler(await dependencies())({ cases: [{ op: 'add', rs1: 1, rs2: 2 }] });

    expect(result.structuredContent).not.toHaveProperty('vhdl');
  });
});

describe('rars_eval', () => {
  it('rejects an op that is not an RV32I/M ALU operation', () => {
    const parsed = evalSchema.safeParse({ cases: [{ op: 'lw', rs1: '0x0', rs2: '0x0' }] });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toMatchObject([{ code: 'invalid_value', path: ['cases', 0, 'op'] }]);
  });

  it('requires rs2 for register ops and imm for immediate ops', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ op: 'add', rs1: 1 }, 'rs2 is required for add'],
      [{ op: 'add', rs1: 1, rs2: 2, imm: 3 }, 'imm is only valid for immediate ops'],
      [{ op: 'addi', rs1: 1 }, 'imm is required for addi'],
      [{ op: 'addi', rs1: 1, imm: 1, rs2: 2 }, 'rs2 is only valid for register ops'],
    ];
    for (const [input, message] of cases) {
      const parsed = evalSchema.safeParse({ cases: [input] });
      expect(parsed.success, JSON.stringify(input)).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), JSON.stringify(input)).toContain(message);
    }
  });

  it('rejects operands and immediates that do not fit their fields', () => {
    const rs1 = 'rs1 must be hex such as 0xFFFFFFFB, or a decimal from -2147483648 to 4294967295';
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ op: 'add', rs1: '0x100000000', rs2: 0 }, rs1],
      [{ op: 'add', rs1: 4294967296, rs2: 0 }, rs1],
      [{ op: 'add', rs1: '-2147483649', rs2: 0 }, rs1],
      [{ op: 'add', rs1: 1.5, rs2: 0 }, rs1],
      [{ op: 'add', rs1: 'ten', rs2: 0 }, rs1],
      [{ op: 'add', rs1: 0, rs2: '0x1FFFFFFFF' }, 'rs2 must be hex'],
      [{ op: 'addi', rs1: 0, imm: 2048 }, 'imm for addi must be from -2048 to 2047, or a 12-bit hex field'],
      [{ op: 'addi', rs1: 0, imm: '0x1000' }, 'imm for addi must be from -2048 to 2047, or a 12-bit hex field'],
      [{ op: 'slli', rs1: 0, imm: 32 }, 'imm for slli must be a shift amount from 0 to 31'],
      [{ op: 'srai', rs1: 0, imm: -1 }, 'imm for srai must be a shift amount from 0 to 31'],
    ];
    for (const [input, message] of cases) {
      const parsed = evalSchema.safeParse({ cases: [input] });
      expect(parsed.success, JSON.stringify(input)).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), JSON.stringify(input)).toContain(message);
    }
  });

  it('takes between 1 and 1024 cases', () => {
    const add = { op: 'add', rs1: 1, rs2: 2 };

    expect(evalSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(evalSchema.safeParse({ cases: Array(1024).fill(add) }).success).toBe(true);
    expect(evalSchema.safeParse({ cases: Array(1025).fill(add) }).success).toBe(false);
  });

  it('checks a direct handler call against the schema', async () => {
    const deps = await dependencies();

    await expect(createEvalHandler(deps)({ cases: [{ op: 'nand' as never, rs1: 1, rs2: 2 }] }))
      .rejects.toThrow(/"op"\s*\][\s\S]*Invalid option/);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('errors clearly when the bridge is not configured', async () => {
    const deps = await dependencies();
    delete deps.bridgeJar;
    delete deps.bridgeToken;

    await expect(createEvalHandler(deps)({ cases: [{ op: 'add', rs1: 1, rs2: 2 }] }))
      .rejects.toThrow('rars_eval needs the stateful RARS bridge to read its results; rars_status shows whether it is configured');
    expect(deps.run).not.toHaveBeenCalled();
  });
});

describe('rars_eval over MCP', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(await dependencies());
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  it('advertises rars_eval with its cases and format', async () => {
    const client = await connect();

    const tool = (await client.listTools()).tools.find((item) => item.name === 'rars_eval');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        cases: { type: 'array', minItems: 1, maxItems: 1024, items: { properties: { op: { enum: expect.arrayContaining(['slt', 'mulhsu', 'srai']) } } } },
        format: { enum: ['json', 'vhdl'] },
      },
      required: ['cases'],
    });
  });

  it('rejects an invalid op', async () => {
    const client = await connect();

    const result = await client.callTool({ name: 'rars_eval', arguments: { cases: [{ op: 'nand', rs1: 1, rs2: 2 }] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('cases.0.op: Invalid option');
  });
});
