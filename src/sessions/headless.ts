import type { ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import { spawnBridge, watchStartup } from './bridge-process.js';
import type { DebugCommand, EncodedInstruction, InspectRequest, InspectResult, MachineState, ModifyRequest, SessionBackend, SessionSummary, SessionState } from './types.js';

interface BridgeOptions {
  javaExecutable: string;
  bridgeJar: string;
  rarsJar: string;
  token: string;
  bridgeToken?: string;
  timeoutMs: number;
}

interface HeadlessOptions extends BridgeOptions {
  files: string[];
  programArgs?: string[];
  stdin?: string;
}

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export class HeadlessSession implements SessionBackend {
  private readonly pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private state: SessionState = 'ready';
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    const disconnected = () => this.rejectPending(new Error('RARS bridge connection closed'));
    socket.once('close', disconnected);
    child.once('exit', disconnected);
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
      session.kill();
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
    ]);
    const startup = watchStartup(child, options.timeoutMs);
    let socket: Socket | undefined;
    try {
      const port = await startup.within(startup.port);
      const connection = createConnection({ host: '127.0.0.1', port });
      socket = connection;
      await startup.within(new Promise<void>((resolve, reject) => {
        connection.once('connect', resolve);
        connection.once('error', reject);
      }));
      const session = new HeadlessSession(child, connection, options.timeoutMs);
      await startup.within(session.request('hello', { token: options.token }));
      startup.finish();
      return session;
    } catch (error) {
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.request('close', {}).catch(() => undefined);
    this.socket.end();
    this.child.kill('SIGTERM');
    this.rejectPending(new Error('RARS session closed'));
  }

  isClosed(): boolean { return this.closed; }

  private kill(): void {
    this.socket.destroy();
    this.child.kill('SIGKILL');
  }

  private request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RARS bridge request timed out: ${command}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ protocolVersion: 1, id, command, payload })}\n`);
    });
  }

  private receive(line: string): void {
    const response = JSON.parse(line) as BridgeResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.ok) pending.reject(new Error(response.error?.message ?? 'RARS bridge request failed'));
    else pending.resolve(response.result ?? {});
  }

  private updateState(result: Record<string, unknown>): void {
    if (typeof result.status === 'string') this.state = result.status as SessionState;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
