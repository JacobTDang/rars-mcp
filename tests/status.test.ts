import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import type { SessionBackend } from '../src/sessions/types.js';
import type { ToolDependencies, ToolResult } from '../src/tools/handlers.js';
import { createStatusHandler } from '../src/tools/status.js';
import { Workspace } from '../src/workspace.js';

async function dependencies(overrides: Partial<ToolDependencies> = {}): Promise<ToolDependencies> {
  return {
    workspace: await Workspace.create(await mkdtemp(join(tmpdir(), 'rars-status-'))),
    sessions: new SessionStore(),
    run: vi.fn(),
    javaExecutable: 'java', rarsJar: '/missing/rars1_6.jar', timeoutMs: 5000, maxOutputBytes: 1024,
    ...overrides,
  };
}

function lines(result: ToolResult): string[] {
  const [content] = result.content;
  return content?.type === 'text' ? content.text.split('\n') : [];
}

const fakeBackend: SessionBackend = {
  summary: async () => ({ kind: 'headless', state: 'paused' }),
  command: async () => ({ status: 'paused' }),
  inspect: async () => ({ status: 'paused' }),
  modify: async () => ({ status: 'paused' }),
  close: async () => undefined,
};

describe.runIf(process.env.RARS_JAR)('rars_status with RARS', () => {
  it('reports every component as ok in a healthy configuration', async () => {
    const bridgeJar = resolve('java/bridge/build/rars-mcp-bridge.jar');
    const discoveryDir = await mkdtemp(join(tmpdir(), 'rars-status-live-'));
    const deps = await dependencies({
      rarsJar: process.env.RARS_JAR!, bridgeJar, bridgeToken: 'test-secret',
      bridgeHost: '127.0.0.1', liveDiscoveryDir: discoveryDir,
    });

    const result = await createStatusHandler(deps)();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      rars: { jar: process.env.RARS_JAR, exists: true, version: expect.stringMatching(/^\d+(\.\d+)+$/) },
      java: { executable: 'java', version: expect.stringMatching(/^\d/), home: expect.stringMatching(/\S/) },
      bridge: { jar: bridgeJar, exists: true, configured: true },
      workspace: { roots: deps.workspace.roots, clientRoots: [] },
      sessions: { count: 0 },
      live: { discoveryDir, configured: true },
    });
    expect(lines(result)).toEqual([
      expect.stringMatching(/^rars: ok \(RARS \d/),
      expect.stringMatching(/^java: ok \(\d/),
      `bridge: ok (${bridgeJar})`,
      `workspace: ok (${deps.workspace.roots.join(', ')})`,
      'sessions: ok (0 open)',
      `live: ok (${discoveryDir})`,
    ]);
  });

  it('reports a RARS jar that java cannot run', async () => {
    const jar = join(await mkdtemp(join(tmpdir(), 'rars-status-')), 'rars.jar');
    await writeFile(jar, 'not a jar');

    const result = await createStatusHandler(await dependencies({ rarsJar: jar }))();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rars: { jar, exists: true, error: expect.stringContaining('corrupt jarfile') },
      java: { executable: 'java', version: expect.any(String) },
    });
    expect(result.structuredContent).not.toHaveProperty('rars.version');
  });
});

describe('rars_status', () => {
  it('reports a missing RARS jar in its field and still succeeds', async () => {
    const result = await createStatusHandler(await dependencies({ rarsJar: '/missing/rars1_6.jar' }))();

    expect(result.isError).toBeFalsy();
    expect(Object.keys(result.structuredContent!)).toEqual(['rars', 'java', 'bridge', 'workspace', 'sessions', 'live']);
    expect(result.structuredContent).toMatchObject({
      rars: { jar: '/missing/rars1_6.jar', exists: false, error: 'RARS jar not found: /missing/rars1_6.jar' },
    });
    expect(lines(result)).toHaveLength(6);
    expect(lines(result)[0]).toBe('rars: error: RARS jar not found: /missing/rars1_6.jar');
  });

  it('reports a java executable that cannot be started', async () => {
    const jar = join(await mkdtemp(join(tmpdir(), 'rars-status-')), 'rars.jar');
    await writeFile(jar, 'not a jar');

    const result = await createStatusHandler(await dependencies({ javaExecutable: '/missing/java', rarsJar: jar }))();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rars: { jar, exists: true, error: expect.stringContaining('ENOENT') },
      java: { executable: '/missing/java', error: expect.stringContaining('ENOENT') },
    });
    expect(lines(result)[1]).toMatch(/^java: error: .*ENOENT/);
  });

  it('reports a bridge without a jar or token as not configured', async () => {
    const result = await createStatusHandler(await dependencies())();

    expect(result.structuredContent).toMatchObject({
      bridge: { jar: null, exists: false, configured: false, error: 'Stateful RARS bridge is not configured' },
    });
    expect(lines(result)[2]).toBe('bridge: error: Stateful RARS bridge is not configured');
  });

  it('reports a bridge jar without a token as not configured', async () => {
    const bridgeJar = resolve('package.json');

    const result = await createStatusHandler(await dependencies({ bridgeJar }))();

    expect(result.structuredContent).toMatchObject({
      bridge: { jar: bridgeJar, exists: true, configured: false, error: 'Stateful RARS bridge is not configured' },
    });
  });

  it('reports a configured bridge jar that does not exist', async () => {
    const result = await createStatusHandler(await dependencies({
      bridgeJar: '/missing/rars-mcp-bridge.jar', bridgeToken: 'test-secret',
    }))();

    expect(result.structuredContent).toMatchObject({
      bridge: {
        jar: '/missing/rars-mcp-bridge.jar', exists: false, configured: true,
        error: 'Bridge jar not found: /missing/rars-mcp-bridge.jar',
      },
    });
  });

  it('counts open sessions', async () => {
    const sessions = new SessionStore();
    sessions.add(fakeBackend);
    sessions.add(fakeBackend);

    const result = await createStatusHandler(await dependencies({ sessions }))();
    await sessions.closeAll();

    expect(result.structuredContent).toMatchObject({ sessions: { count: 2 } });
    expect(lines(result)[4]).toBe('sessions: ok (2 open)');
  });

  it('reports live discovery that is not configured', async () => {
    const result = await createStatusHandler(await dependencies())();

    expect(result.structuredContent).toMatchObject({
      live: { discoveryDir: null, configured: false, error: 'Live RARS discovery is not configured' },
    });
    expect(lines(result)[5]).toBe('live: error: Live RARS discovery is not configured');
  });
});

describe('rars_status over MCP', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function serve(roots: string[]) {
    const configured = await mkdtemp(join(tmpdir(), 'rars-status-configured-'));
    const server = createMcpServer(await dependencies({ workspace: await Workspace.create(configured) }));
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', async () => ({
      roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: 'project' })),
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return { client, configured };
  }

  it('lists the configured folders and the client roots', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-status-client-'));
    const { client, configured } = await serve([clientRoot]);

    const result = await client.callTool({ name: 'rars_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workspace: { roots: [await realpath(configured)], clientRoots: [await realpath(clientRoot)] },
    });
    expect(JSON.stringify(result.content)).toContain(
      `workspace: ok (${await realpath(configured)}; client roots: ${await realpath(clientRoot)})`,
    );
  });

  it('reports client roots that cannot be read and still succeeds', async () => {
    const missingRoot = join(await mkdtemp(join(tmpdir(), 'rars-status-client-')), 'missing');
    const { client, configured } = await serve([missingRoot]);

    const result = await client.callTool({ name: 'rars_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workspace: { roots: [await realpath(configured)], error: expect.stringContaining('ENOENT') },
    });
  });
});
