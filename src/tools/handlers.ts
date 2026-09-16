import type { CliResult, RunRarsOptions } from '../rars/cli.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseDiagnostics } from '../rars/diagnostics.js';
import type { SessionStore } from '../sessions/store.js';
import type { Workspace } from '../workspace.js';
import type { AssembleInput, CloseSessionInput, RunInput } from './schemas.js';

export interface ToolDependencies {
  workspace: Workspace;
  sessions: SessionStore;
  run(options: RunRarsOptions): Promise<CliResult>;
  javaExecutable: string;
  rarsJar: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ToolResult = CallToolResult;

export function createToolHandlers(deps: ToolDependencies) {
  const execute = async (input: AssembleInput | RunInput, mode: 'assemble' | 'run'): Promise<ToolResult> => {
    const files = await Promise.all(input.files.map((file) => deps.workspace.resolve(file)));
    const runInput = input as RunInput;
    const result = await deps.run({
      javaExecutable: deps.javaExecutable,
      rarsJar: deps.rarsJar,
      cwd: deps.workspace.root,
      request: {
        mode,
        files,
        ...(runInput.stdin === undefined ? {} : { stdin: runInput.stdin }),
        ...(runInput.programArgs === undefined ? {} : { programArgs: runInput.programArgs }),
        ...(runInput.maxSteps === undefined ? {} : { maxSteps: runInput.maxSteps }),
        ...(runInput.registers === undefined ? {} : { registers: runInput.registers }),
        ...(runInput.memoryRanges === undefined ? {} : { memoryRanges: runInput.memoryRanges }),
      },
      timeoutMs: runInput.timeoutMs ?? deps.timeoutMs,
      maxOutputBytes: deps.maxOutputBytes,
    });
    const diagnostics = parseDiagnostics(result.stderr);
    const isError = result.exitCode !== 0 || result.timedOut || result.truncated ||
      diagnostics.some((item) => item.severity === 'error');
    const action = mode === 'assemble' ? 'Assembly' : 'Execution';
    const summary = result.timedOut ? `${action} timed out` :
      result.truncated ? `${action} output exceeded its limit` :
      isError ? `${action} failed` : `${action} completed`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { ...result, diagnostics },
      ...(isError ? { isError: true } : {}),
    };
  };

  return {
    assemble: (input: AssembleInput) => execute(input, 'assemble'),
    run: (input: RunInput) => execute(input, 'run'),
    sessionList: async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'Listed RARS sessions' }],
      structuredContent: { sessions: await deps.sessions.list() },
    }),
    sessionClose: async (input: CloseSessionInput): Promise<ToolResult> => {
      await deps.sessions.close(input.sessionId);
      return {
        content: [{ type: 'text', text: `Closed RARS session ${input.sessionId}` }],
        structuredContent: { sessionId: input.sessionId, closed: true },
      };
    },
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
