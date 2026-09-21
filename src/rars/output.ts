// Register lines ("t0\t0x0000000a") and memory lines ("Mem[0x10010000]\t0x...") that RARS prints last.
const DUMP_LINE = /^(\S+\t0x[0-9a-f]+|Mem\[0x[0-9a-f]+\](\t0x[0-9a-f]+)*\t?)$/i;
const REGISTER_LINE = /^(\S+)\t(0x[0-9a-f]+)$/i;
const MEMORY_LINE = /^Mem\[(0x[0-9a-f]+)\]((?:\t0x[0-9a-f]+)*)\t?$/i;

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

// Parses the register and memory dumps RARS prints at the end of stderr, and removes them from it.
export function extractDumps(stderr: string): { registers: Record<string, Word>; memory: MemoryWord[]; stderr: string } {
  const lines = stderr.split('\n');
  let end = lines.length;
  if (lines[end - 1] === '') end--;
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
