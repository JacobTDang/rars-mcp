import { z } from 'zod';

export const assembleSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
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
  address: z.string().optional(),
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
export const inspectSchema = z.object({
  sessionId: z.string().uuid(),
  registers: z.array(z.string()).optional(),
  memory: z.array(z.object({ address: z.string(), length: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]) })).optional(),
  includeSymbols: z.boolean().optional(),
  includeInstructions: z.boolean().optional(),
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
