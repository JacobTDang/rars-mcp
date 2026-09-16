import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { createHttpHandler } from '../src/http.js';
import { SessionStore } from '../src/sessions/store.js';
import { Workspace } from '../src/workspace.js';

describe('HTTP service', () => {
  it('serves health and tools through Streamable HTTP', async () => {
    const workspace = await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-http-')));
    const handler = createHttpHandler({
      workspace, sessions: new SessionStore(), run: async () => ({
        exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false,
      }),
      javaExecutable: 'java', rarsJar: '/rars.jar', timeoutMs: 1000, maxOutputBytes: 1024,
    });
    const health = await handler.fetch(new Request('http://localhost/health'));
    expect(await health.json()).toMatchObject({ status: 'ok', rars: { jar: '/rars.jar' } });

    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('rars_run');
    await client.close();
    await handler.close();
  });
});
