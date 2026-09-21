import type { CliResult, RunRarsOptions } from '../rars/cli.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseDiagnostics } from '../rars/diagnostics.js';
import { extractDumps, extractInstructionCount } from '../rars/output.js';
import type { SessionStore } from '../sessions/store.js';
import type { DebugCommand } from '../sessions/types.js';
import type { Workspace } from '../workspace.js';
import { HeadlessSession } from '../sessions/headless.js';
import { LiveClient } from '../live/client.js';
import { discoverLiveSession } from '../live/discovery.js';
import { isBreakpointAction, type AssembleInput, type CloseSessionInput, type DebugCommandInput, type DebugStartInput, type InspectInput, type LiveCommandInput, type ModifyInput, type RunInput } from './schemas.js';

export interface ToolDependencies {
  workspace: Workspace;
  sessions: SessionStore;
  run(options: RunRarsOptions): Promise<CliResult>;
  javaExecutable: string;
  rarsJar: string;
  timeoutMs: number;
  maxOutputBytes: number;
  bridgeJar?: string;
  bridgeToken?: string;
  bridgeHost?: string;
  liveDiscoveryDir?: string;
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
        ...(runInput.instructionCount ? { instructionCount: true } : {}),
        ...(runInput.registers === undefined ? {} : { registers: runInput.registers }),
        ...(runInput.memoryRanges === undefined ? {} : { memoryRanges: runInput.memoryRanges }),
      },
      timeoutMs: runInput.timeoutMs ?? deps.timeoutMs,
      maxOutputBytes: deps.maxOutputBytes,
    });
    // A killed or cut-off run never reaches the point where RARS prints the count and dumps.
    const finished = !result.timedOut && !result.truncated;
    const dumpsRequested = runInput.registers !== undefined || runInput.memoryRanges !== undefined;
    const dumped = finished && dumpsRequested ? extractDumps(result.stderr) : { stderr: result.stderr };
    const counted = finished && runInput.instructionCount ? extractInstructionCount(dumped.stderr) : {};
    const output = { ...dumped, ...counted };
    const diagnostics = parseDiagnostics(output.stderr);
    const isError = result.exitCode !== 0 || result.timedOut || result.truncated ||
      diagnostics.some((item) => item.severity === 'error');
    const action = mode === 'assemble' ? 'Assembly' : 'Execution';
    const summary = result.timedOut ? `${action} timed out` :
      result.truncated ? `${action} output exceeded its limit` :
      isError ? `${action} failed` : `${action} completed`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { ...result, ...output, diagnostics },
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
    debugStart: async (input: DebugStartInput): Promise<ToolResult> => {
      if (!deps.bridgeJar || !deps.bridgeToken) throw new Error('Stateful RARS bridge is not configured');
      const files = await Promise.all(input.files.map((file) => deps.workspace.resolve(file)));
      const backend = await HeadlessSession.create({
        javaExecutable: deps.javaExecutable, bridgeJar: deps.bridgeJar, rarsJar: deps.rarsJar,
        token: deps.bridgeToken, files,
        ...(input.programArgs === undefined ? {} : { programArgs: input.programArgs }),
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: deps.timeoutMs,
      });
      const sessionId = deps.sessions.add(backend);
      return { content: [{ type: 'text', text: `Started RARS debug session ${sessionId}` }], structuredContent: { sessionId, ...(await backend.summary()) } };
    },
    debugCommand: async (input: DebugCommandInput): Promise<ToolResult> => {
      const { sessionId, action, address } = input;
      let command: DebugCommand;
      if (isBreakpointAction(action)) {
        if (address === undefined) throw new Error(`address is required for ${action}`);
        command = { action, address };
      } else {
        command = { action };
      }
      const state = await deps.sessions.get(sessionId).command(command);
      return { content: [{ type: 'text', text: `Applied ${input.action} to ${sessionId}` }], structuredContent: state as unknown as Record<string, unknown> };
    },
    inspect: async (input: InspectInput): Promise<ToolResult> => {
      const { sessionId, ...request } = input;
      const result = await deps.sessions.get(sessionId).inspect({
        ...(request.registers === undefined ? {} : { registers: request.registers }),
        ...(request.memory === undefined ? {} : { memory: request.memory }),
        ...(request.includeSymbols === undefined ? {} : { includeSymbols: request.includeSymbols }),
      });
      return { content: [{ type: 'text', text: `Inspected RARS session ${sessionId}` }], structuredContent: result as Record<string, unknown> };
    },
    modify: async (input: ModifyInput): Promise<ToolResult> => {
      const { sessionId, ...request } = input;
      const state = await deps.sessions.get(sessionId).modify({
        ...(request.registers === undefined ? {} : { registers: request.registers }),
        ...(request.memory === undefined ? {} : { memory: request.memory }),
      });
      return { content: [{ type: 'text', text: `Modified RARS session ${sessionId}` }], structuredContent: state as unknown as Record<string, unknown> };
    },
    liveConnect: async (_input: Record<string, never> = {}): Promise<ToolResult> => {
      if (!deps.liveDiscoveryDir) throw new Error('Live RARS discovery is not configured');
      if (!deps.bridgeHost) throw new Error('Live RARS bridge host is not configured');
      const discovered = await discoverLiveSession(deps.liveDiscoveryDir);
      const backend = await LiveClient.connect({ host: deps.bridgeHost, ...discovered, timeoutMs: deps.timeoutMs });
      const sessionId = deps.sessions.add(backend);
      return { content: [{ type: 'text', text: `Connected live RARS session ${sessionId}` }], structuredContent: { sessionId, kind: 'live', state: 'ready' } };
    },
    liveCommand: async (input: LiveCommandInput): Promise<ToolResult> => {
      const backend = deps.sessions.get(input.sessionId);
      const command = input.command;
      let result: unknown;
      if (command.action === 'load') {
        if (!(backend instanceof LiveClient)) throw new Error('Session is not a live RARS session');
        const files = await Promise.all(command.files.map((file) => deps.workspace.resolve(file)));
        result = await backend.load({ files, conflictPolicy: command.conflictPolicy, ...(command.programArgs === undefined ? {} : { programArgs: command.programArgs }), ...(command.stdin === undefined ? {} : { stdin: command.stdin }) });
      } else if (command.action === 'inspect') {
        result = await backend.inspect({ ...(command.registers === undefined ? {} : { registers: command.registers }), ...(command.memory === undefined ? {} : { memory: command.memory }) });
      } else if (command.action === 'modify') {
        result = await backend.modify({ ...(command.registers === undefined ? {} : { registers: command.registers }), ...(command.memory === undefined ? {} : { memory: command.memory }) });
      } else {
        result = await backend.command(command);
      }
      return { content: [{ type: 'text', text: `Applied ${command.action} to visible RARS session ${input.sessionId}` }], structuredContent: result as Record<string, unknown> };
    },
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
