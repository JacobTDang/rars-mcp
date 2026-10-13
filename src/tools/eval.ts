import { z } from 'zod';

import { createToolHandlers, type ToolDependencies, type ToolResult } from './handlers.js';

const registerOps = [
  'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and',
  'mul', 'mulh', 'mulhu', 'mulhsu', 'div', 'divu', 'rem', 'remu',
] as const;
const immediateOps = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'slli', 'srli', 'srai'] as const;
const shiftOps: readonly string[] = ['slli', 'srli', 'srai'];
const isImmediateOp = (op: string) => (immediateOps as readonly string[]).includes(op);
// Wide enough for the longest op, mulhsu, so every table declares the same record type.
const opWidth = 6;

function decimal(value: string | number): number {
  return typeof value === 'number' ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}

// An operand is a 32-bit pattern: hex of up to 8 digits, or a decimal read as signed or unsigned.
function word(value: string | number): number | undefined {
  if (typeof value === 'string' && /^0x[0-9a-f]{1,8}$/i.test(value)) return Number.parseInt(value, 16);
  const number = decimal(value);
  return Number.isSafeInteger(number) && number >= -(2 ** 31) && number < 2 ** 32 ? number >>> 0 : undefined;
}

// The immediate is the value the ALU sees: a decimal, or a hex instruction field that is
// sign-extended from 12 bits. Shift amounts are 5 bits and never negative.
function immediate(op: string, value: string | number): number | undefined {
  const shift = shiftOps.includes(op);
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const field = Number.parseInt(value, 16);
    if (field >= 2 ** (shift ? 5 : 12)) return undefined;
    return !shift && field >= 2 ** 11 ? field - 2 ** 12 : field;
  }
  const number = decimal(value);
  const [low, high] = shift ? [0, 31] : [-2048, 2047];
  return Number.isInteger(number) && number >= low && number <= high ? number : undefined;
}

const operandSchema = z.union([z.string(), z.number()]);
const operandForm = 'hex such as 0xFFFFFFFB, or a decimal from -2147483648 to 4294967295';
const caseSchema = z.strictObject({
  op: z.enum([...registerOps, ...immediateOps]),
  rs1: operandSchema.describe(`32-bit operand: ${operandForm}`),
  rs2: operandSchema.describe('Second operand of a register op, in the same form as rs1').optional(),
  imm: operandSchema.describe('Immediate of an immediate op: -2048 to 2047, or a 12-bit hex field such as 0xFFF that is '
    + 'sign-extended; a shift amount from 0 to 31 for slli, srli and srai').optional(),
}).superRefine((item, context) => {
  if (word(item.rs1) === undefined) context.addIssue({ code: 'custom', path: ['rs1'], message: `rs1 must be ${operandForm}` });
  if (isImmediateOp(item.op)) {
    if (item.rs2 !== undefined) {
      context.addIssue({ code: 'custom', path: ['rs2'], message: 'rs2 is only valid for register ops' });
    }
    if (item.imm === undefined) {
      context.addIssue({ code: 'custom', path: ['imm'], message: `imm is required for ${item.op}` });
    } else if (immediate(item.op, item.imm) === undefined) {
      const range = shiftOps.includes(item.op) ? 'a shift amount from 0 to 31' : 'from -2048 to 2047, or a 12-bit hex field';
      context.addIssue({ code: 'custom', path: ['imm'], message: `imm for ${item.op} must be ${range}` });
    }
  } else {
    if (item.imm !== undefined) {
      context.addIssue({ code: 'custom', path: ['imm'], message: 'imm is only valid for immediate ops' });
    }
    if (item.rs2 === undefined) {
      context.addIssue({ code: 'custom', path: ['rs2'], message: `rs2 is required for ${item.op}` });
    } else if (word(item.rs2) === undefined) {
      context.addIssue({ code: 'custom', path: ['rs2'], message: `rs2 must be ${operandForm}` });
    }
  }
});
export const evalSchema = z.strictObject({
  cases: z.array(caseSchema).min(1).max(1024),
  format: z.enum(['json', 'vhdl']).describe('vhdl also returns a constant table for a testbench').optional(),
});

export type EvalInput = z.infer<typeof evalSchema>;

// b is the second ALU input: rs2, or the immediate after sign extension.
interface Operands {
  op: string;
  a: number;
  b: number;
  imm?: number;
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`;
}

// Each result is stored in the next word of results, so one run and one dump answer every case in order.
function program(cases: Operands[]): string {
  const lines = ['.data', `results: .space ${4 * cases.length}`, '.text', 'main:', '  la s0, results'];
  for (const { op, a, b, imm } of cases) {
    lines.push(`  li t0, ${a | 0}`);
    if (imm === undefined) lines.push(`  li t1, ${b | 0}`, `  ${op} t2, t0, t1`);
    else lines.push(`  ${op} t2, t0, ${imm}`);
    lines.push('  sw t2, 0(s0)', '  addi s0, s0, 4');
  }
  lines.push('  li a7, 10', '  ecall');
  return `${lines.join('\n')}\n`;
}

function vhdlTable(rows: Array<Operands & { rd: number }>): string {
  const vhdlHex = (value: number) => `x"${hex(value).slice(2).toUpperCase()}"`;
  // Named association keeps a one-case table an aggregate; a lone positional element is just a parenthesised expression.
  const entries = rows.map(({ op, a, b, rd }, index) =>
    `  ${index} => ("${op.padEnd(opWidth)}", ${vhdlHex(a)}, ${vhdlHex(b)}, ${vhdlHex(rd)})`);
  return [
    'type case_t is record',
    `  op : string(1 to ${opWidth});`,
    '  a, b, expected : std_logic_vector(31 downto 0);',
    'end record;',
    'type case_array is array (natural range <>) of case_t;',
    'constant CASES : case_array := (',
    entries.join(',\n'),
    ');',
  ].join('\n');
}

function textOf(result: ToolResult): string {
  return result.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
}

export function createEvalHandler(deps: ToolDependencies) {
  const { run } = createToolHandlers(deps);
  return async (input: EvalInput): Promise<ToolResult> => {
    // Parsed again here because a direct handler call does not pass through the tool schema.
    const { cases, format } = evalSchema.parse(input);
    if (!deps.bridgeJar || !deps.bridgeToken) {
      throw new Error('rars_eval needs the stateful RARS bridge to read its results; rars_status shows whether it is configured');
    }
    // The schema has already checked that every operand converts.
    const operands: Operands[] = cases.map(({ op, rs1, rs2, imm }) => {
      const a = word(rs1)!;
      if (imm === undefined) return { op, a, b: word(rs2!)! };
      const value = immediate(op, imm)!;
      return { op, a, b: value >>> 0, imm: value };
    });
    const result = await run({
      source: program(operands),
      dump: [{ segment: { label: 'results', words: cases.length }, format: 'HexText' }],
    });
    if (result.isError) throw new Error(`rars_eval program failed in RARS: ${textOf(result)}`);
    const words = (result.structuredContent as { dumps?: Array<{ words?: string[] }> }).dumps?.[0]?.words ?? [];
    if (words.length !== cases.length || words.some((value) => !/^0x[0-9a-f]{8}$/i.test(value))) {
      throw new Error(`rars_eval expected ${cases.length} result words from RARS, got: ${words.join(', ')}`);
    }
    const rows = operands.map((operand, index) => ({ ...operand, rd: Number.parseInt(words[index]!, 16) }));
    const results = rows.map(({ op, a, b, imm, rd }) => ({
      op,
      rs1: hex(a),
      ...(imm === undefined ? { rs2: hex(b) } : { imm }),
      rd: { hex: hex(rd), signed: rd | 0, unsigned: rd },
      zero: rd === 0,
    }));
    const table = rows.map(({ op, a, b, imm, rd }) => `${op} | ${hex(a)} | ${imm ?? hex(b)} | ${hex(rd)}`);
    const text = [`Evaluated ${cases.length} case${cases.length === 1 ? '' : 's'}`, 'op | rs1 | rs2/imm | rd', ...table].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { results, ...(format === 'vhdl' ? { vhdl: vhdlTable(rows) } : {}) },
    };
  };
}
