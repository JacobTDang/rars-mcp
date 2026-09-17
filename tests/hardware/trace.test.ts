import { describe, expect, it } from 'vitest';
import { compareTraces, normalizeEvent } from '../../src/hardware/trace.js';

describe('processor retirement traces', () => {
  it('normalizes RVFI and RARS records into the ISA-neutral event model', () => {
    const rvfi = normalizeEvent({ rvfi_valid: 1, rvfi_order: 4, cycle: 9, rvfi_insn: '00100093', rvfi_pc_rdata: '1000', rvfi_pc_wdata: '1004', rvfi_rd_addr: 1, rvfi_rd_wdata: 1 }, 'rvfi');
    const rars = normalizeEvent({ order: 4, instruction: '00100093', pc: '1000', nextPc: '1004', rd: 1, rdValue: 1 }, 'rars');
    expect(rvfi).toMatchObject({ retireOrder: 4, cycle: 9, instructionBits: '0x00100093', destinationRegister: { address: 1, value: '0x1' } });
    expect(rars.pcAfter).toBe('0x1004');
  });
  it('returns the first architectural divergence and waveform cycle hint', () => {
    const common = { retireOrder: 0, valid: true, instructionBits: '0x13', instructionWidth: 32, pcBefore: '0x0', pcAfter: '0x4' };
    const result = compareTraces([{ ...common, cycle: 7, destinationRegister: { address: 1, value: '0x1' } }], [{ ...common, cycle: 12, destinationRegister: { address: 1, value: '0x2' } }]);
    expect(result).toMatchObject({ equal: false, index: 0, fields: ['destinationRegister'], waveformHint: { leftCycle: 7, rightCycle: 12 } });
  });
});
