import type { ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createConnection, type Socket } from 'node:net';

import { RarsError } from '../errors.js';
import { describeExit, spawnBridge, stopBridge, watchStartup } from './bridge-process.js';
import { BridgeConnection } from './connection.js';
import type { DebugCommand, EncodedInstruction, InspectRequest, InspectResult, LoadRequest, MachineState, ModifyRequest, SessionBackend, SessionSummary, SessionState } from './types.js';

interface BridgeOptions {
  javaExecutable: string;
  bridgeJar: string;
  rarsJar: string;
  token: string;
  bridgeToken?: string;
  timeoutMs: number;
  // The most program output, stdout and stderr together, the bridge keeps from one run.
  maxOutputBytes: number;
}

interface HeadlessOptions extends BridgeOptions {
  files: string[];
  programArgs?: string[];
  stdin?: string;
}

// A bridge that dies closes its connection and exits at about the same moment. The exit says
// more, so when the connection closes first, the session waits this long for the exit.
const exitGraceMs = 1_000;

export class HeadlessSession implements SessionBackend {
  private readonly connection: BridgeConnection;
  private state: SessionState = 'ready';
  private closed = false;

  private constructor(private readonly child: ChildProcess, socket: Socket, timeoutMs: number) {
    this.connection = new BridgeConnection(socket, {
      name: 'RARS bridge', timeoutMs, onDisconnect: (failure) => this.disconnected(failure),
    });
    // A failed session has no further use for its bridge.
    this.connection.onFailure(() => {
      stopBridge(child).catch((error: unknown) => console.error('Failed to stop the RARS bridge of a failed session:', error));
    });
  }

  static async create(options: HeadlessOptions): Promise<HeadlessSession> {
    const session = await HeadlessSession.start(options);
    try {
      const state = await session.request('load', {
        files: options.files, programArgs: options.programArgs ?? [], stdin: options.stdin ?? '',
      });
      session.updateState(state);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  // In a bridge of its own: assembling resets RARS's global state, which a loaded program depends on.
  static async encode(options: BridgeOptions, instructions: readonly string[]): Promise<EncodedInstruction[]> {
    const session = await HeadlessSession.start(options);
    try {
      const result = await session.request('encode', { instructions });
      return result.instructions as EncodedInstruction[];
    } finally {
      await session.close();
    }
  }

  // The ready line, the connection and the hello reply all count against timeoutMs.
  private static async start(options: BridgeOptions): Promise<HeadlessSession> {
    const serverToken = options.bridgeToken ?? options.token;
    const child = spawnBridge(options.javaExecutable, [
      '-cp', `${options.bridgeJar}${delimiter}${options.rarsJar}`,
      'dev.rarsmcp.server.BridgeServer', '--token', serverToken, '--port', '0',
      '--max-output-bytes', String(options.maxOutputBytes),
    ]);
    const startup = watchStartup(child, options.timeoutMs);
    let socket: Socket | undefined;
    let session: HeadlessSession | undefined;
    try {
      const port = await startup.within(startup.port);
      const connection = createConnection({ host: '127.0.0.1', port });
      socket = connection;
      await startup.within(new Promise<void>((resolve, reject) => {
        connection.once('connect', resolve);
        connection.once('error', reject);
      }));
      session = new HeadlessSession(child, connection, options.timeoutMs);
      await startup.within(session.request('hello', { token: options.token }));
      startup.finish();
      session.watchExit();
      return session;
    } catch (error) {
      // The startup error is the one to report, so the session is closed before its connection breaks.
      session?.connection.close('RARS bridge did not start');
      socket?.destroy();
      await startup.abort();
      throw error;
    }
  }

  async summary(): Promise<SessionSummary> { return { kind: 'headless', state: this.state }; }

  async command(command: DebugCommand): Promise<MachineState> {
    const payload: Record<string, unknown> = { ...command };
    if ('address' in command) payload.address = command.address;
    const result = await this.request('command', payload);
    this.updateState(result);
    return result as unknown as MachineState;
  }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    const result = await this.request('inspect', {
      registers: request.registers ?? [],
      memory: (request.memory ?? []).map(({ address, length }) => ({ address, width: length })),
      includeSymbols: request.includeSymbols ?? false,
      includeInstructions: request.includeInstructions ?? false,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    });
    return result as unknown as InspectResult;
  }

  async modify(request: ModifyRequest): Promise<MachineState> {
    const result = await this.request('modify', {
      registers: request.registers ?? {}, memory: request.memory ?? [],
    });
    this.updateState(result);
    return result as unknown as MachineState;
  }

  // A headless session debugs the program it started with, and nothing is sent to the bridge.
  async load(_request: LoadRequest): Promise<MachineState> {
    throw new Error('Session is not a live RARS session, so it cannot load a program. '
      + 'Start a session for that program with rars_debug_start');
  }

  // The bridge holds nothing worth keeping, so it is killed, and close returns once it has exited.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connection.close('RARS session closed');
    await stopBridge(this.child);
  }

  isClosed(): boolean { return this.closed; }

  onFailure(listener: (error: Error) => void): void { this.connection.onFailure(listener); }

  private request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.connection.request(command, payload);
  }

  // Until the bridge has started, the startup reports its exit, with what it printed.
  private watchExit(): void {
    const exited = () => this.connection.fail(new RarsError(
      'BRIDGE_EXITED', `RARS bridge exited ${describeExit(this.child.exitCode, this.child.signalCode)}`,
      { exitCode: this.child.exitCode, signal: this.child.signalCode },
    ));
    if (this.child.exitCode !== null || this.child.signalCode !== null) exited();
    else this.child.once('exit', exited);
  }

  private disconnected(failure: RarsError): void {
    const timer = setTimeout(() => this.connection.fail(failure), exitGraceMs);
    this.child.once('exit', () => clearTimeout(timer));
  }

  private updateState(result: Record<string, unknown>): void {
    if (typeof result.status === 'string') this.state = result.status as SessionState;
  }
}
