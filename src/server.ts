import { McpServer } from '@modelcontextprotocol/server';

import { createToolHandlers, type ToolDependencies } from './tools/handlers.js';
import { assembleSchema, closeSessionSchema, emptySchema, runSchema } from './tools/schemas.js';

export function createMcpServer(dependencies: ToolDependencies): McpServer {
  const handlers = createToolHandlers(dependencies);
  const server = new McpServer(
    { name: 'rars-mcp', version: '0.1.0' },
    { instructions: 'All file paths are relative to the configured workspace. Headless calls are isolated.' },
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
  return server;
}
