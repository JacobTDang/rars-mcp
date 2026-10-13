export type RarsErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'PATH_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_IS_SYMLINK'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'BRIDGE_START_TIMEOUT'
  | 'BRIDGE_START_FAILED';

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
