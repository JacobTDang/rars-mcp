import { z } from 'zod';

export const hardwareCapabilitiesSchema = z.object({});
export const hardwareProjectValidateSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1).optional() });
export const hardwareJobStartSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1), parentJobId: z.string().uuid().optional() });
export const hardwareJobIdSchema = z.object({ jobId: z.string().uuid() });
export const hardwareJobLogsSchema = hardwareJobIdSchema.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(65_536).default(8192) });
export const hardwareWaveQuerySchema = hardwareJobIdSchema.extend({
  artifactId: z.string().uuid(), operation: z.enum(['hierarchy', 'signals', 'value_at', 'transitions', 'first_edge', 'first_unknown', 'pulse_widths', 'compare']),
  signal: z.string().optional(), otherSignal: z.string().optional(), startTime: z.number().nonnegative().optional(), endTime: z.number().nonnegative().optional(), limit: z.number().int().positive().max(10_000).default(1000), cursor: z.number().int().nonnegative().default(0), maxResponseBytes: z.number().int().min(256).max(1_048_576).default(262_144),
});
const traceSideSchema = z.object({ jobId: z.string().uuid(), artifactId: z.string().uuid(), format: z.enum(['normalized', 'rvfi', 'rars']) });
export const hardwareTraceCompareSchema = z.object({
  left: traceSideSchema, right: traceSideSchema, context: z.number().int().nonnegative().max(20).default(3),
  policy: z.object({ compareRegisters: z.boolean().optional(), compareMemory: z.boolean().optional(), compareTraps: z.boolean().optional(), comparePrivilege: z.boolean().optional(), ignoreX0Writes: z.boolean().optional() }).strict().default({}),
});
export const hardwareRiscvGenerateSchema = z.object({ seed: z.number().int(), instructionCount: z.number().int().positive().max(10_000).default(100) });
