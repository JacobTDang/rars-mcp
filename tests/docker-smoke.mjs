import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'docker-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
const tools = await client.listTools();
if (!tools.tools.some(({ name }) => name === 'rars_run')) throw new Error('rars_run missing');
const result = await client.callTool({ name: 'rars_run', arguments: { files: ['hello.asm'] } });
if (result.isError || !JSON.stringify(result).includes('hello from rars')) throw new Error(JSON.stringify(result));
await client.close();
