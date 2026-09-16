import { z } from 'zod';

export const assembleSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
});

export const runSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
  stdin: z.string().optional(),
  programArgs: z.array(z.string()).optional(),
  maxSteps: z.number().int().positive().optional(),
  registers: z.array(z.string()).optional(),
  memoryRanges: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const closeSessionSchema = z.object({ sessionId: z.string().uuid() });
export const emptySchema = z.object({});

export type AssembleInput = z.infer<typeof assembleSchema>;
export type RunInput = z.infer<typeof runSchema>;
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;
