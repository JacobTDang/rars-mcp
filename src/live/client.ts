import { createConnection } from 'node:net';

import { BridgeConnection } from '../sessions/connection.js';
import type { DebugCommand, InspectRequest, InspectResult, MachineState, ModifyRequest, SessionBackend, SessionState, SessionSummary } from '../sessions/types.js';

export interface LiveConnectionOptions { host: string; port: number; token: string; directory?: string; timeoutMs: number }

export class LiveClient implements SessionBackend {
  private state: SessionState = 'ready';

  private constructor(private readonly connection: BridgeConnection) {}

  static async connect(options: LiveConnectionOptions): Promise<LiveClient> {
    const socket = createConnection({ host: options.host, port: options.port });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    } catch (error) {
      const refused = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ECONNREFUSED';
      if (refused && options.directory !== undefined) {
        throw new Error(`The discovery files in ${options.directory} point at a RARS desktop session that is no longer running `
          + `(connection refused on ${options.host}:${options.port}). Start the desktop launcher again.`);
      }
      throw error;
    }
    const client = new LiveClient(new BridgeConnection(socket, { name: 'Live RARS', timeoutMs: options.timeoutMs }));
    try {
      const hello = await client.request('hello', { token: options.token });
      if (hello.protocolVersion !== 1) throw new Error('Incompatible RARS bridge protocol');
      if (hello.mode !== 'live') throw new Error('Connected bridge is not a live RARS session');
      return client;
    } catch (error) {
      client.connection.close('Live RARS session disconnected');
      socket.destroy();
      throw error;
    }
  }

  async summary(): Promise<SessionSummary> { return { kind: 'live', state: this.state }; }
  async command(command: DebugCommand): Promise<MachineState> {
    const result = await this.request('command', { ...command }); this.update(result); return result as unknown as MachineState;
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
    const result = await this.request('modify', { registers: request.registers ?? {}, memory: request.memory ?? [] }); this.update(result); return result as unknown as MachineState;
  }
  async load(payload: { files: string[]; programArgs?: string[]; stdin?: string; conflictPolicy: 'reject' | 'discard' }): Promise<Record<string, unknown>> {
    const result = await this.request('load', payload); this.update(result); return result;
  }
  async close(): Promise<void> { this.connection.close('Live RARS session disconnected'); }
  onFailure(listener: (error: Error) => void): void { this.connection.onFailure(listener); }

  private request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.connection.request(command, payload);
  }
  private update(result: Record<string, unknown>): void { if (typeof result.status === 'string') this.state = result.status as SessionState; }
}
