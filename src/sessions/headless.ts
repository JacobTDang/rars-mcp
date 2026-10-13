import type { ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createConnection, type Socket } from 'node:net';

import { spawnBridge, stopBridge, watchStartup } from './bridge-process.js';
import { BridgeConnection } from './connection.js';
import type { DebugCommand, EncodedInstruction, InspectRequest, InspectResult, MachineState, ModifyRequest, SessionBackend, SessionSummary, SessionState } from './types.js';

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

export class HeadlessSession implements SessionBackend {
  private readonly connection: BridgeConnection;
  private state: SessionState = 'ready';
  private closed = false;

  private constructor(private readonly child: ChildProcess, socket: Socket, timeoutMs: number) {
    this.connection = new BridgeConnection(socket, { name: 'RARS bridge', timeoutMs });
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

  private updateState(result: Record<string, unknown>): void {
    if (typeof result.status === 'string') this.state = result.status as SessionState;
  }
}
