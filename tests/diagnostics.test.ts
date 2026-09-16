import { describe, expect, it } from 'vitest';

import { parseDiagnostics } from '../src/rars/diagnostics.js';

describe('parseDiagnostics', () => {
  it('parses a RARS source diagnostic', () => {
    expect(
      parseDiagnostics(
        'Error in /workspace/invalid.asm line 3 column 3: Invalid language element: definitely_not\n',
      ),
    ).toEqual([
      {
        severity: 'error',
        file: '/workspace/invalid.asm',
        line: 3,
        column: 3,
        message: 'Invalid language element: definitely_not',
      },
    ]);
  });
});
