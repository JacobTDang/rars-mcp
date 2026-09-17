export function generateRiscvProgram(seed: number, instructionCount: number): string {
  let state = seed >>> 0 || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const lines = ['.text', '.globl _start', '_start:'];
  for (let i = 0; i < instructionCount; i++) {
    const op = next() % 4; const rd = 1 + next() % 15; const rs1 = next() % 16; const rs2 = next() % 16; const immediate = (next() % 4096) - 2048;
    lines.push(op === 0 ? `  addi x${rd}, x${rs1}, ${immediate}` : op === 1 ? `  add x${rd}, x${rs1}, x${rs2}` : op === 2 ? `  sub x${rd}, x${rs1}, x${rs2}` : `  xor x${rd}, x${rs1}, x${rs2}`);
  }
  lines.push('  li a7, 10', '  ecall', ''); return lines.join('\n');
}

export async function minimizeFailingLines(lines: string[], stillFails: (candidate: string[]) => Promise<boolean>): Promise<string[]> {
  let current = [...lines]; let granularity = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / granularity); let reduced = false;
    for (let start = 0; start < current.length; start += chunk) { const candidate = [...current.slice(0, start), ...current.slice(start + chunk)]; if (candidate.length && await stillFails(candidate)) { current = candidate; granularity = Math.max(2, granularity - 1); reduced = true; break; } }
    if (!reduced) { if (granularity >= current.length) break; granularity = Math.min(current.length, granularity * 2); }
  }
  return current;
}
