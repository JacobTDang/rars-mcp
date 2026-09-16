import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSnapshot } from '../../src/hardware/snapshot.js';
import type { ResolvedProject } from '../../src/hardware/types.js';

describe('hardware source snapshots', () => {
  it('copies deterministic read-only files and hashes their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-source-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'snapshot-state-'));
    await writeFile(join(root, 'b.sv'), 'module b; endmodule\n');
    await writeFile(join(root, 'a.sv'), 'module a; endmodule\n');
    const target = {
      name: 'unit', provider: 'verilator', action: 'lint', language: 'systemverilog', standard: '1800-2017',
      top: 'a', sources: ['b.sv', 'a.sv'], parameters: {}, defines: [], includeDirs: [], options: {}, artifacts: {},
      effectiveLimits: { concurrency: 1, wallTimeSeconds: 10, memoryMb: 128, pids: 32, outputBytes: 1024, artifactMb: 1, sourceFiles: 10, sourceBytes: 1024 },
    };
    const project: ResolvedProject = { version: 1, name: 'demo', root, manifestPath: 'hardware.project.yaml', sourceBytes: 40, targets: { unit: target } };

    const snapshot = await createSnapshot(project, target, stateRoot);

    expect(snapshot.files.map((file) => file.path)).toEqual(['a.sv', 'b.sv']);
    expect(snapshot.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(snapshot.root, 'a.sv'), 'utf8')).toContain('module a');
    expect((await stat(join(snapshot.root, 'a.sv'))).mode & 0o222).toBe(0);

    await chmod(join(snapshot.root, 'a.sv'), 0o644);
  });
});
