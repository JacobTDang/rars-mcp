import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { HardwareClient } from './client.js';
import type { hardwareJobIdSchema, hardwareJobLogsSchema, hardwareJobStartSchema, hardwareProjectValidateSchema } from './tool-schemas.js';

type ValidateInput = z.infer<typeof hardwareProjectValidateSchema>;
type StartInput = z.infer<typeof hardwareJobStartSchema>;
type IdInput = z.infer<typeof hardwareJobIdSchema>;
type LogsInput = z.infer<typeof hardwareJobLogsSchema>;

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
  };
}
