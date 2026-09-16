export type SessionId = string;
export type SessionKind = 'headless' | 'live';
export type SessionState = 'ready' | 'running' | 'paused' | 'terminated' | 'error';

export interface SessionSummary {
  id?: SessionId;
  kind: SessionKind;
  state: SessionState;
  name?: string;
}

export interface MachineState {
  status: SessionState;
  programCounter?: string;
  registers?: Readonly<Record<string, string>>;
  output?: string;
}

export type DebugCommand =
  | { action: 'step' | 'backstep' | 'continue' | 'pause' | 'reset' | 'terminate' }
  | { action: 'breakpoint_add' | 'breakpoint_remove'; address: string };

export interface InspectRequest {
  registers?: string[];
  memory?: ReadonlyArray<{ address: string; length: number }>;
  includeSymbols?: boolean;
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
