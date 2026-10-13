// Register lines ("t0\t0x0000000a") and memory lines ("Mem[0x10010000]\t0x...") that RARS prints last.
const DUMP_LINE = /^(\S+\t0x[0-9a-f]+|Mem\[0x[0-9a-f]+\](\t0x[0-9a-f]+)*\t?)$/i;
const REGISTER_LINE = /^(\S+)\t(0x[0-9a-f]+)$/i;
const MEMORY_LINE = /^Mem\[(0x[0-9a-f]+)\]((?:\t0x[0-9a-f]+)*)\t?$/i;
// What RARS prints for each memory-image dump it could not write, after the register and memory dumps.
const DUMP_FILE_ERROR = /^(?:Error while attempting to save dump, .*|This segment has not been written to, there is nothing to dump\.)$/;

// The index just past the last register or memory dump line.
function dumpLinesEnd(lines: string[]): number {
  let end = lines.length;
  if (lines[end - 1] === '') end--;
  while (end > 0 && DUMP_FILE_ERROR.test(lines[end - 1]!)) end--;
  return end;
}

export interface Word {
  hex: string;
  signed: number;
}

export interface MemoryWord extends Word {
  address: string;
}

function word(hex: string): Word {
  return { hex, signed: Number.parseInt(hex, 16) | 0 };
}

// RARS prints this instead of running the program when assembly fails.
const ASSEMBLY_FAILED = 'Processing terminated due to errors.';

// RARS prints one of these, and runs nothing, for a command line argument it does not take.
const REJECTED_ARGUMENT = /^(?:Invalid Command Argument|Invalid\/unaligned address or invalid range): /m;

export function argumentRejected(stderr: string): boolean {
  return REJECTED_ARGUMENT.test(stderr);
}

// With the ic option, RARS prints the count on its own line just above any register or memory dump.
export function extractInstructionCount(stderr: string): { instructionCount?: number; stderr: string } {
  if (stderr.includes(ASSEMBLY_FAILED)) return { stderr };
  const lines = stderr.split('\n');
  let index = dumpLinesEnd(lines) - 1;
  while (index >= 0 && DUMP_LINE.test(lines[index]!)) index--;
  if (index < 0 || !/^\d+$/.test(lines[index]!)) throw new Error('RARS did not report an instruction count');
  const instructionCount = Number(lines[index]);
  lines.splice(index, 1);
  return { instructionCount, stderr: lines.join('\n') };
}

// Parses the register and memory dumps RARS prints at the end of stderr, and removes them from it.
export function extractDumps(stderr: string): { registers: Record<string, Word>; memory: MemoryWord[]; stderr: string } {
  const lines = stderr.split('\n');
  const end = dumpLinesEnd(lines);
  let start = end;
  while (start > 0 && DUMP_LINE.test(lines[start - 1]!)) start--;

  const registers: Record<string, Word> = {};
  const memory: MemoryWord[] = [];
  for (const line of lines.slice(start, end)) {
    const register = line.match(REGISTER_LINE);
    if (register) {
      registers[register[1]!] = word(register[2]!);
      continue;
    }
    const [, base, words] = line.match(MEMORY_LINE)!;
    words!.split('\t').filter(Boolean).forEach((hex, index) => {
      const address = (Number.parseInt(base!, 16) + index * 4) >>> 0;
      memory.push({ address: `0x${address.toString(16).padStart(8, '0')}`, ...word(hex) });
    });
  }
  lines.splice(start, end - start);
  return { registers, memory, stderr: lines.join('\n') };
}
