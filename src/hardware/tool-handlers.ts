import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { HardwareClient } from './client.js';
import type { hardwareJobIdSchema, hardwareJobLogsSchema, hardwareJobStartSchema, hardwareProjectValidateSchema, hardwareRiscvGenerateSchema, hardwareTraceCompareSchema, hardwareWaveQuerySchema } from './tool-schemas.js';

type ValidateInput = z.infer<typeof hardwareProjectValidateSchema>;
type StartInput = z.infer<typeof hardwareJobStartSchema>;
type IdInput = z.infer<typeof hardwareJobIdSchema>;
type LogsInput = z.infer<typeof hardwareJobLogsSchema>;
type WaveInput = z.infer<typeof hardwareWaveQuerySchema>;
type TraceInput = z.infer<typeof hardwareTraceCompareSchema>;
type GenerateInput = z.infer<typeof hardwareRiscvGenerateSchema>;

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

export function createHardwareToolHandlers(client: HardwareClient | undefined) {
  const required = (): HardwareClient => {
    if (!client) throw new Error('Hardware harness is not enabled');
    return client;
  };
  return {
    capabilities: async (_input: Record<string, never> = {}) => result('Listed hardware capabilities', await required().capabilities()),
    projectValidate: async (input: ValidateInput) => result('Validated hardware project', await required().validate({ manifestPath: input.manifestPath, ...(input.target === undefined ? {} : { target: input.target }) })),
    jobStart: async (input: StartInput) => { const value = await required().start({ manifestPath: input.manifestPath, target: input.target, ...(input.parentJobId === undefined ? {} : { parentJobId: input.parentJobId }) }); return result(`Started hardware job ${String(value.id)}`, value); },
    jobStatus: async (input: IdInput) => result(`Read hardware job ${input.jobId}`, await required().status(input.jobId)),
    jobCancel: async (input: IdInput) => result(`Cancelled hardware job ${input.jobId}`, await required().cancel(input.jobId)),
    jobLogs: async (input: LogsInput) => result(`Read logs for hardware job ${input.jobId}`, await required().logs(input.jobId, input.offset, input.limit)),
    artifactList: async (input: IdInput) => result(`Listed artifacts for hardware job ${input.jobId}`, await required().artifacts(input.jobId)),
    waveQuery: async (input: WaveInput) => { const { jobId, ...query } = input; return result(`Queried waveform for hardware job ${jobId}`, await required().wave(jobId, query)); },
    traceCompare: async (input: TraceInput) => result('Compared architectural retirement traces', await required().traceCompare(input)),
    riscvGenerate: async (input: GenerateInput) => result(`Generated deterministic RISC-V program with seed ${input.seed}`, await required().riscvGenerate(input)),
  };
}
