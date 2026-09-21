import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import type { DebugCommand, InspectRequest, MachineState, ModifyRequest, SessionBackend, SessionSummary, SessionState } from './types.js';

interface HeadlessOptions {
  javaExecutable: string;
  bridgeJar: string;
  rarsJar: string;
  token: string;
  bridgeToken?: string;
  files: string[];
  programArgs?: string[];
  stdin?: string;
  timeoutMs: number;
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
    const serverToken = options.bridgeToken ?? options.token;
    const child = spawn(options.javaExecutable, [
      '-cp', `${options.bridgeJar}${delimiter}${options.rarsJar}`,
      'dev.rarsmcp.server.BridgeServer', '--token', serverToken, '--port', '0',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stderr!, crlfDelay: Infinity });
      const timer = setTimeout(() => reject(new Error('RARS bridge startup timed out')), options.timeoutMs);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`RARS bridge exited during startup (${code})`)));
      lines.on('line', (line) => {
        const match = line.match(/^RARS_MCP_PORT=(\d+)$/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const socket = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const session = new HeadlessSession(child, socket, options.timeoutMs);
    try {
      await session.request('hello', { token: options.token });
      const state = await session.request('load', {
        files: options.files, programArgs: options.programArgs ?? [], stdin: options.stdin ?? '',
      });
      session.updateState(state);
      return session;
    } catch (error) {
      socket.destroy();
      child.kill('SIGKILL');
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

  async inspect(request: InspectRequest): Promise<unknown> {
    return this.request('inspect', {
      registers: request.registers ?? [],
      memory: (request.memory ?? []).map(({ address, length }) => ({ address, width: length })),
      includeSymbols: request.includeSymbols ?? false,
      includeInstructions: request.includeInstructions ?? false,
    });
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
