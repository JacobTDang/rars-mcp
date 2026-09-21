import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace.js';

describe('Workspace', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'rars-workspace-'));
    await mkdir(join(fixtureRoot, 'src'));
    await writeFile(join(fixtureRoot, 'src', 'main.asm'), 'li a0, 1\n');
  });

  it('resolves an existing file inside the workspace', async () => {
    const workspace = await Workspace.create(fixtureRoot);

    await expect(workspace.resolve('src/main.asm')).resolves.toBe(
      await realpath(join(fixtureRoot, 'src', 'main.asm')),
    );
  });

  it('rejects a path outside the workspace', async () => {
    const workspace = await Workspace.create(fixtureRoot);

    await expect(workspace.resolve('../secret.asm')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });

  it('rejects a symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'rars-outside-'));
    await writeFile(join(outside, 'secret.asm'), 'secret');
    await symlink(outside, join(fixtureRoot, 'linked'));
    const workspace = await Workspace.create(fixtureRoot);

    await expect(workspace.resolve('linked/secret.asm')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });

  it('resolves relative paths against the first folder and absolute paths in any folder', async () => {
    const second = await mkdtemp(join(tmpdir(), 'rars-workspace-second-'));
    await writeFile(join(second, 'scratch.asm'), 'nop\n');
    const workspace = await Workspace.create(fixtureRoot, second);

    await expect(workspace.resolve('src/main.asm')).resolves.toBe(await realpath(join(fixtureRoot, 'src', 'main.asm')));
    await expect(workspace.resolve(join(second, 'scratch.asm'))).resolves.toBe(await realpath(join(second, 'scratch.asm')));
    await expect(workspace.resolve('scratch.asm')).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
    expect(workspace.roots).toEqual([await realpath(fixtureRoot), await realpath(second)]);
  });

  it('rejects an absolute path outside every folder', async () => {
    const second = await mkdtemp(join(tmpdir(), 'rars-workspace-second-'));
    const outside = await mkdtemp(join(tmpdir(), 'rars-outside-'));
    await writeFile(join(outside, 'secret.asm'), 'secret');
    const workspace = await Workspace.create(fixtureRoot, second);

    await expect(workspace.resolve(join(outside, 'secret.asm'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('resolves a new output beneath an existing workspace directory', async () => {
    const workspace = await Workspace.create(fixtureRoot);

    await expect(workspace.resolve('src/dump.hex', { allowMissing: true })).resolves.toBe(
      join(await realpath(join(fixtureRoot, 'src')), 'dump.hex'),
    );
  });
});
