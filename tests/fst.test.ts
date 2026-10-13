import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, gunzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { queryFst } from '../src/vhdl/fst.js';
import { queryVcd } from '../src/vhdl/vcd.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wave');
const alu = readFileSync(join(fixtures, 'alu.fst'));
const aluVcd = readFileSync(join(fixtures, 'alu.vcd'), 'utf8');
const count = readFileSync(join(fixtures, 'count.fst'));
const options = { name: 'alu.fst', maxBytes: 1024 * 1024 };
const NS = 1_000_000n;

// nvc wraps the whole FST in gzip, after a type byte, the section length and the unpacked length.
const unwrap = (file: Buffer): Buffer => gunzipSync(file.subarray(17));

// Each FST block is a type byte and a section that starts with its own length.
function blocks(file: Buffer): Array<{ type: number; start: number; end: number }> {
  const list = [];
  for (let start = 0; start < file.length;) {
    const end = start + 1 + Number(file.readBigUInt64BE(start + 1));
    list.push({ type: file[start]!, start, end });
    start = end;
  }
  return list;
}

function readVarint(data: Buffer, offset: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let position = offset; ; scale *= 128) {
    const byte = data[position++]!;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, position];
  }
}

function varint(value: bigint): Buffer {
  const bytes = [];
  do {
    const low = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(value > 0n ? low | 0x80 : low);
  } while (value > 0n);
  return Buffer.from(bytes);
}

function u64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

const changeBlock = (file: Buffer) => blocks(file).find((block) => block.type === 8)!;

// Where the byte naming the value-change compression sits: after the block's start-of-block values.
function packTypeOffset(file: Buffer): number {
  const { start } = changeBlock(file);
  const [, afterLength] = readVarint(file, start + 33);
  const [packed, afterPacked] = readVarint(file, afterLength);
  const [, afterHandles] = readVarint(file, afterPacked);
  return readVarint(file, afterHandles + packed)[1];
}

// The value change block, moved later by `ticks`: its start and end times and its first time.
function shiftedBlock(file: Buffer, ticks: bigint): Buffer {
  const { start, end } = changeBlock(file);
  const section = file.subarray(start + 1, end);
  const length = section.length;
  const unpacked = Number(section.readBigUInt64BE(length - 24));
  const packed = Number(section.readBigUInt64BE(length - 16));
  const items = section.readBigUInt64BE(length - 8);
  const stored = section.subarray(length - 24 - packed, length - 24);
  const table = unpacked === packed ? stored : inflateSync(stored);
  const deltas: bigint[] = [];
  for (let position = 0; position < table.length;) {
    const [delta, next] = readVarint(table, position);
    deltas.push(BigInt(delta));
    position = next;
  }
  deltas[0]! += ticks;
  const times = Buffer.concat(deltas.map(varint));
  const compressed = deflateSync(times);
  const rebuilt = Buffer.concat([
    section.subarray(0, length - 24 - packed), compressed, u64(BigInt(times.length)), u64(BigInt(compressed.length)), u64(items),
  ]);
  rebuilt.writeBigUInt64BE(BigInt(rebuilt.length), 0);
  rebuilt.writeBigUInt64BE(rebuilt.readBigUInt64BE(8) + ticks, 8);
  rebuilt.writeBigUInt64BE(rebuilt.readBigUInt64BE(16) + ticks, 16);
  return Buffer.concat([Buffer.from([8]), rebuilt]);
}

// The file with its value change blocks replaced, and the header's first and last timestamps and
// count of blocks to match.
function withChangeBlocks(file: Buffer, changes: Buffer[]): Buffer {
  const { start, end } = changeBlock(file);
  const header = Buffer.from(file.subarray(0, start));
  header.writeBigUInt64BE(changes[0]!.readBigUInt64BE(1 + 8), 1 + 8);
  header.writeBigUInt64BE(changes.at(-1)!.readBigUInt64BE(1 + 16), 1 + 16);
  header.writeBigUInt64BE(BigInt(changes.length), 1 + 64);
  return Buffer.concat([header, ...changes, file.subarray(end)]);
}

function patched(file: Buffer, offset: number, byte: number): Buffer {
  const copy = Buffer.from(file);
  copy[offset] = byte;
  return copy;
}

const bits = (value: unknown) => (value as { bits: string }).bits;

describe('queryFst', () => {
  it('reads the values nvc wrote, the same as the VCD of the same run', async () => {
    const signals = [
      'tb_alu.s_a', 'tb_alu.s_b', 'tb_alu/dut/s_sum', 'TB_ALU.S_OVFL', 'tb_alu.s_late', 'tb_alu.s_ratio',
      'tb_alu.s_step', 'tb_alu.s_phase', 'tb_alu.dut.a', 'tb_alu.dut.sum', 'tb_alu.dut.ovfl',
    ];
    const times = ['0 ns', '10ns', '19.999 ns', '20 ns', '35 ns', '1 us'];

    const result = queryFst(alu, { signals, times }, options);

    expect(result).toEqual(await queryVcd([aluVcd], { signals, times }));
    expect(result).toMatchObject({ timescale: '1 fs', startTime: '0 fs', endTime: '40 ns' });
    expect(result.values.map((row) => row.beyond)).toEqual([undefined, undefined, undefined, undefined, undefined, 'after']);
    expect(result.signals.slice(3, 8)).toEqual([
      { name: 'tb_alu.s_ovfl', width: 1, type: 'logic' },
      { name: 'tb_alu.s_late', width: 1, type: 'logic' },
      { name: 'tb_alu.s_ratio', width: 64, type: 'real' },
      { name: 'tb_alu.s_step', width: 32, type: 'integer' },
      { name: 'tb_alu.s_phase', width: 0, type: 'string' },
    ]);
    expect(result.values.map((row) => [
      row.time, bits(row['tb_alu.s_a']), bits(row['tb_alu.dut.sum']), bits(row['tb_alu.s_ovfl']), bits(row['tb_alu.s_late']),
      row['tb_alu.s_ratio'], (row['tb_alu.s_step'] as { signed: number }).signed, row['tb_alu.s_phase'],
    ])).toEqual([
      ['0 ns', '0011', '0101', '0', 'u', { real: 1.5 }, 0, { string: 'setup' }],
      ['10ns', '0111', '1000', '1', 'u', { real: 0.25 }, 1, { string: 'check' }],
      ['19.999 ns', '0111', '1000', '1', 'u', { real: 0.25 }, 1, { string: 'check' }],
      ['20 ns', '1000', '0111', '1', '1', { real: -2 }, 2, { string: 'check' }],
      ['35 ns', '01zx', 'xxxx', 'x', '1', { real: -2 }, -1, { string: 'done' }],
      ['1 us', '01zx', 'xxxx', 'x', '1', { real: -2 }, -1, { string: 'done' }],
    ]);
    expect(result.values[1]).toMatchObject({
      'tb_alu.s_late': { bits: 'u', hex: null, unsigned: null, signed: null },
      'tb_alu.dut.a': { bits: '0111', hex: '0x7', unsigned: 7, signed: 7 },
    });
  });

  it('reads value changes that nvc compressed', () => {
    const times = Array.from({ length: 1500 }, (_, index) => `${index * 7} ns`);

    const result = queryFst(count, { signals: ['tb_count.clk', 'tb_count.count'], times }, { ...options, name: 'count.fst' });

    expect(result.signals).toEqual([
      { name: 'tb_count.clk', width: 1, type: 'logic' },
      { name: 'tb_count.count', width: 8, type: 'logic' },
    ]);
    // The clock toggles every 5 ns, 2000 times, and the counter counts its rising edges.
    expect(result.values.map((row) => [row.time, bits(row['tb_count.clk']), (row['tb_count.count'] as { unsigned: number }).unsigned]))
      .toEqual(times.map((time, index) => {
        const ns = index * 7;
        const toggles = Math.min(Math.floor(ns / 5), 2000);
        const edges = ns < 5 ? 0 : Math.min(Math.floor((ns - 5) / 10) + 1, 1000);
        return [time, toggles % 2 === 1 ? '1' : '0', edges % 256];
      }));
  });

  it('gives x-filled values for a time before the first dump', () => {
    const late = withChangeBlocks(unwrap(alu), [shiftedBlock(unwrap(alu), 5n * NS)]);
    const signals = ['tb_alu.s_a', 'tb_alu.s_ovfl', 'tb_alu.s_ratio', 'tb_alu.s_phase'];

    const result = queryFst(late, { signals, times: ['4 ns', '5 ns'] }, options);

    expect(result).toMatchObject({ startTime: '5 ns', endTime: '45 ns' });
    expect(result.values).toEqual([
      {
        time: '4 ns',
        beyond: 'before',
        'tb_alu.s_a': { bits: 'xxxx', hex: null, unsigned: null, signed: null },
        'tb_alu.s_ovfl': { bits: 'x', hex: null, unsigned: null, signed: null },
        'tb_alu.s_ratio': { real: null },
        'tb_alu.s_phase': { string: null },
      },
      {
        time: '5 ns',
        'tb_alu.s_a': { bits: '0011', hex: '0x3', unsigned: 3, signed: 3 },
        'tb_alu.s_ovfl': { bits: '0', hex: '0x0', unsigned: 0, signed: 0 },
        'tb_alu.s_ratio': { real: 1.5 },
        'tb_alu.s_phase': { string: 'setup' },
      },
    ]);
  });

  it('reads the value changes of every block', () => {
    const file = unwrap(alu);
    const twice = withChangeBlocks(file, [shiftedBlock(file, 0n), shiftedBlock(file, 40n * NS)]);
    const signals = ['tb_alu.s_a', 'tb_alu.s_late', 'tb_alu.s_ratio', 'tb_alu.s_phase'];

    const first = queryFst(twice, { signals, times: ['5 ns', '20 ns', '35 ns'] }, options);
    const second = queryFst(twice, { signals, times: ['45 ns', '60 ns', '75 ns'] }, options);

    expect(second).toMatchObject({ startTime: '0 fs', endTime: '80 ns' });
    expect(second.values.map(({ time: _time, ...values }) => values)).toEqual(first.values.map(({ time: _time, ...values }) => values));
    expect(second.values[2]).toMatchObject({ 'tb_alu.s_a': { bits: '01zx' }, 'tb_alu.s_phase': { string: 'done' } });
  });

  it('reads an FST file without the gzip wrapper', () => {
    const query = { signals: ['tb_alu.s_a', 'tb_alu.s_ratio', 'tb_alu.s_phase'], times: ['0', '20 ns', '35 ns'] };

    expect(queryFst(unwrap(alu), query, options)).toEqual(queryFst(alu, query, options));
  });

  it('matches nested names with . or / separators and bit ranges, ignoring case', () => {
    const result = queryFst(alu, { signals: ['/TB_ALU/DUT/SUM', 'tb_alu.s_a[3:0]', 'tb_alu.S_A'], times: ['20 ns'] }, options);

    expect(result.signals).toEqual([
      { name: 'tb_alu.dut.sum', width: 4, type: 'logic' },
      { name: 'tb_alu.s_a', width: 4, type: 'logic' },
    ]);
    expect(result.values[0]).toMatchObject({ 'tb_alu.dut.sum': { hex: '0x7' }, 'tb_alu.s_a': { hex: '0x8' } });
  });

  it('reports an unknown signal with the signals that share its last name', () => {
    expect(() => queryFst(alu, { signals: ['tb_alu.ovfl'], times: ['0'] }, options)).toThrow(
      'Unknown signal tb_alu.ovfl. Signals named ovfl (1): tb_alu.dut.ovfl',
    );
    expect(() => queryFst(alu, { signals: ['tb_alu.nothing'], times: ['0'] }, options)).toThrow(
      'Unknown signal tb_alu.nothing. No signal is named nothing; signals in the file (13): tb_alu.s_a, tb_alu.s_b, ',
    );
  });

  it('rejects a time it cannot read', () => {
    expect(() => queryFst(alu, { signals: ['tb_alu.s_a'], times: ['20 nanoseconds'] }, options)).toThrow(
      'Cannot read time "20 nanoseconds"',
    );
  });

  it('refuses a file that unpacks past the size limit', () => {
    expect(() => queryFst(alu, { signals: ['tb_alu.s_a'], times: ['0'] }, { ...options, maxBytes: 600 })).toThrow(
      'alu.fst is over the WAVE_MAX_BYTES limit of 600: it unpacks to 821 bytes',
    );
    expect(() => queryFst(unwrap(alu), { signals: ['tb_alu.s_a'], times: ['0'] }, { ...options, maxBytes: 400 })).toThrow(
      'alu.fst is over the WAVE_MAX_BYTES limit of 400: its signal names unpack to 450 bytes',
    );
  });

  it('names the file and format when it cannot read the file', () => {
    const file = unwrap(alu);
    const query = { signals: ['tb_alu.s_a'], times: ['0'] };

    expect(() => queryFst(alu.subarray(0, 100), query, options)).toThrow(/^alu\.fst is not a readable FST file: /);
    expect(() => queryFst(file.subarray(0, 400), query, options)).toThrow(
      'alu.fst is not a readable FST file: the block at byte 330 runs past the end of the file',
    );
    expect(() => queryFst(file.subarray(0, 330), query, options)).toThrow(
      'alu.fst is not a readable FST file: it has no signal names (hierarchy block)',
    );
    expect(() => queryFst(patched(file, changeBlock(file).start, 255), query, options)).toThrow(
      'alu.fst is not a readable FST file: the block at byte 330 was never finished, as happens when the simulation '
        + 'is still running or stopped before closing the file',
    );
  });

  it('names a block that counts more signals than the file holds', () => {
    const file = unwrap(alu);
    const query = { signals: ['tb_alu.s_a'], times: ['0'] };
    const geometry = Buffer.from(file);
    geometry.writeBigUInt64BE(2n ** 40n, blocks(file).find((block) => block.type === 3)!.start + 1 + 16);

    expect(() => queryFst(geometry, query, options)).toThrow(
      `alu.fst is not a readable FST file: its signal widths count ${2 ** 40} signals but hold 15 bytes`,
    );
    // The handle count is the varint just before the compression byte; 11 fits in one byte.
    expect(() => queryFst(patched(file, packTypeOffset(file) - 1, 0x7f), query, options)).toThrow(
      'alu.fst is not a readable FST file: its value change block at byte 330 holds changes for 127 signals, '
        + 'but the file gives widths for 11',
    );
  });

  it('refuses FST features that nvc does not write', () => {
    const file = unwrap(alu);
    const hierarchy = blocks(file).find((block) => block.type === 4)!;
    const timeZero = Buffer.from(file);
    timeZero.writeBigInt64BE(5n, 1 + 321);
    const blackout = Buffer.concat([file, Buffer.from([2]), u64(9n), Buffer.from([0])]);
    const query = { signals: ['tb_alu.s_a'], times: ['0'] };

    expect(() => queryFst(patched(file, packTypeOffset(file), 0x34), query, options)).toThrow(
      'alu.fst stores its value changes LZ4-compressed, which wave_query does not read',
    );
    expect(() => queryFst(patched(file, packTypeOffset(file), 0x46), query, options)).toThrow(
      'alu.fst stores its value changes FastLZ-compressed, which wave_query does not read',
    );
    expect(() => queryFst(patched(file, hierarchy.start, 6), query, options)).toThrow(
      'alu.fst stores its signal names LZ4-compressed, which wave_query does not read',
    );
    expect(() => queryFst(patched(file, changeBlock(file).start, 5), query, options)).toThrow(
      'alu.fst has value change blocks of type 5, which wave_query does not read',
    );
    expect(() => queryFst(timeZero, query, options)).toThrow('alu.fst has a time zero of 5, which wave_query does not read');
    expect(() => queryFst(blackout, query, options)).toThrow('alu.fst has $dumpoff periods, which wave_query does not read');
  });
});
