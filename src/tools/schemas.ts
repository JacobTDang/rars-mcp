import { z } from 'zod';

export const dumpSchema = z.object({
  segment: z.string().regex(/^(?:\.text|\.data|0x[0-9a-fA-F]+-0x[0-9a-fA-F]+)$/),
  format: z.enum(['SegmentWindow', 'HexText', 'AsciiText', 'HEX', 'Binary', 'BinaryText']),
  file: z.string().min(1),
});

export const assembleSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  dump: z.array(dumpSchema).optional(),
});

export const runSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  stdin: z.string().optional(),
  programArgs: z.array(z.string()).optional(),
  maxSteps: z.number().int().positive().optional(),
  instructionCount: z.boolean().optional(),
  registers: z.array(z.string()).optional(),
  memoryRanges: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  dump: z.array(dumpSchema).optional(),
});

export const closeSessionSchema = z.object({ sessionId: z.string().uuid() });
export const emptySchema = z.object({});
export const debugStartSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  programArgs: z.array(z.string()).optional(),
  stdin: z.string().optional(),
});
const executionActions = ['step', 'backstep', 'continue', 'pause', 'reset', 'terminate'] as const;
const breakpointActions = ['breakpoint_add', 'breakpoint_remove'] as const;
export const isBreakpointAction = (action: string): action is typeof breakpointActions[number] =>
  (breakpointActions as readonly string[]).includes(action);
// Kept as one flat object: clients that require a plain top-level object schema
// flatten a top-level union and lose every variant but the first.
export const debugCommandSchema = z.object({
  sessionId: z.string().uuid(),
  action: z.enum([...executionActions, ...breakpointActions]),
  address: z.string().describe('Breakpoint location: an address, a code label, or file:line').optional(),
  maxSteps: z.number().int().positive().optional(),
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
export const inspectSchema = z.object({
  sessionId: z.string().uuid(),
  registers: z.array(z.string()).optional(),
  memory: z.array(z.object({ address: z.string(), length: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]) })).optional(),
  includeSymbols: z.boolean().optional(),
  includeInstructions: z.boolean().describe('Deprecated: returns every instruction in the program; use instructions instead').optional(),
  instructions: instructionWindowSchema
    .describe('A window of assembled instructions: { around, count } or { from, to }; {} is the 10 around pc').optional(),
}).superRefine((input, context) => {
  if (input.includeInstructions === true && input.instructions !== undefined) {
    context.addIssue({ code: 'custom', path: ['instructions'], message: 'includeInstructions and instructions cannot be combined' });
  }
});
export const modifySchema = z.object({
  sessionId: z.string().uuid(),
  registers: z.record(z.string(), z.string()).optional(),
  memory: z.array(z.object({
    address: z.string(), value: z.string(), width: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  })).optional(),
});
export const liveConnectSchema = z.object({});
const liveDebugCommand = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['step', 'backstep', 'continue', 'pause', 'reset', 'terminate']) }),
  z.object({ action: z.enum(['breakpoint_add', 'breakpoint_remove']), address: z.string() }),
]);
export const liveCommandSchema = z.object({
  sessionId: z.string().uuid(),
  command: z.union([
    liveDebugCommand,
    z.object({ action: z.literal('load'), files: z.array(z.string()).min(1), programArgs: z.array(z.string()).optional(), stdin: z.string().optional(), conflictPolicy: z.enum(['reject', 'discard']).default('reject') }),
    z.object({ action: z.literal('inspect'), registers: z.array(z.string()).optional(), memory: z.array(z.object({ address: z.string(), length: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]) })).optional() }),
    z.object({ action: z.literal('modify'), registers: z.record(z.string(), z.string()).optional(), memory: z.array(z.object({ address: z.string(), value: z.string(), width: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]) })).optional() }),
  ]),
});

export type AssembleInput = z.infer<typeof assembleSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;
export type DebugStartInput = z.infer<typeof debugStartSchema>;
export type DebugCommandInput = z.infer<typeof debugCommandSchema>;
export type InspectInput = z.infer<typeof inspectSchema>;
export type ModifyInput = z.infer<typeof modifySchema>;
export type LiveCommandInput = z.infer<typeof liveCommandSchema>;
