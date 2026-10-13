import { copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { createWaveQuery } from '../src/tools/wave.js';
import { Workspace } from '../src/workspace.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wave');
const signals = ['tb_alu.s_a', 'tb_alu/dut/s_sum', 'TB_ALU.S_OVFL', 'tb_alu.s_ratio', 'tb_alu.s_step', 'tb_alu.s_phase'];
const times = ['0 ns', '10ns', '20 ns', '35 ns'];

// Its first timestamp is #5 and its last #20, in 1 ns units.
const shortDump = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! done $end
$var wire 4 " count $end
$upscope $end
$enddefinitions $end
#5
$dumpvars
0!
b0 "
$end
#10
b101 "
#20
1!
b1010 "
`;

async function workspaceWith(...files: string[]): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'rars-wave-'));
  await Promise.all(files.map((file) => copyFile(join(fixtures, file), join(root, file))));
  return Workspace.create(root);
}

async function shortDumpQuery() {
  const workspace = await workspaceWith();
  await writeFile(join(workspace.root, 'short.vcd'), shortDump);
  return createWaveQuery({ workspace, waveMaxBytes: 1024 * 1024 });
}

describe('wave_query', () => {
  it('reads signal values from a VCD written by nvc', async () => {
    const query = createWaveQuery({ workspace: await workspaceWith('alu.vcd'), waveMaxBytes: 1024 * 1024 });

    const result = await query({ file: 'alu.vcd', signals, times });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      timescale: '1 fs',
      startTime: '0 fs',
      endTime: '40 ns',
      signals: [
        { name: 'tb_alu.s_a', width: 4, type: 'logic' },
        { name: 'tb_alu.dut.s_sum', width: 4, type: 'logic' },
        { name: 'tb_alu.s_ovfl', width: 1, type: 'logic' },
        { name: 'tb_alu.s_ratio', width: 64, type: 'real' },
        { name: 'tb_alu.s_step', width: 32, type: 'integer' },
        { name: 'tb_alu.s_phase', width: 0, type: 'string' },
      ],
      values: [
        {
          time: '0 ns',
          'tb_alu.s_a': { bits: '0011', hex: '0x3', unsigned: 3, signed: 3 },
          'tb_alu.dut.s_sum': { bits: '0101', hex: '0x5', unsigned: 5, signed: 5 },
          'tb_alu.s_ovfl': { bits: '0', hex: '0x0', unsigned: 0, signed: 0 },
          'tb_alu.s_ratio': { real: 1.5 },
          'tb_alu.s_step': { bits: '0'.repeat(32), hex: '0x00000000', unsigned: 0, signed: 0 },
          'tb_alu.s_phase': { string: 'setup' },
        },
        {
          time: '10ns',
          'tb_alu.s_a': { bits: '0111', hex: '0x7', unsigned: 7, signed: 7 },
          'tb_alu.dut.s_sum': { bits: '1000', hex: '0x8', unsigned: 8, signed: -8 },
          'tb_alu.s_ovfl': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
          'tb_alu.s_ratio': { real: 0.25 },
          'tb_alu.s_step': { bits: `${'0'.repeat(31)}1`, hex: '0x00000001', unsigned: 1, signed: 1 },
          'tb_alu.s_phase': { string: 'check' },
        },
        {
          time: '20 ns',
          'tb_alu.s_a': { bits: '1000', hex: '0x8', unsigned: 8, signed: -8 },
          'tb_alu.dut.s_sum': { bits: '0111', hex: '0x7', unsigned: 7, signed: 7 },
          'tb_alu.s_ovfl': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
          'tb_alu.s_ratio': { real: -2 },
          'tb_alu.s_step': { bits: `${'0'.repeat(30)}10`, hex: '0x00000002', unsigned: 2, signed: 2 },
          'tb_alu.s_phase': { string: 'check' },
        },
        {
          time: '35 ns',
          'tb_alu.s_a': { bits: '01zx', hex: null, unsigned: null, signed: null },
          'tb_alu.dut.s_sum': { bits: 'xxxx', hex: null, unsigned: null, signed: null },
          'tb_alu.s_ovfl': { bits: 'x', hex: null, unsigned: null, signed: null },
          'tb_alu.s_ratio': { real: -2 },
          'tb_alu.s_step': { bits: '1'.repeat(32), hex: '0xffffffff', unsigned: 4294967295, signed: -1 },
          'tb_alu.s_phase': { string: 'done' },
        },
      ],
    });
  });

  it('shows the values as a table with one row per time', async () => {
    const query = createWaveQuery({ workspace: await workspaceWith('alu.vcd'), waveMaxBytes: 1024 * 1024 });

    const result = await query({ file: 'alu.vcd', signals, times });
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split('\n');

    expect(lines.map((line) => line.split(/ {2,}/))).toEqual([
      ['time', 'tb_alu.s_a', 'tb_alu.dut.s_sum', 'tb_alu.s_ovfl', 'tb_alu.s_ratio', 'tb_alu.s_step', 'tb_alu.s_phase'],
      ['0 ns', '0x3', '0x5', '0', '1.5', '0', 'setup'],
      ['10ns', '0x7', '0x8', '1', '0.25', '1', 'check'],
      ['20 ns', '0x8', '0x7', '1', '-2', '2', 'check'],
      ['35 ns', '01zx', 'xxxx', 'x', '-2', '-1', 'done'],
    ]);
    const columns = lines[0]!.match(/\S+/g)!.map((name) => lines[0]!.indexOf(name));
    for (const line of lines.slice(1)) {
      for (const column of columns.slice(1)) expect(`${line[column - 1]}${line[column]}`, line).toMatch(/^ \S$/);
    }
  });

  it('marks a time before the first timestamp or after the last one at the end of its row', async () => {
    const query = await shortDumpQuery();

    const result = await query({
      file: 'short.vcd', signals: ['top.done', 'top.count'], times: ['2 ns', '5 ns', '20 ns', '500 ns'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      startTime: '5 ns',
      endTime: '20 ns',
      values: [
        { time: '2 ns', beyond: 'before', 'top.done': { bits: 'x' } },
        { time: '5 ns', 'top.done': { bits: '0' } },
        { time: '20 ns', 'top.done': { bits: '1' } },
        { time: '500 ns', beyond: 'after', 'top.done': { bits: '1' } },
      ],
    });
    const values = (result.structuredContent as { values: Array<Record<string, unknown>> }).values;
    expect(values.map((row) => 'beyond' in row)).toEqual([true, false, false, true]);
    expect((result.content[0] as { text: string }).text.split('\n').map((line) => line.split(/ {2,}/))).toEqual([
      ['time', 'top.done', 'top.count'],
      ['2 ns', 'x', 'xxxx', '(before start 5 ns)'],
      ['5 ns', '0', '0x0'],
      ['20 ns', '1', '0xa'],
      ['500 ns', '1', '0xa', '(after end 20 ns)'],
    ]);
  });

  it('leads with the end of the dump when every time is after it', async () => {
    const query = await shortDumpQuery();

    const result = await query({ file: 'short.vcd', signals: ['top.done'], times: ['21 ns', '500 ns'] });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text.split('\n')).toEqual([
      'The dump ends at 20 ns, before every requested time.',
      'time    top.done',
      '21 ns   1         (after end 20 ns)',
      '500 ns  1         (after end 20 ns)',
    ]);
  });

  it('leads with the range of the dump when every time is outside it', async () => {
    const query = await shortDumpQuery();
    const firstLine = async (times: string[]) => {
      const result = await query({ file: 'short.vcd', signals: ['top.done'], times });
      expect(result.isError).toBeFalsy();
      return (result.content[0] as { text: string }).text.split('\n')[0];
    };

    expect(await firstLine(['0 ns', '4 ns'])).toBe('The dump starts at 5 ns, after every requested time.');
    expect(await firstLine(['4 ns', '30 ns'])).toBe('The dump runs from 5 ns to 20 ns, and every requested time is outside it.');
    expect(await firstLine(['4 ns', '5 ns'])).toBe('time  top.done');
  });

  it('refuses a file outside the workspace', async () => {
    const query = createWaveQuery({ workspace: await workspaceWith(), waveMaxBytes: 1024 * 1024 });

    await expect(query({ file: join(fixtures, 'alu.vcd'), signals, times })).rejects.toThrow(
      'Workspace path is outside the configured workspace folders',
    );
  });

  it('refuses a file over WAVE_MAX_BYTES before reading it', async () => {
    const workspace = await workspaceWith('alu.vcd');
    const { size } = await stat(join(workspace.root, 'alu.vcd'));
    const query = createWaveQuery({ workspace, waveMaxBytes: size - 1 });

    await expect(query({ file: 'alu.vcd', signals, times })).rejects.toThrow(
      `alu.vcd is ${size} bytes, over the WAVE_MAX_BYTES limit of ${size - 1}`,
    );
  });

  it('reads an FST file written by nvc the same as the VCD of the same run', async () => {
    const query = createWaveQuery({ workspace: await workspaceWith('alu.vcd', 'alu.fst'), waveMaxBytes: 1024 * 1024 });
    const withLate = [...signals, 'tb_alu.s_late'];
    const pastEnd = [...times, '1 us'];

    const fst = await query({ file: 'alu.fst', signals: withLate, times: pastEnd });
    const vcd = await query({ file: 'alu.vcd', signals: withLate, times: pastEnd });

    expect(fst.isError).toBeFalsy();
    expect(fst).toEqual(vcd);
    expect(fst.structuredContent).toMatchObject({
      startTime: '0 fs',
      endTime: '40 ns',
      values: [
        { time: '0 ns', 'tb_alu.s_a': { hex: '0x3' }, 'tb_alu.s_late': { bits: 'u', hex: null } },
        { time: '10ns', 'tb_alu.dut.s_sum': { bits: '1000', signed: -8 }, 'tb_alu.s_ratio': { real: 0.25 } },
        { time: '20 ns', 'tb_alu.s_ovfl': { bits: '1' }, 'tb_alu.s_late': { bits: '1' } },
        { time: '35 ns', 'tb_alu.s_a': { bits: '01zx', hex: null }, 'tb_alu.s_phase': { string: 'done' } },
        { time: '1 us', beyond: 'after', 'tb_alu.s_a': { bits: '01zx' } },
      ],
    });
    expect((fst.content[0] as { text: string }).text.split('\n').at(-1)).toMatch(/^1 us .* \(after end 40 ns\)$/);
  });

  it('refuses an FST file over WAVE_MAX_BYTES before reading it, or one that unpacks past it', async () => {
    const workspace = await workspaceWith('alu.fst');
    const { size } = await stat(join(workspace.root, 'alu.fst'));

    await expect(createWaveQuery({ workspace, waveMaxBytes: size - 1 })({ file: 'alu.fst', signals, times })).rejects.toThrow(
      `alu.fst is ${size} bytes, over the WAVE_MAX_BYTES limit of ${size - 1}`,
    );
    await expect(createWaveQuery({ workspace, waveMaxBytes: size + 1 })({ file: 'alu.fst', signals, times })).rejects.toThrow(
      `alu.fst is over the WAVE_MAX_BYTES limit of ${size + 1}: it unpacks to 821 bytes`,
    );
  });

  it('names the file and format of an FST file it cannot read', async () => {
    const workspace = await workspaceWith();
    const fstHeader = Buffer.alloc(32);
    fstHeader.writeBigUInt64BE(329n, 1);
    await writeFile(join(workspace.root, 'plain.fst'), fstHeader);
    const query = createWaveQuery({ workspace, waveMaxBytes: 1024 * 1024 });

    await expect(query({ file: 'plain.fst', signals, times })).rejects.toThrow(
      'plain.fst is not a readable FST file: the block at byte 0 runs past the end of the file',
    );
  });

  it('names a GHW file and a gzip-compressed file instead of reading them', async () => {
    const workspace = await workspaceWith();
    await writeFile(join(workspace.root, 'wave.ghw'), Buffer.from('GHDLwave\n\x10\x01\x00\x00', 'latin1'));
    await writeFile(join(workspace.root, 'wave.vcd.gz'), gzipSync(await readFile(join(fixtures, 'alu.vcd'))));
    const query = createWaveQuery({ workspace, waveMaxBytes: 1024 * 1024 });

    await expect(query({ file: 'wave.ghw', signals, times })).rejects.toThrow(
      'wave.ghw is a GHW file, which wave_query does not read; write FST or VCD instead, '
        + 'with nvc --wave=<name>.fst --format=fst or GHDL --vcd=<name>.vcd',
    );
    await expect(query({ file: 'wave.vcd.gz', signals, times })).rejects.toThrow('wave.vcd.gz is gzip-compressed; decompress it first');
  });

  it('requires the size limit to be configured', async () => {
    const query = createWaveQuery({ workspace: await workspaceWith('alu.vcd') });

    await expect(query({ file: 'alu.vcd', signals, times })).rejects.toThrow('Wave queries are not configured');
  });
});

describe('wave_query over MCP', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ workspace: await workspaceWith('alu.vcd'), waveMaxBytes: 1024 * 1024 } as never);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  it('publishes file, signals and times as required inputs', async () => {
    const client = await connect();

    const tool = (await client.listTools()).tools.find((item) => item.name === 'wave_query');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        file: { type: 'string' },
        signals: { type: 'array', items: { type: 'string' } },
        times: { type: 'array', items: { type: 'string' } },
      },
      required: ['file', 'signals', 'times'],
    });
  });

  it('answers a query and reports an unknown signal as an error', async () => {
    const client = await connect();

    const result = await client.callTool({ name: 'wave_query', arguments: { file: 'alu.vcd', signals: ['tb_alu.s_ovfl'], times: ['20 ns'] } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ values: [{ time: '20 ns', 'tb_alu.s_ovfl': { bits: '1' } }] });

    const unknown = await client.callTool({ name: 'wave_query', arguments: { file: 'alu.vcd', signals: ['tb_alu.ovfl'], times: ['20 ns'] } });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('Unknown signal tb_alu.ovfl. Signals named ovfl (1): tb_alu.dut.ovfl');
  });
});
