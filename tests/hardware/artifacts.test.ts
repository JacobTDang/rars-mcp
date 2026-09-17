import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { finalizeArtifacts } from '../../src/hardware/artifacts.js';

describe('hardware artifacts', () => {
  it('returns sorted immutable metadata with hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifacts-'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'wave.fst'), 'wave');
    await writeFile(join(root, 'nested', 'report.json'), '{}');
    const artifacts = await finalizeArtifacts('job', root, 1024);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(['nested/report.json', 'wave.fst']);
    expect(artifacts[0]).toMatchObject({ jobId: 'job', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), retention: 'active' });
  });

  it('rejects symlinks and aggregate size overflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifacts-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'artifact-outside-')), 'secret');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'escape'));
    await expect(finalizeArtifacts('job', root, 1024)).rejects.toThrow(/symbolic link/i);
    const large = await mkdtemp(join(tmpdir(), 'artifacts-'));
    await writeFile(join(large, 'large.bin'), 'x'.repeat(100));
    await expect(finalizeArtifacts('job', large, 10)).rejects.toMatchObject({ code: 'ARTIFACT_LIMIT_EXCEEDED' });
  });
});
