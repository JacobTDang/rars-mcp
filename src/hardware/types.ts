export interface HardwareLimits {
  concurrency: number;
  wallTimeSeconds: number;
  memoryMb: number;
  pids: number;
  outputBytes: number;
  artifactMb: number;
  sourceFiles: number;
  sourceBytes: number;
}

export interface HardwareConfig {
  enabled: boolean;
  workerUrl: string;
  workerToken?: string;
  stateDir: string;
  allowRepositoryCommands: boolean;
  limits: HardwareLimits;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'aborted';
export type TerminalJobState = Exclude<JobState, 'queued' | 'running'>;

export interface HardwareDiagnostic {
  severity: 'info' | 'warning' | 'error';
  provider: string;
  phase: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  original?: string;
}

export interface ArtifactRecord {
  id: string;
  jobId: string;
  type: string;
  path: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  retention: 'active' | 'expired';
}

export interface ProviderCapability {
  id: string;
  version: string;
  available: boolean;
  unavailableReason?: string;
  actions: string[];
  languages: string[];
  standards: string[];
  artifactFormats: string[];
}

export interface ResolvedTarget {
  name: string;
  provider: string;
  action: string;
  language?: string;
  standard?: string;
  top?: string;
  sources: string[];
  parameters: Record<string, string | number | boolean>;
  defines: string[];
  includeDirs: string[];
  options: Record<string, unknown>;
  artifacts: Record<string, string>;
  command?: string[];
  effectiveLimits: HardwareLimits;
}

export interface ResolvedProject {
  version: 1;
  name: string;
  root: string;
  manifestPath: string;
  sourceBytes: number;
  targets: Record<string, ResolvedTarget>;
}

export interface HardwareResult {
  success: boolean;
  summary: string;
  diagnostics: HardwareDiagnostic[];
  artifacts: ArtifactRecord[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason?: 'exit' | 'timeout' | 'cancelled' | 'output_limit' | 'artifact_limit' | 'aborted';
  reproducibility?: Record<string, unknown>;
}

export interface HardwareJobRequest {
  manifestPath: string;
  target: string;
  parentJobId?: string;
}

export interface HardwareJob {
  id: string;
  state: JobState;
  request: HardwareJobRequest;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: HardwareResult;
  cancellationRequested?: boolean;
}

export interface SourceSnapshotFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SourceSnapshot {
  id: string;
  root: string;
  sha256: string;
  files: SourceSnapshotFile[];
  createdAt: string;
}

export interface ProviderCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  limits: HardwareLimits;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  executable: string;
  args: string[];
}

export interface ProviderContext {
  target: ResolvedTarget;
  snapshotRoot: string;
  buildRoot: string;
  artifactRoot: string;
}
