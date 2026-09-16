import { createInterface } from 'node:readline';
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

export async function proxyStdio(endpoint = process.env.RARS_MCP_URL ?? 'http://127.0.0.1:3000/mcp'): Promise<void> {
  let sessionId: string | undefined;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
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
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      const parsed = (() => { try { return JSON.parse(line) as JsonRpcMessage; } catch { return {}; } })();
      if ('id' in parsed) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32603, message: 'MCP proxy request failed' } })}\n`);
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
