import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { doFileCheckSchema } from '../src/tools/dofile.js';
import { encodeSchema } from '../src/tools/encode.js';
import { evalSchema } from '../src/tools/eval.js';
import { vhdlMutateSchema } from '../src/tools/mutate.js';
import {
  assembleSchema, closeSessionSchema, debugCommandSchema, debugStartSchema, emptySchema, inspectSchema,
  liveCommandSchema, liveConnectSchema, modifySchema, runSchema,
} from '../src/tools/schemas.js';
import { statusSchema } from '../src/tools/status.js';
import { vhdlCompileSchema, vhdlRunSchema } from '../src/tools/vhdl.js';
import { waveQuerySchema } from '../src/tools/wave.js';
import { Workspace } from '../src/workspace.js';

const sessionId = '00000000-0000-4000-8000-000000000000';

type Input = Record<string, unknown>;

interface UnknownKey {
  // The valid input with one key added or misspelt.
  input: Input;
  // Where the key is, as the server prints the path: '' for the top level.
  path: string;
  key: string;
  // Every issue reported, when a misspelt required key is also reported missing.
  issues?: string;
}

interface ToolCase {
  tool: string;
  schema: z.ZodType;
  valid: Input;
  topLevel: UnknownKey;
  nested: UnknownKey[];
}

const dumpEntry = { segment: '.text', format: 'HexText', file: 'mem/imem.hex' };
const sourceFiles = [{ name: 'main.s', text: 'nop' }, { name: 'lib.s', text: 'nop' }];
const evalCase = { op: 'slt', rs1: '0xFFFFFFFB', rs2: '0x7FFFFFFF' };
const memoryRead = { address: '0x10010000', length: 4 };
const memoryWrite = { address: '0x10010000', value: '0x1', width: 4 };
const testbench = { top: 'adder_tb', files: ['adder.vhd', 'adder_tb.vhd'] };
const mutation = { name: 'plus to minus', find: '+', replace: '-', occurrence: 1 };

const cases: ToolCase[] = [
  {
    tool: 'rars_assemble',
    schema: assembleSchema,
    valid: { files: ['prog.s'], dump: [dumpEntry] },
    topLevel: { input: { files: ['prog.s'], dumps: [dumpEntry] }, path: '', key: 'dumps' },
    nested: [
      { input: { files: ['prog.s'], dump: [{ ...dumpEntry, path: 'mem/imem.hex' }] }, path: 'dump.0', key: 'path' },
      { input: { source: [sourceFiles[0], { ...sourceFiles[1], file: 'lib.s' }] }, path: 'source.1', key: 'file' },
      // A misspelt required key fails both forms of source, so the union names the key.
      { input: { source: [sourceFiles[0], { name: 'lib.s', txt: 'nop' }] }, path: 'source', key: 'txt' },
    ],
  },
  {
    tool: 'rars_run',
    schema: runSchema,
    valid: { files: ['prog.s'], dump: [{ segment: { address: '0x10010000', words: 4 }, format: 'HexText' }] },
    topLevel: { input: { files: ['prog.s'], dumps: [{ segment: '.data', format: 'HexText' }] }, path: '', key: 'dumps' },
    nested: [
      { input: { files: ['prog.s'], dump: [{ segment: '.data', format: 'HexText', words: 4 }] }, path: 'dump.0', key: 'words' },
      {
        input: { files: ['prog.s'], dump: [{ segment: { address: '0x10010000', words: 4, length: 4 }, format: 'HexText' }] },
        path: 'dump.0.segment',
        key: 'length',
      },
      // A misspelt required key fails every form of segment, so the union names the key.
      {
        input: { files: ['prog.s'], dump: [{ segment: { lable: 'results', words: 4 }, format: 'HexText' }] },
        path: 'dump.0.segment',
        key: 'lable',
      },
      { input: { source: [{ ...sourceFiles[0], contents: 'nop' }] }, path: 'source.0', key: 'contents' },
    ],
  },
  {
    tool: 'rars_eval',
    schema: evalSchema,
    valid: { cases: [evalCase], format: 'vhdl' },
    topLevel: { input: { cases: [evalCase], output: 'vhdl' }, path: '', key: 'output' },
    nested: [{ input: { cases: [{ ...evalCase, rd: '0x1' }] }, path: 'cases.0', key: 'rd' }],
  },
  {
    tool: 'rars_session_list',
    schema: emptySchema,
    valid: {},
    topLevel: { input: { sessionId }, path: '', key: 'sessionId' },
    nested: [],
  },
  {
    tool: 'rars_session_close',
    schema: closeSessionSchema,
    valid: { sessionId },
    topLevel: { input: { sessionId, force: true }, path: '', key: 'force' },
    nested: [],
  },
  {
    tool: 'rars_status',
    schema: statusSchema,
    valid: {},
    topLevel: { input: { verbose: true }, path: '', key: 'verbose' },
    nested: [],
  },
  {
    tool: 'rars_debug_start',
    schema: debugStartSchema,
    valid: { source: sourceFiles, programArgs: ['1'], stdin: '' },
    topLevel: { input: { files: ['prog.s'], args: ['1'] }, path: '', key: 'args' },
    nested: [
      { input: { source: [{ ...sourceFiles[0], path: 'main.s' }] }, path: 'source.0', key: 'path' },
      { input: { source: [{ name: 'main.s', contents: 'nop' }] }, path: 'source', key: 'contents' },
    ],
  },
  {
    tool: 'rars_debug_command',
    schema: debugCommandSchema,
    valid: { sessionId, action: 'continue', maxSteps: 10 },
    topLevel: { input: { sessionId, action: 'continue', steps: 10 }, path: '', key: 'steps' },
    nested: [],
  },
  {
    tool: 'rars_inspect',
    schema: inspectSchema,
    valid: { sessionId, registers: ['t0'], memory: [memoryRead], includeSymbols: true, instructions: { around: 'pc', count: 4 } },
    topLevel: { input: { sessionId, symbols: true }, path: '', key: 'symbols' },
    nested: [
      { input: { sessionId, memory: [{ ...memoryRead, width: 4 }] }, path: 'memory.0', key: 'width' },
      { input: { sessionId, instructions: { around: 'pc', size: 4 } }, path: 'instructions', key: 'size' },
    ],
  },
  {
    tool: 'rars_modify',
    schema: modifySchema,
    valid: { sessionId, registers: { t0: '0x1' }, memory: [memoryWrite] },
    topLevel: { input: { sessionId, register: { t0: '0x1' } }, path: '', key: 'register' },
    nested: [{ input: { sessionId, memory: [{ ...memoryWrite, length: 4 }] }, path: 'memory.0', key: 'length' }],
  },
  {
    tool: 'rars_encode',
    schema: encodeSchema,
    valid: { instructions: ['addi t0, t0, 1'] },
    topLevel: { input: { instructions: ['addi t0, t0, 1'], format: 'hex' }, path: '', key: 'format' },
    nested: [],
  },
  {
    tool: 'rars_live_connect',
    schema: liveConnectSchema,
    valid: {},
    topLevel: { input: { host: '127.0.0.1' }, path: '', key: 'host' },
    nested: [],
  },
  {
    tool: 'rars_live_command',
    schema: liveCommandSchema,
    valid: { sessionId, command: { action: 'load', files: ['prog.s'], conflictPolicy: 'discard' } },
    topLevel: { input: { sessionId, command: { action: 'load', files: ['prog.s'] }, conflictPolicy: 'discard' }, path: '', key: 'conflictPolicy' },
    nested: [
      { input: { sessionId, command: { action: 'load', files: ['prog.s'], conflict: 'discard' } }, path: 'command', key: 'conflict' },
      { input: { sessionId, command: { action: 'step', maxSteps: 10 } }, path: 'command', key: 'maxSteps' },
      { input: { sessionId, command: { action: 'breakpoint_add', address: 'main', file: 'prog.s' } }, path: 'command', key: 'file' },
      { input: { sessionId, command: { action: 'inspect', memory: [{ ...memoryRead, width: 4 }] } }, path: 'command.memory.0', key: 'width' },
      { input: { sessionId, command: { action: 'modify', memory: [{ ...memoryWrite, length: 4 }] } }, path: 'command.memory.0', key: 'length' },
      // A misspelt required key is named along with the key it stands for.
      {
        input: { sessionId, command: { action: 'load', fils: ['prog.s'] } },
        path: 'command',
        key: 'fils',
        issues: 'command.files: Invalid input: expected array, received undefined, command: Unrecognized key: "fils"',
      },
      {
        input: { sessionId, command: { action: 'breakpoint_add', adress: 'main' } },
        path: 'command',
        key: 'adress',
        issues: 'command.address: Invalid input: expected string, received undefined, command: Unrecognized key: "adress"',
      },
    ],
  },
  {
    tool: 'wave_query',
    schema: waveQuerySchema,
    valid: { file: 'tb.vcd', signals: ['tb_alu.s_ovfl'], times: ['20 ns'] },
    topLevel: { input: { file: 'tb.vcd', signals: ['tb_alu.s_ovfl'], times: ['20 ns'], time: '20 ns' }, path: '', key: 'time' },
    nested: [],
  },
  {
    tool: 'do_file_check',
    schema: doFileCheckSchema,
    valid: { path: 'run.do', std: '2008' },
    topLevel: { input: { path: 'run.do', standard: '2008' }, path: '', key: 'standard' },
    nested: [],
  },
  {
    tool: 'vhdl_compile',
    schema: vhdlCompileSchema,
    valid: { files: ['alu.vhd'], std: '08', work: 'work' },
    topLevel: { input: { files: ['alu.vhd'], library: 'work' }, path: '', key: 'library' },
    nested: [],
  },
  {
    tool: 'vhdl_run',
    schema: vhdlRunSchema,
    valid: { testbench: 'tb', files: ['tb.vhd'], stopTime: '1 us', generics: { WIDTH: '8' }, wave: { file: 'waves/tb.vcd', format: 'vcd' } },
    topLevel: { input: { testbench: 'tb', files: ['tb.vhd'], stop: '1 us' }, path: '', key: 'stop' },
    nested: [{ input: { testbench: 'tb', files: ['tb.vhd'], wave: { file: 'waves/tb.vcd', type: 'vcd' } }, path: 'wave', key: 'type' }],
  },
  {
    tool: 'vhdl_mutate',
    schema: vhdlMutateSchema,
    valid: { file: 'adder.vhd', testbenches: [testbench], mutations: [mutation], std: '08', timeoutMs: 1000 },
    topLevel: { input: { file: 'adder.vhd', testbenches: [testbench], mutation: [mutation] }, path: '', key: 'mutation' },
    nested: [
      { input: { file: 'adder.vhd', testbenches: [{ ...testbench, std: '08' }] }, path: 'testbenches.0', key: 'std' },
      { input: { file: 'adder.vhd', testbenches: [testbench], mutations: [{ ...mutation, with: '-' }] }, path: 'mutations.0', key: 'with' },
    ],
  },
];

function expectedError(tool: string, { path, key, issues }: UnknownKey): string {
  return `Input validation error: Invalid arguments for tool ${tool}: ${issues ?? `${path === '' ? '' : `${path}: `}Unrecognized key: "${key}"`}`;
}

// Every object in a JSON schema: properties, items, unions and record values, at any depth.
function objectSchemas(schema: unknown, at = '$'): Array<{ at: string; schema: Record<string, unknown> }> {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const found = node.type === 'object' ? [{ at, schema: node }] : [];
  const children: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node.properties ?? {})) children.push([`${at}.${key}`, value]);
  for (const key of ['items', 'additionalProperties'] as const) children.push([`${at}.${key}`, node[key]]);
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    if (Array.isArray(node[key])) node[key].forEach((value, index) => children.push([`${at}.${key}[${index}]`, value]));
  }
  return [...found, ...children.flatMap(([path, child]) => objectSchemas(child, path))];
}

describe('strict tool input schemas', () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const workspace = await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-strict-')));
    const server = createMcpServer({ workspace } as never);
    client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
  });
  afterAll(async () => { await close(); });

  it('covers every registered tool', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(cases.map(({ tool }) => tool).sort()).toEqual([...names].sort());
  });

  it('publishes additionalProperties: false on every fixed-key object', async () => {
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
      // The walk below does not follow references, so every object must be inline.
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
      for (const { at, schema } of objectSchemas(tool.inputSchema)) {
        // A record has no fixed keys: its additionalProperties is the schema of its values.
        const expected = 'properties' in schema ? false : expect.objectContaining({ type: 'string' });
        expect(schema.additionalProperties, `${tool.name} ${at}`).toEqual(expected);
      }
    }
  });

  it('still runs refinements alongside an unknown key', async () => {
    const checks: Array<[string, Input, string]> = [
      ['rars_run', { dumps: [dumpEntry] }, 'Unrecognized key: "dumps", Either files or source is required'],
      ['rars_debug_command', { sessionId, action: 'step', maxSteps: 1, steps: 1 }, 'Unrecognized key: "steps", maxSteps: maxSteps is only valid for continue'],
    ];
    for (const [tool, input, issues] of checks) {
      const result = await client.callTool({ name: tool, arguments: input });
      expect(result.isError, tool).toBe(true);
      expect(result.content, tool).toEqual([{ type: 'text', text: `Input validation error: Invalid arguments for tool ${tool}: ${issues}` }]);
    }
  });

  describe.each(cases)('$tool', ({ tool, schema, valid, topLevel, nested }) => {
    const call = async (input: Input) => {
      const result = await client.callTool({ name: tool, arguments: input });
      expect(result.isError, JSON.stringify(input)).toBe(true);
      return (result.content as Array<{ type: string; text: string }>).map((item) => item.text).join('\n');
    };

    it('accepts the valid input', () => {
      expect(schema.safeParse(valid).error?.issues).toBeUndefined();
    });

    it('rejects an unknown top-level key', async () => {
      expect(await call(topLevel.input)).toBe(expectedError(tool, topLevel));
    });

    if (nested.length > 0) {
      it('rejects an unknown nested key', async () => {
        for (const unknown of nested) expect(await call(unknown.input), JSON.stringify(unknown.input)).toBe(expectedError(tool, unknown));
      });
    }
  });
});
