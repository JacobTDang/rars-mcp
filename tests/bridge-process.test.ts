import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { watchStartup } from '../src/sessions/bridge-process.js';

describe('watchStartup', () => {
  it('fails the startup when the bridge stderr stream fails', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
    const startup = watchStartup(child, 60_000);

    child.stderr!.emit('error', new Error('stderr broke'));

    await expect(startup.within(startup.port)).rejects.toThrow('stderr broke');
    startup.finish();
  });
});
