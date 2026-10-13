import type { CliResult, RunRarsOptions } from '../rars/cli.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { parseDiagnostics } from '../rars/diagnostics.js';
import { argumentRejected, assemblyFailed, extractDumps, extractInstructionCount, stepLimitReached } from '../rars/output.js';
import type { SessionStore } from '../sessions/store.js';
import type { DebugCommand, InstructionWindow } from '../sessions/types.js';
import type { VhdlSimulator } from '../vhdl/simulator.js';
import type { Workspace } from '../workspace.js';
import { HeadlessSession } from '../sessions/headless.js';
import { LiveClient } from '../live/client.js';
import { discoverLiveSession } from '../live/discovery.js';
import { addressRange, prepareDumps, type ResolvedDump } from './dumps.js';
import { dumpSchema, isBreakpointAction, isWordAligned, type AssembleInput, type CloseSessionInput, type DebugCommandInput, type DebugStartInput, type DumpInput, type InspectInput, type LiveCommandInput, type ModifyInput, type RunInput } from './schemas.js';
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
  tclshExecutable?: string;
  vhdl?: VhdlSimulator;
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

// The dumps with each label replaced by its address. A program that does not assemble has no labels, so
// it gets no dumps, and the error the bridge gave; RARS then reports the failure as for any program.
async function resolveDumps(
  dumps: DumpInput[], files: string[], input: AssembleInput | RunInput, deps: ToolDependencies,
): Promise<{ dumps: ResolvedDump[]; assemblyError?: Error }> {
  const labels = dumps.filter((dump) => typeof dump.segment !== 'string' && 'label' in dump.segment);
  let symbols: Array<{ name: string; address: string }> = [];
  if (labels.length) {
    if (!deps.bridgeJar || !deps.bridgeToken) throw new Error('Label dumps require the stateful RARS bridge to be configured');
    const runInput = input as RunInput;
    let session: HeadlessSession;
    try {
      session = await HeadlessSession.create({
        javaExecutable: deps.javaExecutable, bridgeJar: deps.bridgeJar, rarsJar: deps.rarsJar,
        token: deps.bridgeToken, files,
        ...(runInput.programArgs === undefined ? {} : { programArgs: runInput.programArgs }),
        ...(runInput.stdin === undefined ? {} : { stdin: runInput.stdin }),
        timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes,
      });
    } catch (error) {
      // The bridge refuses a program that does not assemble with RARS's own diagnostics.
      if (error instanceof Error && parseDiagnostics(error.message).some((diagnostic) => diagnostic.severity === 'error')) {
        return { dumps: [], assemblyError: error };
      }
      throw error;
    }
    try {
      const inspected = await session.inspect({ includeSymbols: true }) as { symbols?: Array<{ name: string; address: string }> };
      symbols = inspected.symbols ?? [];
    } finally {
      await session.close();
    }
  }
  return {
    dumps: dumps.map((dump) => {
      const segment = dump.segment;
      if (typeof segment === 'string') return { input: dump, segment };
      if ('address' in segment) return { input: dump, segment: addressRange(segment.address, segment.words) };
      const address = symbols.find((symbol) => symbol.name === segment.label)?.address;
      if (address === undefined) throw new Error(`Unknown dump label: ${segment.label}`);
      if (!isWordAligned(address)) throw new Error(`dump label ${segment.label} at ${address} is not word aligned`);
      return { input: dump, segment: addressRange(address, segment.words) };
    }),
  };
}

// A killed or cut-off run never reaches the point where RARS prints the count and writes the dumps,
// and RARS runs nothing when it refuses an argument.
function runFinished(result: CliResult): boolean {
  return !result.timedOut && !result.truncated && !argumentRejected(result.stderr);
}

export function createToolHandlers(deps: ToolDependencies) {
  const execute = async (input: AssembleInput | RunInput, mode: 'assemble' | 'run'): Promise<ToolResult> => {
    const runInput = input as RunInput;
    // Parsed again here because a direct handler call does not pass through the tool schema.
    const dumps = (input.dump ?? []).map((dump) => dumpSchema.parse(dump));
    const source = input.source === undefined ? undefined : await prepareSource(input.source);
    try {
      const files = source?.files ?? await Promise.all(input.files!.map((file) => deps.workspace.resolve(file)));
      const { dumps: resolvedDumps, assemblyError } = await resolveDumps(dumps, files, input, deps);
      const preparedDumps = await prepareDumps(
        resolvedDumps, (file) => deps.workspace.resolve(file, { allowMissing: true }),
      );
      const timeoutMs = runInput.timeoutMs ?? deps.timeoutMs;
      let result: CliResult;
      let dumpOutput: Array<Record<string, unknown>>;
      let unwrittenDumps: string[];
      try {
        const ran = await deps.run({
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
          timeoutMs,
          maxOutputBytes: deps.maxOutputBytes,
        });
        // RARS names the file of a dump it could not write and the file of each diagnostic, and a temporary
        // path means nothing to the caller.
        const stderr = preparedDumps.remapText(ran.stderr);
        result = { ...ran, stderr: source === undefined ? stderr : source.remapText(stderr) };
        // RARS writes the dumps once the program has assembled, even when the run then fails, and prints
        // its reason for each one it cannot write.
        const dumpsWritten = runFinished(result) && !assemblyFailed(result.stderr);
        unwrittenDumps = dumpsWritten ? await preparedDumps.unwritten() : [];
        dumpOutput = await preparedDumps.read(dumpsWritten);
      } finally {
        await preparedDumps.cleanup();
      }
      // Without the label addresses there are no dumps to return, so RARS must also fail to assemble the program.
      if (assemblyError !== undefined && !assemblyFailed(result.stderr)) {
        if (source !== undefined) assemblyError.message = source.remapText(assemblyError.message);
        throw assemblyError;
      }
      const rejected = argumentRejected(result.stderr);
      const finished = runFinished(result);
      const dumpsRequested = runInput.registers !== undefined || runInput.memoryRanges !== undefined;
      const dumped = finished && dumpsRequested ? extractDumps(result.stderr) : { stderr: result.stderr };
      const counted = finished && runInput.instructionCount ? extractInstructionCount(dumped.stderr) : {};
      const output = { ...dumped, ...counted };
      const diagnostics = parseDiagnostics(output.stderr);
      const failed = rejected || result.exitCode !== 0 || diagnostics.some((item) => item.severity === 'error');
      // RARS exits 0 when it stops a run at its step limit, though the program did not finish.
      const stepLimit = finished && runInput.maxSteps !== undefined && stepLimitReached(result.stderr, runInput.maxSteps);
      const isError = failed || stepLimit || result.timedOut || result.truncated || unwrittenDumps.length > 0;
      const action = mode === 'assemble' || assemblyFailed(result.stderr) ? 'Assembly' : 'Execution';
      const outcome = result.timedOut ? `${action} timed out after ${timeoutMs} ms` :
        result.truncated ? `${action} output exceeded its limit` :
        failed ? `${action} failed` :
        stepLimit ? `${action} stopped at the step limit of ${runInput.maxSteps}` : `${action} completed`;
      const summary = unwrittenDumps.length === 0 ? outcome :
        `${outcome}${failed || stepLimit ? ', and' : ', but'} RARS wrote no file for ${unwrittenDumps.join(', ')}`;
      const text = isError ? [summary, ...formatErrorDetails(output.stderr, diagnostics)].join('\n') : summary;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ...result, ...output, ...(mode === 'run' ? { stepLimitReached: stepLimit } : {}), diagnostics,
          ...(dumpOutput.length ? { dumps: dumpOutput } : {}),
        },
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
          timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes,
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
      return { content: [{ type: 'text', text: `Inspected RARS session ${sessionId}` }], structuredContent: result as unknown as Record<string, unknown> };
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
