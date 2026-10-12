import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DumpInput } from './schemas.js';

export interface ResolvedDump {
  input: DumpInput;
  segment: string;
}

export interface PreparedDumps {
  cli: Array<{ segment: string; format: string; file: string }>;
  read(inlineContents?: boolean): Promise<Array<Record<string, unknown>>>;
  cleanup(): Promise<void>;
}

const textFormats = new Set<DumpInput['format']>(['SegmentWindow', 'HexText', 'AsciiText', 'BinaryText']);

export async function prepareDumps(
  dumps: ResolvedDump[],
  resolveFile: (file: string) => Promise<string>,
): Promise<PreparedDumps> {
  const workspaceFiles = await Promise.all(dumps.map(
    ({ input }) => input.file === undefined ? undefined : resolveFile(input.file),
  ));
  const hasInline = workspaceFiles.some((file) => file === undefined);
  const directory = hasInline ? await mkdtemp(join(tmpdir(), 'rars-dumps-')) : undefined;
  const cli = dumps.map(({ input, segment }, index) => ({
    segment,
    format: input.format,
    file: workspaceFiles[index] ?? join(directory!, `dump-${index}`),
  }));
  return {
    cli,
    read: async (inlineContents = true) => Promise.all(dumps.map(async ({ input }, index) => {
      const file = workspaceFiles[index];
      if (file !== undefined) return { segment: input.segment, format: input.format, file };
      if (!inlineContents) return { segment: input.segment, format: input.format };
      const contents = await readFile(cli[index]!.file);
      if (!textFormats.has(input.format)) {
        return { segment: input.segment, format: input.format, bytesBase64: contents.toString('base64') };
      }
      const text = contents.toString('utf8');
      if (input.format !== 'HexText') return { segment: input.segment, format: input.format, text };
      const words = text.split(/\r?\n/).filter(Boolean).map((word) => `0x${word.trim().replace(/^0x/i, '')}`);
      return { segment: input.segment, format: input.format, text, words };
    })),
    cleanup: () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true }),
  };
}

export function addressRange(address: string, words: number): string {
  const low = BigInt(address);
  // RARS's dump CLI treats the upper address as exclusive, despite displaying ranges as lo-hi.
  const high = low + BigInt(words) * 4n;
  return `0x${low.toString(16)}-0x${high.toString(16)}`;
}
