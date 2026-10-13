import { z } from 'zod';

import { HeadlessSession } from '../sessions/headless.js';
import type { ToolDependencies, ToolResult } from './handlers.js';

const maxInstructions = 200;

export const encodeSchema = z.strictObject({
  instructions: z.array(z.string().min(1, 'An instruction cannot be empty').regex(/^[^\r\n]*$/, 'An instruction must fit on one line'))
    .min(1).max(maxInstructions)
    .describe(`Up to ${maxInstructions} assembly instructions, assembled one after another as one program, so a label on `
      + 'one can be used by another. Pseudo-instructions expand to their basic instructions. A number as a branch or '
      + 'jump target is a byte offset from the instruction: beq x1, x2, -8'),
});

export type EncodeInput = z.infer<typeof encodeSchema>;

export function createEncodeHandler(deps: ToolDependencies) {
  return async (input: EncodeInput): Promise<ToolResult> => {
    if (!deps.bridgeJar || !deps.bridgeToken) throw new Error('rars_encode needs the RARS bridge, which is not configured');
    const instructions = await HeadlessSession.encode({
      javaExecutable: deps.javaExecutable, bridgeJar: deps.bridgeJar, rarsJar: deps.rarsJar,
      token: deps.bridgeToken, timeoutMs: deps.timeoutMs,
    }, input.instructions);
    const failures = instructions.flatMap((entry) => 'error' in entry ? [`${entry.source}: ${entry.error}`] : []);
    const encoded = instructions.length - failures.length;
    const summary = encoded === 0 ? 'No instruction encoded' : `Encoded ${encoded} of ${instructions.length} instructions`;
    return {
      content: [{ type: 'text', text: [summary, ...failures].join('\n') }],
      structuredContent: { instructions },
      ...(encoded === 0 ? { isError: true } : {}),
    };
  };
}
