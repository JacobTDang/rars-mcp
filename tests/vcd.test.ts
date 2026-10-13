import { describe, expect, it } from 'vitest';

import { queryVcd } from '../src/vhdl/vcd.js';

const basic = `$date today $end
$version handwritten $end
$timescale 1 ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 4 " data [3:0] $end
$var real 64 # ratio $end
$var string 0 ' phase $end
$scope module core $end
$var reg 4 $ acc $end
$var wire 1 ! clk $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
b0 "
r0 #
sidle '
bx $
$end
#10
1!
b1010 "
r1.5 #
srun '
#20
0!
b1z $
#30
b11 $
`;

const query = (text: string, signals: string[], times: string[]) => queryVcd([text], { signals, times });

describe('queryVcd', () => {
  it('reads scalars, vectors, reals and strings at the requested times', async () => {
    const result = await query(basic, ['top.clk', 'top.data', 'top.ratio', 'top.phase'], ['15 ns']);

    expect(result.timescale).toBe('1 ns');
    expect(result.signals).toEqual([
      { name: 'top.clk', width: 1, type: 'wire' },
      { name: 'top.data', width: 4, type: 'wire' },
      { name: 'top.ratio', width: 64, type: 'real' },
      { name: 'top.phase', width: 0, type: 'string' },
    ]);
    expect(result.values).toEqual([{
      time: '15 ns',
      'top.clk': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
      'top.data': { bits: '1010', hex: '0xa', unsigned: 10, signed: -6 },
      'top.ratio': { real: 1.5 },
      'top.phase': { string: 'run' },
    }]);
  });

  it('returns the last change at or before each time', async () => {
    const result = await query(basic, ['top.clk', 'top.core.acc'], ['0', '10', '19 ns', '20ns', '1 us']);

    expect(result.values.map((row) => [row.time, row['top.clk'], row['top.core.acc']])).toEqual([
      ['0', { bits: '0', hex: '0x0', unsigned: 0, signed: 0 }, { bits: 'xxxx', hex: null, unsigned: null, signed: null }],
      ['10', { bits: '1', hex: '0x1', unsigned: 1, signed: -1 }, { bits: 'xxxx', hex: null, unsigned: null, signed: null }],
      ['19 ns', { bits: '1', hex: '0x1', unsigned: 1, signed: -1 }, { bits: 'xxxx', hex: null, unsigned: null, signed: null }],
      ['20ns', { bits: '0', hex: '0x0', unsigned: 0, signed: 0 }, { bits: '001z', hex: null, unsigned: null, signed: null }],
      ['1 us', { bits: '0', hex: '0x0', unsigned: 0, signed: 0 }, { bits: '0011', hex: '0x3', unsigned: 3, signed: 3 }],
    ]);
  });

  it('extends a short vector value by its leftmost bit, padding 0 and 1 with 0', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 4 ! a $end
$var wire 4 " b $end
$var wire 4 # c $end
$var wire 4 $ d $end
$upscope $end
$enddefinitions $end
#0
b1 !
bx "
bz1 #
B10 $
`;
    const result = await query(text, ['top.a', 'top.b', 'top.c', 'top.d'], ['0']);

    expect(result.values[0]).toMatchObject({
      'top.a': { bits: '0001' }, 'top.b': { bits: 'xxxx' }, 'top.c': { bits: 'zzz1' }, 'top.d': { bits: '0010' },
    });
  });

  it('lower-cases x, z and the other VHDL states, and gives no number for them', async () => {
    const text = `$timescale 1 fs $end
$scope vhdl_architecture tb $end
$var logic 8 ! s_vec[7:0] $end
$var logic 1 " s_bit $end
$upscope $end
$enddefinitions $end
#0
bUXZWLH-1 !
H"
`;
    const result = await query(text, ['tb.s_vec', 'tb.s_bit'], ['0']);

    expect(result.values[0]).toMatchObject({
      'tb.s_vec': { bits: 'uxzwlh-1', hex: null, unsigned: null, signed: null },
      'tb.s_bit': { bits: 'h', hex: null, unsigned: null, signed: null },
    });
  });

  it('gives x-filled values for a time before the first dump', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 4 " data $end
$var real 64 # ratio $end
$var string 0 $ phase $end
$upscope $end
$enddefinitions $end
#5
$dumpvars
1!
b1111 "
r2 #
sidle $
$end
`;
    const result = await query(text, ['top.clk', 'top.data', 'top.ratio', 'top.phase'], ['4 ns', '5 ns']);

    expect(result).toMatchObject({ startTime: '5 ns', endTime: '5 ns' });
    expect(result.values).toEqual([
      {
        time: '4 ns',
        beyond: 'before',
        'top.clk': { bits: 'x', hex: null, unsigned: null, signed: null },
        'top.data': { bits: 'xxxx', hex: null, unsigned: null, signed: null },
        'top.ratio': { real: null },
        'top.phase': { string: null },
      },
      {
        time: '5 ns',
        'top.clk': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
        'top.data': { bits: '1111', hex: '0xf', unsigned: 15, signed: -1 },
        'top.ratio': { real: 2 },
        'top.phase': { string: 'idle' },
      },
    ]);
  });

  it('reports the first and last timestamps and marks a time after the last one', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! done $end
$var wire 4 " count $end
$upscope $end
$enddefinitions $end
#0
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
    const result = await query(text, ['top.done', 'top.count'], ['5 ns', '20 ns', '500 ns']);

    expect(result).toMatchObject({ startTime: '0 ns', endTime: '20 ns' });
    expect(result.values).toEqual([
      {
        time: '5 ns',
        'top.done': { bits: '0', hex: '0x0', unsigned: 0, signed: 0 },
        'top.count': { bits: '0000', hex: '0x0', unsigned: 0, signed: 0 },
      },
      {
        time: '20 ns',
        'top.done': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
        'top.count': { bits: '1010', hex: '0xa', unsigned: 10, signed: -6 },
      },
      {
        time: '500 ns',
        beyond: 'after',
        'top.done': { bits: '1', hex: '0x1', unsigned: 1, signed: -1 },
        'top.count': { bits: '1010', hex: '0xa', unsigned: 10, signed: -6 },
      },
    ]);
  });

  it('marks a time between the last tick and the next one as after the end', async () => {
    const coarse = `$timescale 10 ns $end
$scope module top $end
$var wire 1 ! v $end
$upscope $end
$enddefinitions $end
#0
0!
#3
1!
`;
    const result = await query(coarse, ['top.v'], ['30 ns', '0.03 us', '35 ns', '3', '3.5']);

    expect(result.endTime).toBe('30 ns');
    expect(result.values.map((row) => row.beyond)).toEqual([undefined, undefined, 'after', undefined, 'after']);
  });

  it('gives the first and last timestamps in the largest unit that keeps them at least 1', async () => {
    const dump = (timescale: string, times: number[]) => `$timescale ${timescale} $end
$scope module top $end
$var wire 1 ! v $end
$upscope $end
$enddefinitions $end
${times.map((time) => `#${time}\n0!`).join('\n')}
`;
    const range = async (timescale: string, times: number[]) => {
      const { startTime, endTime } = await query(dump(timescale, times), ['top.v'], ['0']);
      return [startTime, endTime];
    };

    expect(await range('1 fs', [0, 40000000])).toEqual(['0 fs', '40 ns']);
    expect(await range('1 ps', [999, 1500000])).toEqual(['999 ps', '1.5 us']);
    expect(await range('100 ps', [15, 123456789])).toEqual(['1.5 ns', '12.3456789 ms']);
    expect(await range('10 ns', [0, 3])).toEqual(['0 ns', '30 ns']);
    expect(await range('100 s', [1, 25])).toEqual(['100 s', '2500 s']);
  });

  it('gives the first and last timestamps as bare numbers when the file has no timescale', async () => {
    const result = await query(basic.replace('$timescale 1 ns $end\n', ''), ['top.clk'], ['15', '31']);

    expect(result).toMatchObject({ timescale: null, startTime: '0', endTime: '30' });
    expect(result.values.map((row) => row.beyond)).toEqual([undefined, 'after']);
  });

  it('reads to the end of the file for the last timestamp after every time is answered', async () => {
    const result = await query(basic, ['top.clk'], ['0']);

    expect(result).toMatchObject({ startTime: '0 ns', endTime: '30 ns' });
    await expect(query(`${basic}#40\nq!\n`, ['top.clk'], ['0'])).rejects.toThrow('Cannot read VCD value change "q!" at #40');
  });

  it('rejects a file with no timestamp after its definitions', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! clk $end
$upscope $end
$enddefinitions $end
`;

    await expect(query(text, ['top.clk'], ['0'])).rejects.toThrow('The VCD file has no timestamp after $enddefinitions');
  });

  it('matches nested names with . or / separators, ignoring case', async () => {
    const result = await query(basic, ['TOP/Core/ACC', '/top/core/clk', 'top.CORE.acc'], ['30 ns']);

    expect(result.signals).toEqual([
      { name: 'top.core.acc', width: 4, type: 'reg' },
      { name: 'top.core.clk', width: 1, type: 'wire' },
    ]);
    expect(result.values[0]).toMatchObject({ 'top.core.acc': { bits: '0011' }, 'top.core.clk': { bits: '0' } });
  });

  it('matches a name declared with its bit range, with or without the range', async () => {
    const text = `$timescale 1 fs $end
$scope vhdl_architecture tb $end
$var logic 4 ! s_a[3:0] $end
$upscope $end
$enddefinitions $end
#0
b0011 !
`;
    const result = await query(text, ['tb.s_a', 'tb.s_a[3:0]'], ['0']);

    expect(result.signals).toEqual([{ name: 'tb.s_a', width: 4, type: 'logic' }]);
    expect(result.values[0]).toMatchObject({ 'tb.s_a': { hex: '0x3' } });
  });

  it('prefers the exact case when names differ only in case, and rejects an ambiguous one', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 1 " CLK $end
$upscope $end
$enddefinitions $end
#0
0!
1"
`;
    const result = await query(text, ['top.CLK'], ['0']);
    expect(result.values[0]).toMatchObject({ 'top.CLK': { bits: '1' } });

    await expect(query(text, ['top.Clk'], ['0'])).rejects.toThrow('Signal top.Clk is ambiguous: top.clk, top.CLK');
  });

  it('lists signals sharing the last name when a signal is unknown', async () => {
    const scopes = Array.from({ length: 25 }, (_, index) =>
      `$scope module u${index} $end\n$var wire 1 ${String.fromCharCode(34 + index)} acc $end\n$upscope $end`).join('\n');
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 1 ! data $end
${scopes}
$upscope $end
$enddefinitions $end
#0
`;
    const error = await query(text, ['top.acc'], ['0']).then(() => undefined, (caught: unknown) => caught as Error);

    expect(error?.message).toMatch(/^Unknown signal top\.acc\. Signals named acc \(20 of 25\): top\.u0\.acc, top\.u1\.acc, /);
    expect(error?.message).toContain('top.u19.acc');
    expect(error?.message).not.toContain('top.u20.acc');
    expect(error?.message).not.toContain('top.data');
  });

  it('lists the available signals when none shares the last name', async () => {
    await expect(query(basic, ['top.dat'], ['0'])).rejects.toThrow(
      'Unknown signal top.dat. No signal is named dat; signals in the file (6): top.clk, top.data, top.ratio, top.phase, top.core.acc, top.core.clk',
    );
  });

  it('converts ns, us and ps times with the file timescale', async () => {
    const picoseconds = `$timescale 1ps $end
$scope module top $end
$var wire 2 ! v $end
$upscope $end
$enddefinitions $end
#0
b00 !
#1000
b01 !
#1500000
b10 !
`;
    const fine = await query(picoseconds, ['top.v'], ['999 ps', '1 ns', '1.4999 us', '1.5 us', '1500000']);
    expect(fine.timescale).toBe('1 ps');
    expect(fine.values.map((row) => (row['top.v'] as { bits: string }).bits)).toEqual(['00', '01', '01', '10', '10']);

    const coarse = `$timescale
  10 ns
$end
$scope module top $end
$var wire 1 ! v $end
$upscope $end
$enddefinitions $end
#0
0!
#3
1!
`;
    const tens = await query(coarse, ['top.v'], ['29 ns', '30 ns', '2', '3', '0.03 us', '30000 ps']);
    expect(tens.timescale).toBe('10 ns');
    expect(tens.values.map((row) => (row['top.v'] as { bits: string }).bits)).toEqual(['0', '1', '0', '1', '1', '1']);
  });

  it('rejects a time it cannot read', async () => {
    await expect(query(basic, ['top.clk'], ['20 nanoseconds'])).rejects.toThrow(
      'Cannot read time "20 nanoseconds"; use a number with an optional unit (fs, ps, ns, us, ms, s), such as "20 ns"',
    );
    await expect(query(basic, ['top.clk'], ['-5 ns'])).rejects.toThrow('Cannot read time "-5 ns"');
  });

  it('gives numbers beyond 2^53 as decimal strings', async () => {
    const text = `$timescale 1 ns $end
$scope module top $end
$var wire 64 ! wide $end
$upscope $end
$enddefinitions $end
#0
b${'1'.repeat(64)} !
`;
    const result = await query(text, ['top.wide'], ['0']);

    expect(result.values[0]?.['top.wide']).toEqual({
      bits: '1'.repeat(64), hex: '0xffffffffffffffff', unsigned: '18446744073709551615', signed: -1,
    });
  });

  it('reads the same values when the text arrives in small chunks', async () => {
    const signals = ['top.clk', 'top.data', 'top.ratio', 'top.phase', 'top.core.acc'];
    const times = ['0', '15 ns', '20 ns', '1 us'];
    const chunks: string[] = [];
    for (let offset = 0, size = 1; offset < basic.length; offset += size, size = (size % 7) + 1) {
      chunks.push(basic.slice(offset, offset + size));
    }

    expect(await queryVcd(chunks, { signals, times })).toEqual(await query(basic, signals, times));
  });

  it('rejects text that is not VCD', async () => {
    await expect(query('hello world\n', ['top.clk'], ['0'])).rejects.toThrow('Not a VCD file: unexpected "hello" in the header');
  });

  it('rejects a time that goes backwards', async () => {
    await expect(query(`${basic}#25\n1!\n`, ['top.clk'], ['1 us'])).rejects.toThrow('VCD time goes backwards: #25 after #30');
  });

  it('rejects a value change it cannot read', async () => {
    await expect(query(`${basic}#40\nq!\n`, ['top.clk'], ['1 us'])).rejects.toThrow('Cannot read VCD value change "q!" at #40');
  });

  it('rejects a time with a unit when the file has no timescale', async () => {
    const text = basic.replace('$timescale 1 ns $end\n', '');

    await expect(query(text, ['top.clk'], ['15'])).resolves.toMatchObject({ timescale: null });
    await expect(query(text, ['top.clk'], ['15 ns'])).rejects.toThrow(
      'The VCD file has no $timescale, so "15 ns" needs to be a bare number of time units',
    );
  });
});
