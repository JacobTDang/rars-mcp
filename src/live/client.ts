import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import type { DebugCommand, InspectRequest, MachineState, ModifyRequest, SessionBackend, SessionState, SessionSummary } from '../sessions/types.js';

export interface LiveConnectionOptions { host: string; port: number; token: string; timeoutMs: number }
interface Response { id: string; ok: boolean; result?: Record<string, unknown>; error?: { message: string } }

export class LiveClient implements SessionBackend {
  private readonly pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private state: SessionState = 'ready';

  private constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
    socket.once('close', () => this.rejectAll(new Error('Live RARS connection closed')));
  }

  static async connect(options: LiveConnectionOptions): Promise<LiveClient> {
    const socket = createConnection({ host: options.host, port: options.port });
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const client = new LiveClient(socket, options.timeoutMs);
    try {
      const hello = await client.request('hello', { token: options.token });
      if (hello.protocolVersion !== 1) throw new Error('Incompatible RARS bridge protocol');
      if (hello.mode !== 'live') throw new Error('Connected bridge is not a live RARS session');
      return client;
    } catch (error) { socket.destroy(); throw error; }
  }

  async summary(): Promise<SessionSummary> { return { kind: 'live', state: this.state }; }
  async command(command: DebugCommand): Promise<MachineState> {
    const result = await this.request('command', { ...command }); this.update(result); return result as unknown as MachineState;
  }
  async inspect(request: InspectRequest): Promise<unknown> {
    return this.request('inspect', {
      registers: request.registers ?? [],
      memory: (request.memory ?? []).map(({ address, length }) => ({ address, width: length })),
      includeSymbols: request.includeSymbols ?? false,
    });
  }
  async modify(request: ModifyRequest): Promise<MachineState> {
    const result = await this.request('modify', { registers: request.registers ?? {}, memory: request.memory ?? [] }); this.update(result); return result as unknown as MachineState;
  }
  async load(payload: { files: string[]; programArgs?: string[]; stdin?: string; conflictPolicy: 'reject' | 'discard' }): Promise<Record<string, unknown>> {
    const result = await this.request('load', payload); this.update(result); return result;
  }
  async close(): Promise<void> { this.socket.end(); this.rejectAll(new Error('Live RARS session disconnected')); }

  private request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Live RARS request timed out: ${command}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ protocolVersion: 1, id, command, payload })}\n`);
    });
  }
  private receive(line: string): void {
    const response = JSON.parse(line) as Response;
    const pending = this.pending.get(response.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result ?? {}); else pending.reject(new Error(response.error?.message ?? 'Live RARS request failed'));
  }
  private update(result: Record<string, unknown>): void { if (typeof result.status === 'string') this.state = result.status as SessionState; }
  private rejectAll(error: Error): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
}
