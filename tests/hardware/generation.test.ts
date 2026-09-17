import { describe, expect, it } from 'vitest';
import { generateRiscvProgram, minimizeFailingLines } from '../../src/hardware/generation.js';

describe('seeded processor test generation', () => {
  it('is deterministic and emits the requested number of body instructions', () => { expect(generateRiscvProgram(42, 5)).toBe(generateRiscvProgram(42, 5)); expect(generateRiscvProgram(42, 5)).not.toBe(generateRiscvProgram(43, 5)); });
  it('delta-minimizes while preserving a failure predicate', async () => { expect(await minimizeFailingLines(['a', 'bug', 'b', 'c'], async (lines) => lines.includes('bug'))).toEqual(['bug']); });
});
