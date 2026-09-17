import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { RarsError } from '../errors.js';
import type { ArtifactRecord } from './types.js';

const mediaTypes: Record<string, { type: string; mediaType: string }> = {
  '.vcd': { type: 'waveform', mediaType: 'application/vnd.verilog.vcd' },
  '.fst': { type: 'waveform', mediaType: 'application/vnd.gtkwave.fst' },
  '.ghw': { type: 'waveform', mediaType: 'application/vnd.ghdl.ghw' },
  '.json': { type: 'report', mediaType: 'application/json' },
  '.log': { type: 'log', mediaType: 'text/plain' },
};

async function walk(root: string, directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new RarsError('ARTIFACT_CORRUPT', `Artifact symbolic link is not allowed: ${relative(root, path)}`, {});
    if (entry.isDirectory()) paths.push(...await walk(root, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

export async function finalizeArtifacts(jobId: string, artifactRoot: string, maxBytes: number): Promise<ArtifactRecord[]> {
  const paths = (await walk(artifactRoot, artifactRoot)).sort();
  let total = 0;
  const artifacts: ArtifactRecord[] = [];
  for (const path of paths) {
    const stat = await lstat(path);
    total += stat.size;
    if (total > maxBytes) {
      throw new RarsError('ARTIFACT_LIMIT_EXCEEDED', 'Artifacts exceed the configured byte limit', { total, maximum: maxBytes });
    }
    const contents = await readFile(path);
    const relativePath = relative(artifactRoot, path).split(sep).join('/');
    const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase();
    const kind = mediaTypes[extension] ?? { type: 'binary', mediaType: 'application/octet-stream' };
    artifacts.push({
      id: randomUUID(), jobId, type: kind.type, path: relativePath, mediaType: kind.mediaType,
      size: stat.size, sha256: createHash('sha256').update(contents).digest('hex'),
      createdAt: new Date(stat.mtimeMs).toISOString(), retention: 'active',
    });
    await chmod(path, 0o444);
  }
  return artifacts;
}
