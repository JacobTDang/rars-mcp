import { describe, expect, it } from 'vitest';

import { extractInstructionCount } from '../src/rars/output.js';

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
