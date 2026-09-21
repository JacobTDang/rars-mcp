import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { createToolDependencies } from './dependencies.js';
import { createMcpServer } from './server.js';

export interface StdioServerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  input?: Readable;
  output?: Writable;
}

// Runs the MCP server in this process over stdio, so a local client needs no HTTP server.
export async function startStdioServer(options: StdioServerOptions = {}): Promise<{ close(): Promise<void> }> {
  const env = options.env ?? process.env;
  const dependencies = await createToolDependencies(loadConfig(env), env);
  const handle = serveStdio(() => createMcpServer(dependencies), {
    transport: new StdioServerTransport(options.input ?? process.stdin, options.output ?? process.stdout),
    onerror: (error) => console.error(error),
  });
  return {
    async close() {
      await handle.close();
      await dependencies.sessions.closeAll();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startStdioServer();
  const shutdown = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
