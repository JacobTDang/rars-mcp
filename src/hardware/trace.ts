import { readFile } from 'node:fs/promises';

import { RarsError } from '../errors.js';

export interface ArchitecturalEvent {
  retireOrder: number; cycle?: number; lane?: number; valid: boolean;
  instructionBits: string; instructionWidth: number; pcBefore: string; pcAfter: string;
  sourceRegisters?: Array<{ address: number; value: string }>;
  destinationRegister?: { address: number; value: string };
  memory?: { address: string; readMask?: string; writeMask?: string; readData?: string; writeData?: string };
  trap?: boolean; interrupt?: boolean; halt?: boolean; privilege?: string; symbol?: string; source?: string;
  original?: unknown;
}

export type TraceFormat = 'normalized' | 'rvfi' | 'rars';
export interface TracePolicy { compareRegisters?: boolean; compareMemory?: boolean; compareTraps?: boolean; comparePrivilege?: boolean; ignoreX0Writes?: boolean }

export async function loadTrace(path: string, format: TraceFormat): Promise<ArchitecturalEvent[]> {
  const text = await readFile(path, 'utf8'); const events: ArchitecturalEvent[] = [];
  for (const [lineNumber, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { const raw = JSON.parse(line) as Record<string, unknown>; events.push(normalizeEvent(raw, format, events.length)); }
    catch (error) { throw new RarsError('ARTIFACT_CORRUPT', `Invalid ${format} trace record at line ${lineNumber + 1}`, { cause: error instanceof Error ? error.message : String(error) }); }
  }
  return events.filter((event) => event.valid).sort((a, b) => a.retireOrder - b.retireOrder);
}

export function normalizeEvent(raw: Record<string, unknown>, format: TraceFormat, fallbackOrder = 0): ArchitecturalEvent {
  if (format === 'normalized') return raw as unknown as ArchitecturalEvent;
  const rvfi = format === 'rvfi';
  const value = (rvfiName: string, rarsName: string, fallback: unknown = undefined) => raw[rvfi ? rvfiName : rarsName] ?? fallback;
  const destinationAddress = Number(value('rvfi_rd_addr', 'rd', 0));
  const event: ArchitecturalEvent = {
    retireOrder: Number(value('rvfi_order', 'order', fallbackOrder)),
    ...(optionalNumber(value('cycle', 'cycle')) === undefined ? {} : { cycle: optionalNumber(value('cycle', 'cycle')) as number }),
    ...(optionalNumber(value('lane', 'lane')) === undefined ? {} : { lane: optionalNumber(value('lane', 'lane')) as number }),
    valid: Boolean(value('rvfi_valid', 'valid', true)), instructionBits: hex(value('rvfi_insn', 'instruction', '0')), instructionWidth: Number(value('instruction_width', 'instructionWidth', 32)),
    pcBefore: hex(value('rvfi_pc_rdata', 'pc')), pcAfter: hex(value('rvfi_pc_wdata', 'nextPc')),
    trap: Boolean(value('rvfi_trap', 'trap', false)), interrupt: Boolean(value('rvfi_intr', 'interrupt', false)), halt: Boolean(value('rvfi_halt', 'halt', false)),
    ...(value('rvfi_mode', 'privilege') === undefined ? {} : { privilege: String(value('rvfi_mode', 'privilege')) }), original: raw,
  };
  if (destinationAddress !== 0 || value('rvfi_rd_wdata', 'rdValue') !== undefined) event.destinationRegister = { address: destinationAddress, value: hex(value('rvfi_rd_wdata', 'rdValue', 0)) };
  const memoryAddress = value('rvfi_mem_addr', 'memoryAddress');
  if (memoryAddress !== undefined) event.memory = { address: hex(memoryAddress), readMask: hex(value('rvfi_mem_rmask', 'readMask', 0)), writeMask: hex(value('rvfi_mem_wmask', 'writeMask', 0)), readData: hex(value('rvfi_mem_rdata', 'readData', 0)), writeData: hex(value('rvfi_mem_wdata', 'writeData', 0)) };
  return event;
}

export function compareTraces(left: ArchitecturalEvent[], right: ArchitecturalEvent[], policy: TracePolicy = {}, context = 3): Record<string, unknown> {
  const effective = { compareRegisters: true, compareMemory: true, compareTraps: true, comparePrivilege: false, ignoreX0Writes: true, ...policy };
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const a = left[i]; const b = right[i]; const fields: string[] = [];
    if (!a || !b) fields.push('trace_length');
    else {
      if (a.instructionBits !== b.instructionBits) fields.push('instructionBits');
      if (a.pcBefore !== b.pcBefore) fields.push('pcBefore'); if (a.pcAfter !== b.pcAfter) fields.push('pcAfter');
      if (effective.compareRegisters && JSON.stringify(normalizeDestination(a, effective.ignoreX0Writes)) !== JSON.stringify(normalizeDestination(b, effective.ignoreX0Writes))) fields.push('destinationRegister');
      if (effective.compareMemory && JSON.stringify(a.memory ?? null) !== JSON.stringify(b.memory ?? null)) fields.push('memory');
      if (effective.compareTraps && (a.trap !== b.trap || a.interrupt !== b.interrupt || a.halt !== b.halt)) fields.push('trap');
      if (effective.comparePrivilege && a.privilege !== b.privilege) fields.push('privilege');
    }
    if (fields.length) return { equal: false, index: i, retireOrder: a?.retireOrder ?? b?.retireOrder, fields, left: a ?? null, right: b ?? null, before: { left: left.slice(Math.max(0, i - context), i), right: right.slice(Math.max(0, i - context), i) }, after: { left: left.slice(i + 1, i + 1 + context), right: right.slice(i + 1, i + 1 + context) }, waveformHint: { leftCycle: a?.cycle ?? null, rightCycle: b?.cycle ?? null } };
  }
  return { equal: true, comparedEvents: count };
}

function normalizeDestination(event: ArchitecturalEvent, ignoreX0: boolean): unknown { return ignoreX0 && event.destinationRegister?.address === 0 ? null : event.destinationRegister ?? null; }
function optionalNumber(value: unknown): number | undefined { return value === undefined ? undefined : Number(value); }
function hex(value: unknown): string { if (typeof value === 'string') return value.toLowerCase().startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`; if (typeof value === 'bigint') return `0x${value.toString(16)}`; return `0x${Number(value ?? 0).toString(16)}`; }
