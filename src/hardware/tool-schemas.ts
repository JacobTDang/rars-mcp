import { z } from 'zod';

export const hardwareCapabilitiesSchema = z.object({});
export const hardwareProjectValidateSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1).optional() });
export const hardwareJobStartSchema = z.object({ manifestPath: z.string().min(1), target: z.string().min(1), parentJobId: z.string().uuid().optional() });
export const hardwareJobIdSchema = z.object({ jobId: z.string().uuid() });
export const hardwareJobLogsSchema = hardwareJobIdSchema.extend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(65_536).default(8192) });
