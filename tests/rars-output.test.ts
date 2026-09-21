import { describe, expect, it } from 'vitest';

import { extractDumps, extractInstructionCount } from '../src/rars/output.js';

// Captured from RARS 1.6 runs with the ic option.
const stepLimit = '\nProgram terminated when maximum step limit 50 reached.\n\n50\nt0\t0x00000000\n';
const assemblyFailure = 'Error in /w/invalid.asm line 3 column 3: "x" is not a recognized operator\n\nProcessing terminated due to errors.\n';

describe('extractInstructionCount', () => {
  it('reads the count above the register dump and removes it from stderr', () => {
    expect(extractInstructionCount(stepLimit)).toEqual({
      instructionCount: 50,
      stderr: '\nProgram terminated when maximum step limit 50 reached.\n\nt0\t0x00000000\n',
    });
  });

  it('returns no count when assembly failed and the program never ran', () => {
    expect(extractInstructionCount(assemblyFailure)).toEqual({ stderr: assemblyFailure });
  });

  it('fails when a program ran but RARS printed no count', () => {
    expect(() => extractInstructionCount('\nProgram terminated by calling exit\n')).toThrow(
      'RARS did not report an instruction count',
    );
  });
});

// Captured from a RARS 1.6 run with ic, two registers and one memory range.
const dumped = '\nProgram terminated by calling exit\n\n5\nt0\t0xfffff000\na7\t0x0000000a\n'
  + 'Mem[0x10010000]\t0x6c6c6568\t0x7266206f\t0x72206d6f\t0x0a737261\t\nMem[0x10010010]\t0x00000000\t\n';

describe('extractDumps', () => {
  it('parses register and memory dumps and removes them from stderr', () => {
    expect(extractDumps(dumped)).toEqual({
      registers: {
        t0: { hex: '0xfffff000', signed: -4096 },
        a7: { hex: '0x0000000a', signed: 10 },
      },
      memory: [
        { address: '0x10010000', hex: '0x6c6c6568', signed: 1819043176 },
        { address: '0x10010004', hex: '0x7266206f', signed: 1919295599 },
        { address: '0x10010008', hex: '0x72206d6f', signed: 1914727791 },
        { address: '0x1001000c', hex: '0x0a737261', signed: 175338081 },
        { address: '0x10010010', hex: '0x00000000', signed: 0 },
      ],
      stderr: '\nProgram terminated by calling exit\n\n5\n',
    });
  });
});
