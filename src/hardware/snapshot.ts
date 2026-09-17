import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ResolvedProject, ResolvedTarget, SourceSnapshot, SourceSnapshotFile } from './types.js';

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function createSnapshot(
  project: ResolvedProject,
  target: ResolvedTarget,
  stateRoot: string,
): Promise<SourceSnapshot> {
  const id = randomUUID();
  const root = join(stateRoot, 'snapshots', id);
  await mkdir(root, { recursive: true });
  const files: SourceSnapshotFile[] = [];
  for (const path of [...target.sources].sort()) {
    const source = join(project.root, path);
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const contents = await readFile(destination);
    const sourceMode = (await stat(source)).mode;
    await chmod(destination, sourceMode & 0o111 ? 0o555 : 0o444);
    files.push({ path, size: contents.byteLength, sha256: sha256(contents) });
  }
  const aggregate = sha256(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join(''));
  const snapshot: SourceSnapshot = { id, root, sha256: aggregate, files, createdAt: new Date().toISOString() };
  await writeFile(join(root, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o444 });
  return snapshot;
}
