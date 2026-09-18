import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

type JsonRpcMessage = Record<string, unknown>;

export async function parseSseResponse(response: Response): Promise<JsonRpcMessage[]> {
  if (response.status === 202 || response.status === 204) return [];
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return [await response.json() as JsonRpcMessage];
  const body = await response.text();
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Unexpected MCP response ${response.status}: ${body}`);
  }
  return body.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as JsonRpcMessage);
}

// fetch reports network failures as "fetch failed" with the real reason, such as ECONNREFUSED, in its cause.
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error.cause instanceof Error)) return error.message;
  const code = (error.cause as { code?: unknown }).code;
  return `${error.message} (${typeof code === 'string' ? code : error.cause.message})`;
}

export async function proxyStdio(
  endpoint = process.env.RARS_MCP_URL ?? 'http://127.0.0.1:3000/mcp',
  source: Readable = process.stdin,
  sink: Writable = process.stdout,
): Promise<void> {
  let sessionId: string | undefined;
  const input = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const response = await fetch(endpoint, { method: 'POST', headers, body: line });
      sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      for (const message of await parseSseResponse(response)) {
        sink.write(`${JSON.stringify(message)}\n`);
      }
    } catch (error) {
      const message = `MCP proxy request to ${endpoint} failed: ${describeFailure(error)}`;
      console.error(message);
      const parsed = (() => { try { return JSON.parse(line) as JsonRpcMessage; } catch { return {}; } })();
      if ('id' in parsed) {
        sink.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32603, message } })}\n`);
      }
    }
  }
  if (sessionId) {
    await fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void proxyStdio();
}
