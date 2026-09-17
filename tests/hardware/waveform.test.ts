import { describe, expect, it } from 'vitest';

import { parseVcd, queryWave } from '../../src/hardware/waveform.js';

const fixture = `$timescale 1 ns $end
$scope module cpu $end
$var wire 1 ! clk $end
$var wire 4 " data $end
$upscope $end
$enddefinitions $end
#0
0!
b0000 "
#5
1!
b10xz "
#10
0!
b0011 "
`;

describe('bounded waveform queries', () => {
  const index = parseVcd(fixture);
  it('indexes hierarchy, widths, timescale, and four-state transitions', () => {
    expect(index).toMatchObject({ timescale: '1ns', endTime: 10, scopes: ['cpu'] });
    const data = index.signals.find((item) => item.path === 'cpu.data');
    expect(data?.width).toBe(4);
    expect(data?.transitions).toEqual(expect.arrayContaining([{ time: 0, value: '0000' }, { time: 5, value: '10xz' }]));
  });
  it('bounds transition pages and locates unknowns and values', () => {
    expect(queryWave(index, { operation: 'transitions', signal: 'cpu.clk', limit: 2 })).toMatchObject({ items: [{ time: 0 }, { time: 5 }], nextCursor: 2 });
    expect(queryWave(index, { operation: 'value_at', signal: 'data', startTime: 7 })).toMatchObject({ value: '10xz' });
    expect(queryWave(index, { operation: 'first_unknown', signal: 'data' })).toMatchObject({ transition: { time: 5, value: '10xz' } });
  });

  it('bounds encoded page bytes and preserves an exact continuation cursor', () => {
    const first = queryWave(index, { operation: 'transitions', signal: 'cpu.clk', limit: 100, maxResponseBytes: 92 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(92);
    expect(first).toMatchObject({ items: [{ time: 0, value: '0' }], nextCursor: 1, truncatedByBytes: true });
    const second = queryWave(index, { operation: 'transitions', signal: 'cpu.clk', limit: 100, cursor: 1, maxResponseBytes: 92 });
    expect(second).toMatchObject({ items: [{ time: 5, value: '1' }], nextCursor: 2 });
  });
});
