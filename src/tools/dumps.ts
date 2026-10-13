import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DumpInput } from './schemas.js';

export interface ResolvedDump {
  input: DumpInput;
  segment: string;
}

export interface PreparedDumps {
  cli: Array<{ segment: string; format: string; file: string }>;
  // Each dump RARS wrote no file for, as dump[index] (segment).
  unwritten(): Promise<string[]>;
  // Replaces each temporary dump path with dump[index], the dump's place in the request.
  remapText(text: string): string;
  // Each dump's segment and format, with the workspace file or, when inlineContents is set, the contents
  // of each inline dump RARS wrote.
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
    // The .out ending keeps the path of dump-1 from matching inside dump-10 in remapText.
    file: workspaceFiles[index] ?? join(directory!, `dump-${index}.out`),
  }));
  const written = () => Promise.all(cli.map(({ file }) => access(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })));
  return {
    cli,
    unwritten: async () => {
      const wrote = await written();
      return cli.flatMap(({ segment }, index) => wrote[index] ? [] : [`dump[${index}] (${segment})`]);
    },
    remapText: (text) => cli.reduce(
      (mapped, { file }, index) => workspaceFiles[index] === undefined ? mapped.replaceAll(file, `dump[${index}]`) : mapped,
      text,
    ),
    read: async (inlineContents = true) => {
      const wrote = inlineContents ? await written() : [];
      return Promise.all(dumps.map(async ({ input }, index) => {
        const file = workspaceFiles[index];
        if (file !== undefined) return { segment: input.segment, format: input.format, file };
        if (!wrote[index]) return { segment: input.segment, format: input.format };
        return { segment: input.segment, format: input.format, ...dumpContents(input.format, await readFile(cli[index]!.file)) };
      }));
    },
    cleanup: () => directory === undefined ? Promise.resolve() : rm(directory, { recursive: true, force: true }),
  };
}

// Text formats as text, HexText also as 0x words, and binary formats as base64.
function dumpContents(format: DumpInput['format'], contents: Buffer): Record<string, unknown> {
  if (!textFormats.has(format)) return { bytesBase64: contents.toString('base64') };
  const text = contents.toString('utf8');
  if (format !== 'HexText') return { text };
  return { text, words: text.split(/\r?\n/).filter(Boolean).map((word) => `0x${word.trim().replace(/^0x/i, '')}`) };
}

export function addressRange(address: string, words: number): string {
  const low = BigInt(address);
  // RARS's dump CLI treats the upper address as exclusive, despite displaying ranges as lo-hi.
  const high = low + BigInt(words) * 4n;
  const range = `0x${low.toString(16)}-0x${high.toString(16)}`;
  // RARS takes 32-bit bounds, so it refuses an end past 0xffffffff and writes no file.
  if (high > 0xffffffffn) throw new Error(`dump range ${range} ends past 0xffffffff`);
  return range;
}
