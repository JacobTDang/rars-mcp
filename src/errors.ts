export type RarsErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'PATH_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_PROJECT'
  | 'PROVIDER_UNAVAILABLE'
  | 'WORKER_UNAVAILABLE'
  | 'JOB_NOT_FOUND'
  | 'JOB_STATE_CONFLICT'
  | 'ARTIFACT_LIMIT_EXCEEDED'
  | 'WORKER_PROTOCOL_MISMATCH'
  | 'ARTIFACT_CORRUPT';

export class RarsError extends Error {
  readonly code: RarsErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RarsErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'RarsError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
