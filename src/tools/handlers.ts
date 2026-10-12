import type { CliResult, RunRarsOptions } from '../rars/cli.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseDiagnostics } from '../rars/diagnostics.js';
import { extractDumps, extractInstructionCount } from '../rars/output.js';
import type { SessionStore } from '../sessions/store.js';
import type { DebugCommand, InstructionWindow } from '../sessions/types.js';
import type { Workspace } from '../workspace.js';
import { HeadlessSession } from '../sessions/headless.js';
import { LiveClient } from '../live/client.js';
import { discoverLiveSession } from '../live/discovery.js';
import { addressRange, prepareDumps, type ResolvedDump } from './dumps.js';
import { dumpSchema, isBreakpointAction, type AssembleInput, type CloseSessionInput, type DebugCommandInput, type DebugStartInput, type DumpInput, type InspectInput, type LiveCommandInput, type ModifyInput, type RunInput } from './schemas.js';
import { prepareSource, withPreparedSource } from './source.js';

export interface ToolDependencies {
  workspace: Workspace;
  sessions: SessionStore;
  run(options: RunRarsOptions): Promise<CliResult>;
  javaExecutable: string;
  rarsJar: string;
  timeoutMs: number;
  maxOutputBytes: number;
  waveMaxBytes?: number;
  bridgeJar?: string;
  bridgeToken?: string;
  bridgeHost?: string;
  liveDiscoveryDir?: string;
}

export type ToolResult = CallToolResult;

const ERROR_TERMINATION = 'Processing terminated due to errors.';

function formatErrorDetails(stderr: string, diagnostics: ReturnType<typeof parseDiagnostics>): string[] {
  const formatted = diagnostics.map((diagnostic) => {
    const location = [diagnostic.file, diagnostic.line, diagnostic.column]
      .filter((part) => part !== undefined)
      .join(':');
    return `${location}: ${diagnostic.message}`;
  });
  const remaining = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && line.trim() !== ERROR_TERMINATION)
    .filter((line) => parseDiagnostics(line).length === 0);
  return [...formatted, ...remaining];
}

async function resolveDumps(
  dumps: DumpInput[], files: string[], input: AssembleInput | RunInput, deps: ToolDependencies,
): Promise<ResolvedDump[]> {
  const labels = dumps.filter((dump) => typeof dump.segment !== 'string' && 'label' in dump.segment);
  let symbols: Array<{ name: string; address: string }> = [];
  if (labels.length) {
    if (!deps.bridgeJar || !deps.bridgeToken) throw new Error('Label dumps require the stateful RARS bridge to be configured');
    const runInput = input as RunInput;
    const session = await HeadlessSession.create({
      javaExecutable: deps.javaExecutable, bridgeJar: deps.bridgeJar, rarsJar: deps.rarsJar,
      token: deps.bridgeToken, files,
      ...(runInput.programArgs === undefined ? {} : { programArgs: runInput.programArgs }),
      ...(runInput.stdin === undefined ? {} : { stdin: runInput.stdin }),
      timeoutMs: deps.timeoutMs,
    });
    try {
      const inspected = await session.inspect({ includeSymbols: true }) as { symbols?: Array<{ name: string; address: string }> };
      symbols = inspected.symbols ?? [];
    } finally {
      await session.close();
    }
  }
  return dumps.map((dump) => {
    const segment = dump.segment;
    if (typeof segment === 'string') return { input: dump, segment };
    if ('address' in segment) return { input: dump, segment: addressRange(segment.address, segment.words) };
    const address = symbols.find((symbol) => symbol.name === segment.label)?.address;
    if (address === undefined) throw new Error(`Unknown dump label: ${segment.label}`);
    return { input: dump, segment: addressRange(address, segment.words) };
  });
}

export function createToolHandlers(deps: ToolDependencies) {
  const execute = async (input: AssembleInput | RunInput, mode: 'assemble' | 'run'): Promise<ToolResult> => {
    const runInput = input as RunInput;
    // Parsed again here because a direct handler call does not pass through the tool schema.
    const dumps = (input.dump ?? []).map((dump) => dumpSchema.parse(dump));
    const source = input.source === undefined ? undefined : await prepareSource(input.source);
    try {
      const files = source?.files ?? await Promise.all(input.files!.map((file) => deps.workspace.resolve(file)));
      const resolvedDumps = await resolveDumps(dumps, files, input, deps);
      const preparedDumps = await prepareDumps(
        resolvedDumps, (file) => deps.workspace.resolve(file, { allowMissing: true }),
      );
      let result: CliResult;
      let dumpOutput: Array<Record<string, unknown>>;
      try {
        result = await deps.run({
          javaExecutable: deps.javaExecutable,
          rarsJar: deps.rarsJar,
          cwd: source?.directory ?? deps.workspace.root,
          request: {
            mode,
            files,
            ...(runInput.stdin === undefined ? {} : { stdin: runInput.stdin }),
            ...(runInput.programArgs === undefined ? {} : { programArgs: runInput.programArgs }),
            ...(runInput.maxSteps === undefined ? {} : { maxSteps: runInput.maxSteps }),
            ...(runInput.instructionCount ? { instructionCount: true } : {}),
            ...(runInput.registers === undefined ? {} : { registers: runInput.registers }),
            ...(runInput.memoryRanges === undefined ? {} : { memoryRanges: runInput.memoryRanges }),
            ...(preparedDumps.cli.length ? { dumps: preparedDumps.cli } : {}),
          },
          timeoutMs: runInput.timeoutMs ?? deps.timeoutMs,
          maxOutputBytes: deps.maxOutputBytes,
        });
        const failed = result.exitCode !== 0 || result.timedOut || result.truncated ||
          parseDiagnostics(result.stderr).some((diagnostic) => diagnostic.severity === 'error');
        dumpOutput = await preparedDumps.read(!failed);
      } finally {
        await preparedDumps.cleanup();
      }
      // A killed or cut-off run never reaches the point where RARS prints the count and dumps.
      const finished = !result.timedOut && !result.truncated;
      const dumpsRequested = runInput.registers !== undefined || runInput.memoryRanges !== undefined;
      const dumped = finished && dumpsRequested ? extractDumps(result.stderr) : { stderr: result.stderr };
      const counted = finished && runInput.instructionCount ? extractInstructionCount(dumped.stderr) : {};
      const output = { ...dumped, ...counted };
      const diagnostics = parseDiagnostics(output.stderr).map((diagnostic) => ({
        ...diagnostic,
        ...(diagnostic.file === undefined || source === undefined ? {} : { file: source.remapFile(diagnostic.file) }),
      }));
      const isError = result.exitCode !== 0 || result.timedOut || result.truncated ||
        diagnostics.some((item) => item.severity === 'error');
      const action = mode === 'assemble' ? 'Assembly' : 'Execution';
      const summary = result.timedOut ? `${action} timed out` :
        result.truncated ? `${action} output exceeded its limit` :
        isError ? `${action} failed` : `${action} completed`;
      const text = isError ? [summary, ...formatErrorDetails(output.stderr, diagnostics)].join('\n') : summary;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...result, ...output, diagnostics, ...(dumpOutput.length ? { dumps: dumpOutput } : {}) },
        ...(isError ? { isError: true } : {}),
      };
    } finally {
      await source?.cleanup();
    }
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
      const source = input.source === undefined ? undefined : await prepareSource(input.source);
      const files = source?.files ?? await Promise.all(input.files!.map((file) => deps.workspace.resolve(file)));
      let backend;
      try {
        backend = await HeadlessSession.create({
          javaExecutable: deps.javaExecutable, bridgeJar: deps.bridgeJar, rarsJar: deps.rarsJar,
          token: deps.bridgeToken, files,
          ...(input.programArgs === undefined ? {} : { programArgs: input.programArgs }),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          timeoutMs: deps.timeoutMs,
        });
      } catch (error) {
        await source?.cleanup();
        if (source !== undefined && error instanceof Error) error.message = source.remapText(error.message);
        throw error;
      }
      if (source !== undefined) backend = withPreparedSource(backend, source);
      const sessionId = deps.sessions.add(backend);
      return { content: [{ type: 'text', text: `Started RARS debug session ${sessionId}` }], structuredContent: { sessionId, ...(await backend.summary()) } };
    },
    debugCommand: async (input: DebugCommandInput): Promise<ToolResult> => {
      const { sessionId, action, address, maxSteps } = input;
      let command: DebugCommand;
      if (isBreakpointAction(action)) {
        if (address === undefined) throw new Error(`address is required for ${action}`);
        command = { action, address };
      } else if (action === 'continue') {
        command = maxSteps === undefined ? { action } : { action, maxSteps };
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
        ...(request.includeInstructions === undefined ? {} : { includeInstructions: request.includeInstructions }),
        ...(request.instructions === undefined ? {} : { instructions: instructionWindow(request.instructions) }),
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

// The schema keeps the window one flat object; this checks it again for a direct handler call.
function instructionWindow({ around, count, from, to }: NonNullable<InspectInput['instructions']>): InstructionWindow {
  if (from === undefined && to === undefined) {
    return { ...(around === undefined ? {} : { around }), ...(count === undefined ? {} : { count }) };
  }
  if (from === undefined || to === undefined || around !== undefined || count !== undefined) {
    throw new Error('instructions takes around and count, or both from and to');
  }
  return { from, to };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
