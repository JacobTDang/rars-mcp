import { z } from 'zod';

export const hardwareCapabilitiesSchema = z.object({});
export const hardwareProjectValidateSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1).optional() });
export const hardwareJobStartSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1), parentJobId: z.string().uuid().optional() });
export const hardwareJobIdSchema = z.object({ jobId: z.string().uuid() });
export const hardwareJobLogsSchema = hardwareJobIdSchema.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(65_536).default(8192) });
export const hardwareWaveQuerySchema = hardwareJobIdSchema.extend({
  artifactId: z.string().uuid(), operation: z.enum(['hierarchy', 'signals', 'value_at', 'transitions', 'first_edge', 'first_unknown', 'pulse_widths', 'compare']),
  signal: z.string().optional(), otherSignal: z.string().optional(), startTime: z.number().nonnegative().optional(), endTime: z.number().nonnegative().optional(), limit: z.number().int().positive().max(10_000).default(1000), cursor: z.number().int().nonnegative().default(0),
});
