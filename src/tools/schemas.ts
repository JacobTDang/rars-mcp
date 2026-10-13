import { z } from 'zod';

import { MAX_TIMER_MS } from '../config.js';
import { CLI_REGISTER_FORMS, memoryRangeProblem, registerProblem } from '../rars/cli.js';

// zod reports a union whose every option fails as just "Invalid input", which hides a misspelt key.
// A key none of these objects takes, in the input or in the objects of an input array, is named
// instead, as a strict object names it.
function unknownKeyError(...objects: Array<{ shape: Record<string, unknown> }>) {
  const known = new Set(objects.flatMap((object) => Object.keys(object.shape)));
  const isObject = (item: unknown): item is object => typeof item === 'object' && item !== null && !Array.isArray(item);
  return (issue: { input?: unknown }): string | undefined => {
    const items: unknown[] = Array.isArray(issue.input) ? issue.input : [issue.input];
    const unknown = [...new Set(items.filter(isObject).flatMap((item) => Object.keys(item)).filter((key) => !known.has(key)))];
    if (unknown.length === 0) return undefined;
    return `Unrecognized key${unknown.length === 1 ? '' : 's'}: ${unknown.map((key) => `"${key}"`).join(', ')}`;
  };
}

export const isWordAligned = (address: string): boolean => BigInt(address) % 4n === 0n;
// RARS refuses a dump range whose bounds are not 32-bit multiples of 4 and writes no file for it.
const requireDumpBounds = (value: string, context: z.RefinementCtx) => {
  for (const address of value.match(/0x[0-9a-f]+/gi) ?? []) {
    if (!isWordAligned(address)) context.addIssue({ code: 'custom', message: `dump address ${address} is not word aligned` });
    if (BigInt(address) > 0xffffffffn) context.addIssue({ code: 'custom', message: `dump address ${address} is past 0xffffffff` });
  }
};
const dumpWordsSchema = z.number().int().positive().max(65_536);
const labelSegmentSchema = z.strictObject({ label: z.string().min(1), words: dumpWordsSchema });
const addressSegmentSchema = z.strictObject({
  address: z.string().regex(/^0x[0-9a-fA-F]+$/).superRefine(requireDumpBounds), words: dumpWordsSchema,
});
const dumpSegmentSchema = z.union([
  z.string().regex(/^(?:\.text|\.data|0x[0-9a-fA-F]+-0x[0-9a-fA-F]+)$/).superRefine(requireDumpBounds),
  labelSegmentSchema,
  addressSegmentSchema,
], { error: unknownKeyError(labelSegmentSchema, addressSegmentSchema) });
export const dumpSchema = z.strictObject({
  segment: dumpSegmentSchema,
  format: z.enum(['SegmentWindow', 'HexText', 'AsciiText', 'HEX', 'Binary', 'BinaryText']),
  file: z.string().min(1).optional(),
});

const sourceFileSchema = z.strictObject({
  name: z.string().min(1).refine(
    (name) => name !== '.' && !name.includes('..') && !name.includes('/') && !name.includes('\\'),
    'source name must be a bare file name without path separators or ..',
  ),
  text: z.string(),
});
const sourceFilesSchema = z.array(sourceFileSchema).min(1).superRefine((files, context) => {
  const names = new Set<string>();
  files.forEach(({ name }, index) => {
    if (names.has(name)) {
      context.addIssue({ code: 'custom', path: [index, 'name'], message: 'source names must be unique' });
    }
    names.add(name);
  });
});
const sourceSchema = z.union([z.string(), sourceFilesSchema], { error: unknownKeyError(sourceFileSchema) });
const sourceSelection = {
  files: z.array(z.string().min(1)).min(1).optional(),
  source: sourceSchema.optional(),
};
const validateSourceSelection = (
  input: { files?: string[] | undefined; source?: z.infer<typeof sourceSchema> | undefined },
  context: z.RefinementCtx,
) => {
  if (input.files !== undefined && input.source !== undefined) {
    context.addIssue({ code: 'custom', message: 'files and source are mutually exclusive' });
  } else if (input.files === undefined && input.source === undefined) {
    context.addIssue({ code: 'custom', message: 'Either files or source is required' });
  }
};

export const assembleSchema = z.strictObject({
  ...sourceSelection,
  dump: z.array(dumpSchema).optional(),
}).superRefine(validateSourceSelection);

export const timeoutMsSchema = z.number().int().positive()
  .max(MAX_TIMER_MS, `must be at most ${MAX_TIMER_MS} ms, the longest delay a Node timer takes`);
// RARS and the bridge read a step count as a Java int.
const MAX_STEPS = 2_147_483_647;
const maxStepsSchema = z.number().int().positive().max(MAX_STEPS, `must be at most ${MAX_STEPS}, the largest step count RARS takes`);

// A string the check passes; otherwise the check's message, which names the entry, is the issue.
const checkedString = (problem: (value: string) => string | undefined) => z.string().superRefine((value, context) => {
  const message = problem(value);
  if (message !== undefined) context.addIssue({ code: 'custom', message });
});

export const runSchema = z.strictObject({
  ...sourceSelection,
  stdin: z.string().optional(),
  programArgs: z.array(z.string()).optional(),
  maxSteps: maxStepsSchema.optional(),
  instructionCount: z.boolean().optional(),
  registers: z.array(checkedString(registerProblem))
    .describe(`Registers to print after the run: ${CLI_REGISTER_FORMS}. Read pc with rars_inspect`).optional(),
  memoryRanges: z.array(checkedString(memoryRangeProblem))
    .describe('Word-aligned address ranges to print after the run, both ends included, such as 0x10010000-0x1001000c').optional(),
  timeoutMs: timeoutMsSchema.optional(),
  dump: z.array(dumpSchema).optional(),
}).superRefine(validateSourceSelection);

export const closeSessionSchema = z.strictObject({ sessionId: z.string().uuid() });
export const emptySchema = z.strictObject({});
export const debugStartSchema = z.strictObject({
  ...sourceSelection,
  programArgs: z.array(z.string()).optional(),
  stdin: z.string().optional(),
}).superRefine(validateSourceSelection);
const executionActions = ['step', 'backstep', 'continue', 'pause', 'reset', 'terminate'] as const;
const breakpointActions = ['breakpoint_add', 'breakpoint_remove'] as const;
export const isBreakpointAction = (action: string): action is typeof breakpointActions[number] =>
  (breakpointActions as readonly string[]).includes(action);
// Kept as one flat object: clients that require a plain top-level object schema
// flatten a top-level union and lose every variant but the first.
export const debugCommandSchema = z.strictObject({
  sessionId: z.string().uuid(),
  action: z.enum([...executionActions, ...breakpointActions]),
  address: z.string().describe('Breakpoint location: an address, a code label, or file:line').optional(),
  maxSteps: maxStepsSchema.optional(),
}).superRefine((input, context) => {
  if (input.action !== 'continue' && input.maxSteps !== undefined) {
    context.addIssue({ code: 'custom', path: ['maxSteps'], message: 'maxSteps is only valid for continue' });
  }
  if (isBreakpointAction(input.action) && input.address === undefined) {
    context.addIssue({ code: 'custom', path: ['address'], message: `address is required for ${input.action}` });
  }
  if (!isBreakpointAction(input.action) && input.address !== undefined) {
    context.addIssue({ code: 'custom', path: ['address'], message: 'address is only valid for breakpoint_add and breakpoint_remove' });
  }
});
const maxInstructionWindow = 200;
const windowLocation = 'pc, a code label, an address, or file:line';
// Flat like debugCommandSchema, so every client sees all four fields; the refinement allows one form.
const instructionWindowSchema = z.strictObject({
  around: z.string().min(1).describe(`Centre of the window: ${windowLocation}. Defaults to pc; when pc has no `
    + 'instruction, as after the program exits, the window ends at the last instruction before it').optional(),
  count: z.number().int().min(1).max(maxInstructionWindow)
    .describe(`Instructions in the window around the centre, 10 by default and at most ${maxInstructionWindow}`).optional(),
  from: z.string().min(1).describe(`Start of an inclusive range, given with to: ${windowLocation}`).optional(),
  to: z.string().min(1).describe(`End of an inclusive range of at most ${maxInstructionWindow} instructions, given with from`).optional(),
}).superRefine((window, context) => {
  const range = window.from !== undefined || window.to !== undefined;
  if (range && (window.from === undefined || window.to === undefined || window.around !== undefined || window.count !== undefined)) {
    context.addIssue({ code: 'custom', message: 'instructions takes around and count, or both from and to' });
  }
});
const byteWidthSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]);
const memoryReadSchema = z.strictObject({ address: z.string(), length: byteWidthSchema });
const memoryWriteSchema = z.strictObject({ address: z.string(), value: z.string(), width: byteWidthSchema });
export const inspectSchema = z.strictObject({
  sessionId: z.string().uuid(),
  registers: z.array(z.string()).optional(),
  memory: z.array(memoryReadSchema).optional(),
  includeSymbols: z.boolean().optional(),
  includeInstructions: z.boolean().describe('Deprecated: returns every instruction in the program; use instructions instead').optional(),
  instructions: instructionWindowSchema
    .describe('A window of assembled instructions: { around, count } or { from, to }; {} is the 10 around pc').optional(),
}).superRefine((input, context) => {
  if (input.includeInstructions === true && input.instructions !== undefined) {
    context.addIssue({ code: 'custom', path: ['instructions'], message: 'includeInstructions and instructions cannot be combined' });
  }
});
export const modifySchema = z.strictObject({
  sessionId: z.string().uuid(),
  registers: z.record(z.string(), z.string()).optional(),
  memory: z.array(memoryWriteSchema).optional(),
});
export const liveConnectSchema = z.strictObject({});
// One discriminated union, so a command is checked against the variant its action names and a
// misspelt key is reported as such, not as a failure to match any variant.
export const liveCommandSchema = z.strictObject({
  sessionId: z.string().uuid(),
  command: z.discriminatedUnion('action', [
    z.strictObject({ action: z.enum(executionActions) }),
    z.strictObject({ action: z.enum(breakpointActions), address: z.string() }),
    z.strictObject({ action: z.literal('load'), files: z.array(z.string()).min(1), programArgs: z.array(z.string()).optional(), stdin: z.string().optional(), conflictPolicy: z.enum(['reject', 'discard']).default('reject') }),
    z.strictObject({ action: z.literal('inspect'), registers: z.array(z.string()).optional(), memory: z.array(memoryReadSchema).optional() }),
    z.strictObject({ action: z.literal('modify'), registers: z.record(z.string(), z.string()).optional(), memory: z.array(memoryWriteSchema).optional() }),
  ]),
});

export type AssembleInput = z.infer<typeof assembleSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type DumpInput = z.infer<typeof dumpSchema>;
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;
export type DebugStartInput = z.infer<typeof debugStartSchema>;
export type DebugCommandInput = z.infer<typeof debugCommandSchema>;
export type InspectInput = z.infer<typeof inspectSchema>;
export type ModifyInput = z.infer<typeof modifySchema>;
export type LiveCommandInput = z.infer<typeof liveCommandSchema>;
