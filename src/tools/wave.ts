import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

import { queryFst } from '../vhdl/fst.js';
import { queryVcd } from '../vhdl/vcd.js';
import type { WaveQueryResult, WaveSignal, WaveValue } from '../vhdl/wave.js';
import type { ToolDependencies, ToolResult } from './handlers.js';

export const waveQuerySchema = z.strictObject({
  file: z.string().min(1).describe('A VCD or FST file in the workspace'),
  signals: z.array(z.string().min(1)).min(1)
    .describe('Hierarchical signal names such as tb_alu.s_ovfl or tb_alu/dut/s_sum, matched ignoring case'),
  times: z.array(z.string().min(1)).min(1)
    .describe('Times such as "20 ns", "1.5us", or "100" in the file\'s timescale units'),
});

export type WaveQueryInput = z.infer<typeof waveQuerySchema>;

export function createWaveQuery(deps: Pick<ToolDependencies, 'workspace' | 'waveMaxBytes'>) {
  return async (input: WaveQueryInput): Promise<ToolResult> => {
    if (deps.waveMaxBytes === undefined) throw new Error('Wave queries are not configured');
    const file = await deps.workspace.resolve(input.file);
    const { size } = await stat(file);
    if (size > deps.waveMaxBytes) {
      throw new Error(`${input.file} is ${size} bytes, over the WAVE_MAX_BYTES limit of ${deps.waveMaxBytes}`);
    }
    const format = await binaryFormat(file);
    if (format === 'gzip') throw new Error(`${input.file} is gzip-compressed; decompress it first`);
    if (format === 'GHW') {
      throw new Error(`${input.file} is a GHW file, which wave_query does not read; write FST or VCD instead, `
        + 'with nvc --wave=<name>.fst --format=fst or GHDL --vcd=<name>.vcd');
    }
    // An FST file is read whole, which the size check above bounds; VCD text is streamed.
    const result = format === 'FST'
      ? queryFst(await readFile(file), input, { name: input.file, maxBytes: deps.waveMaxBytes })
      : await queryVcd(createReadStream(file, { encoding: 'utf8' }), input);
    return { content: [{ type: 'text', text: table(result) }], structuredContent: result as unknown as Record<string, unknown> };
  };
}

// Waveform files that are not VCD text, told apart by their first bytes.
async function binaryFormat(file: string): Promise<'FST' | 'GHW' | 'gzip' | undefined> {
  const handle = await open(file);
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(32), 0, 32, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.subarray(0, 9).toString('latin1') === 'GHDLwave\n') return 'GHW';
    // FST opens with its 329-byte header block (type 0), or with the whole file gzip-wrapped (type 254).
    if (head[0] === 0 && head.length >= 9 && head.readBigUInt64BE(1) === 329n) return 'FST';
    if (head[0] === 254 && head[17] === 0x1f && head[18] === 0x8b) return 'FST';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
    return undefined;
  } finally {
    await handle.close();
  }
}

// One row per time and one column per signal: hex for vectors, bits for scalars and unknown values. A time
// outside the dump is noted at the end of its row.
function table(result: WaveQueryResult): string {
  const { startTime, endTime, signals, values } = result;
  const notes = { before: `(before start ${startTime})`, after: `(after end ${endTime})` };
  const rows = [
    ['time', ...signals.map((signal) => signal.name), ''],
    ...values.map((row) => [
      row.time,
      ...signals.map((signal) => cell(signal, row[signal.name] as WaveValue)),
      row.beyond === undefined ? '' : notes[row.beyond],
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) => row.map((text, column) => text.padEnd(widths[column]!)).join('  ').trimEnd());
  return [...outside(result), ...lines].join('\n');
}

// A first line when no requested time is inside the dump, since then no value in the table was recorded.
function outside({ startTime, endTime, values }: WaveQueryResult): string[] {
  if (values.some((row) => row.beyond === undefined)) return [];
  if (values.every((row) => row.beyond === 'after')) return [`The dump ends at ${endTime}, before every requested time.`];
  if (values.every((row) => row.beyond === 'before')) return [`The dump starts at ${startTime}, after every requested time.`];
  return [`The dump runs from ${startTime} to ${endTime}, and every requested time is outside it.`];
}

function cell(signal: WaveSignal, value: WaveValue): string {
  if ('real' in value) return value.real === null ? 'x' : String(value.real);
  if ('string' in value) return value.string ?? 'x';
  if (value.hex === null || signal.width === 1) return value.bits;
  return signal.type === 'integer' ? String(value.signed) : value.hex;
}
