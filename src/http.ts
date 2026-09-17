import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { loadConfig } from './config.js';
import { runRars } from './rars/cli.js';
import { createMcpServer } from './server.js';
import { SessionStore } from './sessions/store.js';
import type { ToolDependencies } from './tools/handlers.js';
import { Workspace } from './workspace.js';
import { HardwareClient } from './hardware/client.js';

export interface HttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createHttpHandler(dependencies: ToolDependencies): HttpHandler {
  const mcp = createMcpHandler(() => createMcpServer(dependencies), { legacy: 'stateless' });
  const liveAvailable = () => Boolean(dependencies.liveDiscoveryDir &&
    existsSync(join(dependencies.liveDiscoveryDir, 'token')) && existsSync(join(dependencies.liveDiscoveryDir, 'port')));
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname === '/health') {
        return Response.json({ status: 'ok', rars: { jar: dependencies.rarsJar }, liveBridge: liveAvailable() ? 'available' : 'disconnected' });
      }
      if (request.method === 'GET' && pathname === '/capabilities') {
        let hardware: unknown = { enabled: false, available: false };
        if (dependencies.hardwareClient) {
          try { hardware = { enabled: true, available: true, ...await dependencies.hardwareClient.capabilities() }; }
          catch { hardware = { enabled: true, available: false }; }
        }
        return Response.json({ headless: true, statefulDebugging: Boolean(dependencies.bridgeJar), live: liveAvailable(), hardware, transports: ['streamable-http', 'stdio-proxy'] });
      }
      if (pathname !== '/mcp') return new Response('Not found', { status: 404 });
      return mcp.fetch(request);
    },
    close: () => mcp.close(),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const workspace = await Workspace.create(config.workspaceRoot);
  const sessions = new SessionStore();
  const hardwareClient = config.hardware.enabled && config.hardware.workerToken
    ? new HardwareClient({ baseUrl: config.hardware.workerUrl, token: config.hardware.workerToken, timeoutMs: config.executionTimeoutMs })
    : undefined;
  const handler = createHttpHandler({
    workspace,
    sessions,
    run: runRars,
    javaExecutable: process.env.JAVA_EXECUTABLE ?? 'java',
    rarsJar: config.rarsJar,
    timeoutMs: config.executionTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    bridgeJar: config.bridgeJar,
    bridgeToken: process.env.RARS_HEADLESS_BRIDGE_TOKEN ?? 'internal-headless-bridge',
    bridgeHost: config.bridgeHost,
    liveDiscoveryDir: config.liveDiscoveryDir,
    ...(hardwareClient === undefined ? {} : { hardwareClient }),
  });
  const nodeHandler = toNodeHandler(handler);
  const port = Number(process.env.PORT ?? '3000');
  const server = createServer((request, response) => {
    if (!request.method) {
      response.writeHead(400).end('Missing request method');
      return;
    }
    void nodeHandler(
      request as unknown as Parameters<typeof nodeHandler>[0],
      response as unknown as Parameters<typeof nodeHandler>[1],
    );
  });
  server.listen(port, '0.0.0.0', () => console.error(`RARS MCP listening on port ${port}`));
  const shutdown = async () => {
    server.close();
    await sessions.closeAll();
    await handler.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
