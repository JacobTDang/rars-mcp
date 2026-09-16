import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'live-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
const connected = await client.callTool({ name: 'rars_live_connect', arguments: {} });
if (connected.isError) throw new Error(JSON.stringify(connected));
const sessionId = connected.structuredContent.sessionId;
for (const command of [
  { action: 'step' },
  { action: 'modify', registers: { a0: '9' } },
  { action: 'inspect', registers: ['a0'] },
]) {
  const result = await client.callTool({ name: 'rars_live_command', arguments: { sessionId, command } });
  if (result.isError) throw new Error(JSON.stringify(result));
}
await client.callTool({ name: 'rars_session_close', arguments: { sessionId } });
await client.close();
