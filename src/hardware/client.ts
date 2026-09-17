import { RarsError, type RarsErrorCode } from '../errors.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HardwareClient {
  private readonly fetchImpl: FetchLike;
  constructor(private readonly options: { baseUrl: string; token: string; timeoutMs: number; fetchImpl?: FetchLike }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  capabilities(): Promise<Record<string, unknown>> { return this.request('GET', '/capabilities'); }
  validate(input: { manifestPath: string; target?: string }): Promise<Record<string, unknown>> { return this.request('POST', '/validate', input); }
  start(input: { manifestPath: string; target: string; parentJobId?: string }): Promise<Record<string, unknown>> { return this.request('POST', '/jobs', input); }
  status(id: string): Promise<Record<string, unknown>> { return this.request('GET', `/jobs/${id}`); }
  cancel(id: string): Promise<Record<string, unknown>> { return this.request('POST', `/jobs/${id}/cancel`); }
  logs(id: string, offset: number, limit: number): Promise<Record<string, unknown>> { return this.request('GET', `/jobs/${id}/logs?offset=${offset}&limit=${limit}`); }
  artifacts(id: string): Promise<Record<string, unknown>> { return this.request('GET', `/jobs/${id}/artifacts`); }
  wave(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('POST', `/jobs/${id}/wave`, input); }
  traceCompare(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('POST', '/trace/compare', input); }
  riscvGenerate(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('POST', '/riscv/generate', input); }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method, signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof payload.code === 'string' ? payload.code as RarsErrorCode : 'WORKER_UNAVAILABLE';
        throw new RarsError(code, typeof payload.message === 'string' ? payload.message : `Hardware worker returned ${response.status}`, payload.details as Record<string, unknown> | undefined);
      }
      return payload;
    } catch (error) {
      if (error instanceof RarsError) throw error;
      throw new RarsError('WORKER_UNAVAILABLE', 'Hardware worker is unavailable', { cause: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}
