export type SessionId = string;
export type SessionKind = 'headless' | 'live';
export type SessionState = 'ready' | 'running' | 'paused' | 'terminated' | 'error';

export interface SessionSummary {
  id?: SessionId;
  kind: SessionKind;
  state: SessionState;
  name?: string;
}

// A register, or memory 1, 2 or 4 bytes wide.
export interface Word {
  hex: string;
  signed: number;
}

// Memory as inspect reads it; hex is the exact bit pattern. A JSON number cannot hold every
// 64-bit value, so for 8 bytes signed is a decimal string.
export type MemoryValue =
  | { address: string; width: 1 | 2 | 4; hex: string; signed: number }
  | { address: string; width: 8; hex: string; signed: string };

export type StopReason = 'step' | 'breakpoint' | 'step_limit' | 'exited' | 'ran_off_end' | 'exception' | 'backstep' | 'terminated';

export interface MachineState {
  status: SessionState;
  stopReason?: StopReason;
  exception?: string;
  programCounter?: string;
  registers?: Readonly<Record<string, Word>>;
  output?: string;
}

export type DebugCommand =
  | { action: 'step' | 'backstep' | 'pause' | 'reset' | 'terminate' }
  | { action: 'continue'; maxSteps?: number }
  | { action: 'breakpoint_add' | 'breakpoint_remove'; address: string };

// count instructions centred on around (the program counter by default), or every instruction
// from one location to another. A location is pc, a code label, an address, or file:line.
export type InstructionWindow = { around?: string; count?: number } | { from: string; to: string };

export interface InspectRequest {
  registers?: string[];
  memory?: ReadonlyArray<{ address: string; length: number }>;
  includeSymbols?: boolean;
  includeInstructions?: boolean;
  instructions?: InstructionWindow;
}

// The machine state with the registers, memory, symbols and instructions inspect was asked for.
export interface InspectResult extends MachineState {
  memory?: readonly MemoryValue[];
  symbols?: unknown[];
  instructions?: unknown[];
}

export interface ModifyRequest {
  registers?: Readonly<Record<string, string>>;
  memory?: ReadonlyArray<{ address: string; value: string; width: 1 | 2 | 4 | 8 }>;
}

// One instruction word with its fields as numbers; imm is put back together from the pieces S, B and J split it into.
export interface EncodedWord {
  hex: string;
  format: 'R' | 'R4' | 'I' | 'S' | 'B' | 'U' | 'J';
  fields: Readonly<Record<string, number>>;
}

// An instruction's basic forms and words, one of each per basic instruction it expands to, or why RARS refused it.
export type EncodedInstruction =
  | { source: string; basic: string[]; words: EncodedWord[] }
  | { source: string; error: string };

export interface SessionBackend {
  summary(): Promise<SessionSummary>;
  command(command: DebugCommand): Promise<MachineState>;
  inspect(request: InspectRequest): Promise<InspectResult>;
  modify(request: ModifyRequest): Promise<MachineState>;
  close(): Promise<void>;
}
