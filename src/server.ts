import { McpServer } from '@modelcontextprotocol/server';

import { createDoFileCheckHandler, doFileCheckSchema } from './tools/dofile.js';
import { createEncodeHandler, encodeSchema } from './tools/encode.js';
import { createEvalHandler, evalSchema } from './tools/eval.js';
import { createToolHandlers, type ToolDependencies } from './tools/handlers.js';
import { createVhdlMutateHandler, vhdlMutateSchema } from './tools/mutate.js';
import { createStatusHandler, statusSchema } from './tools/status.js';
import { createVhdlHandlers, vhdlCompileSchema, vhdlRunSchema } from './tools/vhdl.js';
import { assembleSchema, closeSessionSchema, debugCommandSchema, debugStartSchema, emptySchema, inspectSchema, liveCommandSchema, liveConnectSchema, modifySchema, runSchema } from './tools/schemas.js';
import { createWaveQuery, waveQuerySchema } from './tools/wave.js';

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
    description: 'Run RISC-V source files in an isolated headless RARS process. '
      + 'instructionCount is RARS\'s ic count, which excludes the final exit ecall.',
    inputSchema: runSchema,
  }, handlers.run);
  server.registerTool('rars_eval', {
    description: 'Run RV32I/M ALU cases through RARS and return each rd, optionally as a VHDL testbench table.',
    inputSchema: evalSchema,
  }, createEvalHandler(dependencies));
  server.registerTool('rars_session_list', {
    description: 'List isolated and connected live RARS sessions.',
    inputSchema: emptySchema,
  }, handlers.sessionList);
  server.registerTool('rars_session_close', {
    description: 'Close an isolated session or disconnect a live RARS session.',
    inputSchema: closeSessionSchema,
  }, handlers.sessionClose);
  server.registerTool('rars_status', {
    description: 'Report the RARS and Java versions, bridge, workspace folders, open sessions, and the tclsh and VHDL simulator '
      + 'the VHDL tools use, without running a program.',
    inputSchema: statusSchema,
  }, createStatusHandler(dependencies));
  server.registerTool('rars_debug_start', {
    description: 'Start an isolated stateful RARS debugger session for workspace files.', inputSchema: debugStartSchema,
  }, handlers.debugStart);
  server.registerTool('rars_debug_command', {
    description: 'Step, backstep, continue, pause, reset, terminate, or manage breakpoints. A pause stops a continue that is still running.',
    inputSchema: debugCommandSchema,
  }, handlers.debugCommand);
  server.registerTool('rars_inspect', {
    description: 'Inspect registers, bounded memory, state, and the program output written since the previous reply in a RARS session.',
    inputSchema: inspectSchema,
  }, handlers.inspect);
  server.registerTool('rars_modify', {
    description: 'Write registers or bounded memory in a RARS session.', inputSchema: modifySchema,
  }, handlers.modify);
  server.registerTool('rars_encode', {
    description: 'Encode RISC-V instructions with RARS: each word in hex with its format (R, R4, I, S, B, U, J) and fields.', inputSchema: encodeSchema,
  }, createEncodeHandler(dependencies));
  server.registerTool('rars_live_connect', {
    description: 'Discover and authenticate with the visible MCP-enabled RARS desktop session.', inputSchema: liveConnectSchema,
  }, handlers.liveConnect);
  server.registerTool('rars_live_command', {
    description: 'Load, inspect, modify, or drive the visible RARS desktop session. This mutates the open GUI.', inputSchema: liveCommandSchema,
  }, handlers.liveCommand);
  server.registerTool('wave_query', {
    description: 'Read signal values at given times from a VCD or FST waveform file in the workspace.', inputSchema: waveQuerySchema,
  }, createWaveQuery(dependencies));
  server.registerTool('do_file_check', {
    description: 'Dry-run a Questa or ModelSim .do script with stubbed commands: what it compiles, in what order, and which files are missing.',
    inputSchema: doFileCheckSchema,
  }, createDoFileCheckHandler(dependencies));
  const vhdl = createVhdlHandlers(dependencies);
  server.registerTool('vhdl_compile', {
    description: 'Analyse VHDL files with nvc and return diagnostics with file, line and column.', inputSchema: vhdlCompileSchema,
  }, vhdl.compile);
  server.registerTool('vhdl_run', {
    description: 'Analyse, elaborate and run a VHDL testbench with nvc; returns each report and assertion with its simulation time.',
    inputSchema: vhdlRunSchema,
  }, vhdl.run);
  server.registerTool('vhdl_mutate', {
    description: 'Score VHDL testbenches: run them against mutated copies of a design and report which mutations each one catches.',
    inputSchema: vhdlMutateSchema,
  }, createVhdlMutateHandler(dependencies));
  // A client that advertises roots tells us which folders it is working in, so the
  // workspace follows the client instead of the folder this server started in.
  server.server.oninitialized = () => {
    if (server.server.getClientCapabilities()?.roots === undefined) return;
    dependencies.workspace.useRootsProvider(async () => (await server.server.listRoots()).roots.map((root) => root.uri));
  };
  server.server.setNotificationHandler(
    'notifications/roots/list_changed', () => dependencies.workspace.rootsChanged(),
  );

  return server;
}
