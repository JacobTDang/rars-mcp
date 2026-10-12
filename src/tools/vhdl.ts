import { extname } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { VhdlCompileResult, VhdlDiagnostic, VhdlMessage, VhdlSimulator } from '../vhdl/simulator.js';
import type { Workspace } from '../workspace.js';

// A basic VHDL identifier. It also keeps option-like values such as "-rf" off the simulator's command line.
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be a VHDL identifier');
const files = z.array(z.string().min(1)).min(1)
  .describe('VHDL files, analysed in this order: packages and entities before the units that use them');
// A literal list rather than z.enum, which would reorder these number-like keys and list 19 first.
const std = z.literal(['93', '02', '08', '19']).describe("VHDL standard, 08 by default; 02 matches Questa's default").optional();
const work = identifier.describe('Library the files are analysed into, work by default').optional();

export const vhdlCompileSchema = z.object({ files, std, work });

export const vhdlRunSchema = z.object({
  testbench: identifier.describe('Top-level entity to elaborate and run'),
  files,
  std,
  work,
  stopTime: z.string().regex(/^\s*\d+\s*(?:fs|ps|ns|us|ms|sec)\s*$/, 'must be a whole number and a unit: fs, ps, ns, us, ms or sec')
    .describe('Simulation time to stop at, such as "1 us"; without it the run lasts until no events remain').optional(),
  generics: z.record(identifier, z.string().min(1)).describe('Values for the testbench generics, such as { "WIDTH": "8" }').optional(),
  wave: z.object({
    file: z.string().min(1).describe('Workspace file to write; its folder must already exist'),
    format: z.enum(['vcd', 'fst']).describe('vcd unless the file name ends in .fst').optional(),
  }).describe('Write a waveform of the run to a workspace file').optional(),
});

export type VhdlCompileInput = z.infer<typeof vhdlCompileSchema>;
export type VhdlRunInput = z.infer<typeof vhdlRunSchema>;

export interface VhdlToolDependencies {
  workspace: Workspace;
  vhdl?: VhdlSimulator;
  timeoutMs: number;
  maxOutputBytes: number;
}

function formatDiagnostic({ severity, file, line, column, message }: VhdlDiagnostic): string {
  const location = [file, line, column].filter((part) => part !== undefined).join(':');
  return `${location === '' ? '' : `${location}: `}${severity}: ${message}`;
}

function formatMessage({ time, severity, text, source }: VhdlMessage): string {
  const location = source === undefined ? '' : `${source.file}:${source.line}:${source.column}: `;
  return `${location}${severity} at ${time}: ${text}`;
}

function reply(
  action: string, passed: string, result: VhdlCompileResult & { messages?: VhdlMessage[] }, extra: Record<string, unknown> = {},
): CallToolResult {
  const messages = (result.messages ?? []).filter((message) => message.severity !== 'note');
  const details = [...result.diagnostics.map(formatDiagnostic), ...messages.map(formatMessage)];
  const explained = result.timedOut || result.truncated ||
    result.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
    messages.some((message) => message.severity !== 'warning');
  // A crash prints nothing the parser recognises, so the raw output stands in for the details.
  if (!result.ok && !explained && result.stderr.trim() !== '') details.push(result.stderr.trim());
  const summary = result.timedOut ? `${action} timed out` :
    result.truncated ? `${action} output exceeded its limit` :
    result.ok ? passed : `${action} failed`;
  return {
    content: [{ type: 'text', text: [summary, ...details].join('\n') }],
    structuredContent: { ...result, ...extra },
    ...(result.ok ? {} : { isError: true }),
  };
}

export function createVhdlHandlers(deps: VhdlToolDependencies) {
  const simulator = (): VhdlSimulator => {
    if (deps.vhdl === undefined) throw new Error('VHDL simulator is not configured');
    return deps.vhdl;
  };
  const resolveFiles = (paths: string[]) => Promise.all(paths.map((path) => deps.workspace.resolve(path)));
  const limits = () => ({ timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes });

  return {
    // Parsed again here because a direct handler call does not pass through the tool schema.
    compile: async (rawInput: VhdlCompileInput): Promise<CallToolResult> => {
      const input = vhdlCompileSchema.parse(rawInput);
      const vhdl = simulator();
      const result = await vhdl.compile({
        files: await resolveFiles(input.files), std: input.std ?? '08', work: input.work ?? 'work',
      }, limits());
      return reply('Analysis', 'Analysis completed', result);
    },
    run: async (rawInput: VhdlRunInput): Promise<CallToolResult> => {
      const input = vhdlRunSchema.parse(rawInput);
      const vhdl = simulator();
      const wave = input.wave === undefined ? undefined : {
        file: await deps.workspace.resolve(input.wave.file, { allowMissing: true }),
        format: input.wave.format ?? (extname(input.wave.file).toLowerCase() === '.fst' ? 'fst' as const : 'vcd' as const),
      };
      const result = await vhdl.run({
        files: await resolveFiles(input.files),
        std: input.std ?? '08',
        work: input.work ?? 'work',
        testbench: input.testbench,
        ...(input.stopTime === undefined ? {} : { stopTime: input.stopTime }),
        ...(input.generics === undefined ? {} : { generics: input.generics }),
        ...(wave === undefined ? {} : { wave }),
      }, limits());
      return reply('Simulation', 'Simulation passed', result, wave === undefined ? {} : { wave });
    },
  };
}
