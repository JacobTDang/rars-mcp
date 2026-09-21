export type SessionId = string;
export type SessionKind = 'headless' | 'live';
export type SessionState = 'ready' | 'running' | 'paused' | 'terminated' | 'error';

export interface SessionSummary {
  id?: SessionId;
  kind: SessionKind;
  state: SessionState;
  name?: string;
}

export interface Word {
  hex: string;
  signed: number;
}

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

export interface InspectRequest {
  registers?: string[];
  memory?: ReadonlyArray<{ address: string; length: number }>;
  includeSymbols?: boolean;
  includeInstructions?: boolean;
}

export interface ModifyRequest {
  registers?: Readonly<Record<string, string>>;
  memory?: ReadonlyArray<{ address: string; value: string; width: 1 | 2 | 4 | 8 }>;
}

export interface SessionBackend {
  summary(): Promise<SessionSummary>;
  command(command: DebugCommand): Promise<MachineState>;
  inspect(request: InspectRequest): Promise<unknown>;
  modify(request: ModifyRequest): Promise<MachineState>;
  close(): Promise<void>;
}
