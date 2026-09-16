import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { SessionStore } from '../src/sessions/store.js';
import { createToolHandlers } from '../src/tools/handlers.js';
import { Workspace } from '../src/workspace.js';

describe('headless tool handlers', () => {
  it('resolves files and returns structured assembly diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'bad.asm'), 'bad');
    const run = vi.fn(async () => ({
      exitCode: 1, signal: null, stdout: '',
      stderr: `Error in ${join(root, 'bad.asm')} line 1 column 1: bad instruction\n`,
      timedOut: false, truncated: false,
    }));
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(), run,
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.assemble({ files: ['bad.asm'] });

    const canonicalRoot = await realpath(root);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: canonicalRoot,
      request: expect.objectContaining({ mode: 'assemble', files: [join(canonicalRoot, 'bad.asm')] }),
    }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ diagnostics: [{ line: 1, column: 1 }] });
  });

  it('reports timeouts as readable run results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    await writeFile(join(root, 'loop.asm'), 'loop');
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions: new SessionStore(),
      run: async () => ({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true, truncated: false }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    const result = await handlers.run({ files: ['loop.asm'], programArgs: ['one'] });
    expect(result).toMatchObject({ isError: true, structuredContent: { timedOut: true } });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('timed out') });
  });

  it('lists and closes sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rars-tools-'));
    const sessions = new SessionStore();
    const close = vi.fn(async () => undefined);
    const id = sessions.add({
      summary: async () => ({ kind: 'headless', state: 'paused' }),
      command: async () => ({ status: 'paused' }), inspect: async () => ({}),
      modify: async () => ({ status: 'paused' }), close,
    });
    const handlers = createToolHandlers({
      workspace: await Workspace.create(root), sessions,
      run: vi.fn(), javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });

    expect((await handlers.sessionList()).structuredContent).toMatchObject({ sessions: [{ id }] });
    await handlers.sessionClose({ sessionId: id });
    expect(close).toHaveBeenCalledOnce();
  });
});
