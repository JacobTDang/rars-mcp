import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';

import { createToolHandlers, type ToolDependencies } from './tools/handlers.js';
import { assembleSchema, closeSessionSchema, debugCommandSchema, debugStartSchema, emptySchema, inspectSchema, liveCommandSchema, liveConnectSchema, modifySchema, runSchema } from './tools/schemas.js';

export function createMcpServer(dependencies: ToolDependencies): McpServer {
  const handlers = createToolHandlers(dependencies);
  const folders = dependencies.workspace.roots.join(', ');
  const server = new McpServer(
    { name: 'rars-mcp', version: '0.1.0' },
    {
      instructions: `Workspace folders: ${folders}. Relative file paths resolve against the first folder; `
        + 'absolute paths may point into any of them, and into any folder this client advertises as a root. '
        + 'Headless calls are isolated.',
    },
  );

  server.registerTool('rars_assemble', {
    description: 'Assemble one or more RISC-V source files from the mounted workspace.',
    inputSchema: assembleSchema,
  }, handlers.assemble);
  server.registerTool('rars_run', {
    description: 'Run RISC-V source files in an isolated headless RARS process.',
    inputSchema: runSchema,
  }, handlers.run);
  server.registerTool('rars_session_list', {
    description: 'List isolated and connected live RARS sessions.',
    inputSchema: emptySchema,
  }, handlers.sessionList);
  server.registerTool('rars_session_close', {
    description: 'Close an isolated session or disconnect a live RARS session.',
    inputSchema: closeSessionSchema,
  }, handlers.sessionClose);
  server.registerTool('rars_debug_start', {
    description: 'Start an isolated stateful RARS debugger session for workspace files.', inputSchema: debugStartSchema,
  }, handlers.debugStart);
  server.registerTool('rars_debug_command', {
    description: 'Step, backstep, continue, pause, reset, terminate, or manage breakpoints.', inputSchema: debugCommandSchema,
  }, handlers.debugCommand);
  server.registerTool('rars_inspect', {
    description: 'Inspect registers, bounded memory, output, and state in a RARS session.', inputSchema: inspectSchema,
  }, handlers.inspect);
  server.registerTool('rars_modify', {
    description: 'Write registers or bounded memory in a RARS session.', inputSchema: modifySchema,
  }, handlers.modify);
  server.registerTool('rars_live_connect', {
    description: 'Discover and authenticate with the visible MCP-enabled RARS desktop session.', inputSchema: liveConnectSchema,
  }, handlers.liveConnect);
  server.registerTool('rars_live_command', {
    description: 'Load, inspect, modify, or drive the visible RARS desktop session. This mutates the open GUI.', inputSchema: liveCommandSchema,
  }, handlers.liveCommand);
  // A client that advertises roots tells us which folders it is working in, so the
  // workspace follows the client instead of the folder this server started in.
  server.server.oninitialized = () => {
    if (server.server.getClientCapabilities()?.roots === undefined) return;
    dependencies.workspace.useRootsProvider(async () => {
      const { roots } = await server.server.listRoots();
      return roots.filter((root) => root.uri.startsWith('file://')).map((root) => fileURLToPath(root.uri));
    });
  };
  server.server.setNotificationHandler(
    'notifications/roots/list_changed', () => dependencies.workspace.rootsChanged(),
  );

  return server;
}
