// Register lines ("t0\t0x0000000a") and memory lines ("Mem[0x10010000]\t0x...") that RARS prints last.
const DUMP_LINE = /^(\S+\t0x[0-9a-f]+|Mem\[0x[0-9a-f]+\](\t0x[0-9a-f]+)*\t?)$/i;
// RARS prints this instead of running the program when assembly fails.
const ASSEMBLY_FAILED = 'Processing terminated due to errors.';

// With the ic option, RARS prints the count on its own line just above any register or memory dump.
export function extractInstructionCount(stderr: string): { instructionCount?: number; stderr: string } {
  if (stderr.includes(ASSEMBLY_FAILED)) return { stderr };
  const lines = stderr.split('\n');
  let index = lines.length - 1;
  if (lines[index] === '') index--;
  while (index >= 0 && DUMP_LINE.test(lines[index]!)) index--;
  if (index < 0 || !/^\d+$/.test(lines[index]!)) throw new Error('RARS did not report an instruction count');
  const instructionCount = Number(lines[index]);
  lines.splice(index, 1);
  return { instructionCount, stderr: lines.join('\n') };
}
