import { McpServer } from '@modelcontextprotocol/server';

import { createToolHandlers, type ToolDependencies } from './tools/handlers.js';
import { assembleSchema, closeSessionSchema, debugCommandSchema, debugStartSchema, emptySchema, inspectSchema, liveCommandSchema, liveConnectSchema, modifySchema, runSchema } from './tools/schemas.js';
import { createHardwareToolHandlers } from './hardware/tool-handlers.js';
import { hardwareCapabilitiesSchema, hardwareJobIdSchema, hardwareJobLogsSchema, hardwareJobStartSchema, hardwareProjectValidateSchema, hardwareRiscvGenerateSchema, hardwareTraceCompareSchema, hardwareWaveQuerySchema } from './hardware/tool-schemas.js';

export function createMcpServer(dependencies: ToolDependencies): McpServer {
  const handlers = createToolHandlers(dependencies);
  const hardware = createHardwareToolHandlers(dependencies.hardwareClient);
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
  server.registerTool('hardware_capabilities', { description: 'List installed hardware providers, versions, actions, formats, and limits.', inputSchema: hardwareCapabilitiesSchema }, hardware.capabilities);
  server.registerTool('hardware_project_validate', { description: 'Validate a hardware project manifest and resolved source set without execution.', inputSchema: hardwareProjectValidateSchema }, hardware.projectValidate);
  server.registerTool('hardware_job_start', { description: 'Start an asynchronous hardware compile, simulation, test, or course-flow job.', inputSchema: hardwareJobStartSchema }, hardware.jobStart);
  server.registerTool('hardware_job_status', { description: 'Read persistent hardware job state and result metadata.', inputSchema: hardwareJobIdSchema }, hardware.jobStatus);
  server.registerTool('hardware_job_cancel', { description: 'Cancel a queued or running hardware job.', inputSchema: hardwareJobIdSchema }, hardware.jobCancel);
  server.registerTool('hardware_job_logs', { description: 'Read a bounded byte window from hardware job logs.', inputSchema: hardwareJobLogsSchema }, hardware.jobLogs);
  server.registerTool('hardware_artifact_list', { description: 'List immutable artifacts produced by a hardware job.', inputSchema: hardwareJobIdSchema }, hardware.artifactList);
  server.registerTool('hardware_wave_query', { description: 'Run a bounded hierarchy, value, transition, edge, unknown, pulse, or comparison query on a waveform artifact.', inputSchema: hardwareWaveQuerySchema }, hardware.waveQuery);
  server.registerTool('hardware_trace_compare', { description: 'Normalize and compare RARS, RVFI, or canonical retirement traces and return the first divergence with cycle hints.', inputSchema: hardwareTraceCompareSchema }, hardware.traceCompare);
  server.registerTool('hardware_riscv_generate', { description: 'Generate a deterministic seeded RISC-V assembly test program.', inputSchema: hardwareRiscvGenerateSchema }, hardware.riscvGenerate);
  return server;
}
