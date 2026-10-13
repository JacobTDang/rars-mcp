export type VhdlStandard = '93' | '02' | '08' | '19';

export interface VhdlDiagnostic {
  severity: 'error' | 'warning' | 'note';
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

// A report or assertion raised while the simulation runs. fatal is the simulator's own
// runtime error, such as an index out of range.
export interface VhdlMessage {
  time: string;
  severity: 'note' | 'warning' | 'error' | 'failure' | 'fatal';
  text: string;
  source?: { file: string; line: number; column: number };
}

export interface VhdlWave {
  file: string;
  format: 'vcd' | 'fst';
}

// File paths are absolute and already checked against the workspace.
export interface VhdlCompileRequest {
  files: string[];
  std: VhdlStandard;
  work: string;
}

export interface VhdlRunRequest extends VhdlCompileRequest {
  testbench: string;
  stopTime?: string;
  generics?: Record<string, string>;
  wave?: VhdlWave;
}

// Shared by every process one request starts.
export interface VhdlLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface VhdlCompileResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostics: VhdlDiagnostic[];
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface VhdlRunResult extends VhdlCompileResult {
  messages: VhdlMessage[];
}

// One implementation per simulator; nvc is the only one so far.
export interface VhdlSimulator {
  readonly name: string;
  // As configured, so it may be a bare name looked up on PATH.
  readonly executable: string;
  version(limits: VhdlLimits): Promise<string>;
  compile(request: VhdlCompileRequest, limits: VhdlLimits): Promise<VhdlCompileResult>;
  run(request: VhdlRunRequest, limits: VhdlLimits): Promise<VhdlRunResult>;
}
