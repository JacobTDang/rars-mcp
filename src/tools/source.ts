import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionBackend } from '../sessions/types.js';
import type { AssembleInput } from './schemas.js';

type Source = NonNullable<AssembleInput['source']>;

export interface PreparedSource {
  directory: string;
  files: string[];
  remapFile(file: string): string;
  remapText(text: string): string;
  cleanup(): Promise<void>;
}

export async function prepareSource(source: Source): Promise<PreparedSource> {
  const directory = await mkdtemp(join(tmpdir(), 'rars-inline-'));
  const canonicalDirectory = await realpath(directory);
  const entries = typeof source === 'string' ? [{ name: 'inline.s', text: source }] : source;
  const files = entries.map(({ name }) => join(directory, name));
  try {
    await Promise.all(entries.map(({ text }, index) => writeFile(files[index]!, text)));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const paths = entries.flatMap(({ name }, index) => [
    [files[index]!, name] as const,
    [join(canonicalDirectory, name), name] as const,
  ]);
  const namesByPath = new Map(paths);
  return {
    directory,
    files,
    remapFile: (file) => namesByPath.get(file) ?? file,
    remapText: (text) => paths.reduce((mapped, [file, name]) => mapped.replaceAll(file, name), text),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function withPreparedSource(target: SessionBackend, source: PreparedSource): SessionBackend {
  return {
    summary: () => target.summary(),
    command: (command) => target.command(command),
    inspect: async (request) => {
      const result = await target.inspect(request);
      if (result.instructions === undefined) return result;
      return {
        ...result,
        instructions: result.instructions.map((instruction) => {
          if (typeof instruction !== 'object' || instruction === null || !('file' in instruction)) return instruction;
          const file = (instruction as { file?: unknown }).file;
          return typeof file === 'string' ? { ...instruction, file: source.remapFile(file) } : instruction;
        }),
      };
    },
    modify: (request) => target.modify(request),
    onFailure: (listener) => target.onFailure(listener),
    close: async () => {
      try {
        await target.close();
      } finally {
        await source.cleanup();
      }
    },
  };
}
