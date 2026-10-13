import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';

import { loadConfig } from '../src/config.js';
import { createToolDependencies } from '../src/dependencies.js';
import { createMcpServer } from '../src/server.js';
import { SessionStore } from '../src/sessions/store.js';
import type { SessionBackend } from '../src/sessions/types.js';
import type { ToolDependencies, ToolResult } from '../src/tools/handlers.js';
import { createStatusHandler } from '../src/tools/status.js';
import { createNvcSimulator } from '../src/vhdl/nvc.js';
import { Workspace } from '../src/workspace.js';

const tclsh = process.env.TCLSH ?? 'tclsh';
const simulator = process.env.VHDL_SIMULATOR ?? 'nvc';

// The checks against the real tclsh and nvc are skipped where they are not installed.
function starts(executable: string, args: string[], input: string): boolean {
  const result = spawnSync(executable, args, { input, stdio: ['pipe', 'ignore', 'ignore'] });
  return result.error === undefined && result.status === 0;
}
const tclshAvailable = starts(tclsh, [], 'exit\n');
const simulatorAvailable = starts(simulator, ['--version'], '');

// A shell script standing in for tclsh or nvc, in a folder of its own.
async function fakeExecutable(name: string, body: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'rars-status-bin-')), name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

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
  it.runIf(tclshAvailable && simulatorAvailable)('reports every component as ok in a healthy configuration', async () => {
    const bridgeJar = resolve('java/bridge/build/rars-mcp-bridge.jar');
    const discoveryDir = await mkdtemp(join(tmpdir(), 'rars-status-live-'));
    const deps = await dependencies({
      rarsJar: process.env.RARS_JAR!, bridgeJar, bridgeToken: 'test-secret',
      bridgeHost: '127.0.0.1', liveDiscoveryDir: discoveryDir,
      tclshExecutable: tclsh, vhdl: createNvcSimulator({ executable: simulator }),
    });

    const result = await createStatusHandler(deps)();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      rars: { jar: process.env.RARS_JAR, exists: true, version: expect.stringMatching(/^\d+(\.\d+)+$/) },
      java: { executable: 'java', version: expect.stringMatching(/^\d/), home: expect.stringMatching(/\S/) },
      bridge: { jar: bridgeJar, exists: true, configured: true },
      workspace: { roots: deps.workspace.roots, clientRoots: [], skippedClientRoots: [] },
      sessions: { count: 0 },
      live: { discoveryDir, configured: true },
      tclsh: {
        executable: tclsh, path: expect.stringMatching(/^\//), found: true,
        version: expect.stringMatching(/^\d+\.\d+/), envVar: 'TCLSH',
      },
      vhdl: {
        simulator: 'nvc', executable: simulator, path: expect.stringMatching(/^\//), found: true,
        version: expect.stringMatching(/^\d+\.\d+/), envVar: 'VHDL_SIMULATOR',
      },
    });
    expect(lines(result)).toEqual([
      expect.stringMatching(/^rars: ok \(RARS \d/),
      expect.stringMatching(/^java: ok \(\d/),
      `bridge: ok (${bridgeJar})`,
      `workspace: ok (${deps.workspace.roots.join(', ')})`,
      'sessions: ok (0 open)',
      `live: ok (${discoveryDir})`,
      expect.stringMatching(/^tclsh: ok \(Tcl \d+\.\d+\S*, \/.+\)$/),
      expect.stringMatching(/^vhdl: ok \(nvc \d+\.\d+\S*, \/.+\)$/),
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
  afterEach(() => { vi.unstubAllEnvs(); });

  it('reports a missing RARS jar in its field and still succeeds', async () => {
    const result = await createStatusHandler(await dependencies({ rarsJar: '/missing/rars1_6.jar' }))();

    expect(result.isError).toBeFalsy();
    expect(Object.keys(result.structuredContent!)).toEqual([
      'rars', 'java', 'bridge', 'workspace', 'sessions', 'live', 'tclsh', 'vhdl',
    ]);
    expect(result.structuredContent).toMatchObject({
      rars: { jar: '/missing/rars1_6.jar', exists: false, error: 'RARS jar not found: /missing/rars1_6.jar' },
    });
    expect(lines(result)).toHaveLength(8);
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

  it('reports a Tcl shell and VHDL simulator that are not configured', async () => {
    const result = await createStatusHandler(await dependencies())();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty('tclsh', {
      executable: null, found: false, envVar: 'TCLSH', error: 'The Tcl shell is not configured',
    });
    expect(result.structuredContent).toHaveProperty('vhdl', {
      simulator: null, executable: null, found: false, envVar: 'VHDL_SIMULATOR', error: 'VHDL simulator is not configured',
    });
    expect(lines(result).slice(6)).toEqual([
      'tclsh: error: The Tcl shell is not configured',
      'vhdl: error: VHDL simulator is not configured',
    ]);
  });

  it('reads TCLSH and VHDL_SIMULATOR through the tool dependencies', async () => {
    const config = loadConfig({
      RARS_WORKSPACE: await mkdtemp(join(tmpdir(), 'rars-status-')),
      RARS_JAR: '/missing/rars1_6.jar',
      VHDL_SIMULATOR: '/nonexistent/nvc',
    });

    const result = await createStatusHandler(await createToolDependencies(config, { TCLSH: '/nonexistent/tclsh' }))();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty('tclsh', {
      executable: '/nonexistent/tclsh', found: false, envVar: 'TCLSH',
      error: 'Tcl shell not found: /nonexistent/tclsh. Install Tcl or set TCLSH',
    });
    expect(result.structuredContent).toHaveProperty('vhdl', {
      simulator: 'nvc', executable: '/nonexistent/nvc', found: false, envVar: 'VHDL_SIMULATOR',
      error: 'VHDL simulator not found: /nonexistent/nvc. Install nvc or set VHDL_SIMULATOR',
    });
    expect(lines(result).slice(6)).toEqual([
      'tclsh: error: Tcl shell not found: /nonexistent/tclsh. Install Tcl or set TCLSH',
      'vhdl: error: VHDL simulator not found: /nonexistent/nvc. Install nvc or set VHDL_SIMULATOR',
    ]);
  });

  it('finds the Tcl shell and VHDL simulator on PATH and reports their versions', async () => {
    const tclshPath = await fakeExecutable('fake-tclsh', 'cat > /dev/null\necho 8.6.99');
    const nvcPath = await fakeExecutable('fake-nvc', 'echo "nvc 9.9.9 (Using LLVM 1.0)"');
    vi.stubEnv('PATH', [dirname(tclshPath), dirname(nvcPath), process.env.PATH].join(delimiter));

    const result = await createStatusHandler(await dependencies({
      tclshExecutable: 'fake-tclsh', vhdl: createNvcSimulator({ executable: 'fake-nvc' }),
    }))();

    expect(result.structuredContent).toHaveProperty('tclsh', {
      executable: 'fake-tclsh', path: tclshPath, found: true, version: '8.6.99', envVar: 'TCLSH',
    });
    expect(result.structuredContent).toHaveProperty('vhdl', {
      simulator: 'nvc', executable: 'fake-nvc', path: nvcPath, found: true, version: '9.9.9', envVar: 'VHDL_SIMULATOR',
    });
    expect(lines(result).slice(6)).toEqual([`tclsh: ok (Tcl 8.6.99, ${tclshPath})`, `vhdl: ok (nvc 9.9.9, ${nvcPath})`]);
  });

  it('reports a Tcl shell that is found but fails', async () => {
    const tclshPath = await fakeExecutable('tclsh', 'echo "tclsh is broken" >&2\nexit 3');

    const result = await createStatusHandler(await dependencies({ tclshExecutable: tclshPath }))();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty('tclsh', {
      executable: tclshPath, path: tclshPath, found: true, envVar: 'TCLSH', error: expect.stringContaining('tclsh is broken'),
    });
    expect(lines(result)[6]).toMatch(/^tclsh: error: /);
  });

  it('reports Tcl output that is not a version', async () => {
    const tclshPath = await fakeExecutable('tclsh', 'cat > /dev/null\necho hello');

    const result = await createStatusHandler(await dependencies({ tclshExecutable: tclshPath }))();

    expect(result.structuredContent).toHaveProperty('tclsh', {
      executable: tclshPath, path: tclshPath, found: true, envVar: 'TCLSH',
      error: `Unrecognised Tcl version from ${tclshPath}: hello`,
    });
  });

  it('reports a VHDL simulator whose version it does not recognise', async () => {
    const nvcPath = await fakeExecutable('nvc', 'echo "not a simulator"');

    const result = await createStatusHandler(await dependencies({ vhdl: createNvcSimulator({ executable: nvcPath }) }))();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty('vhdl', {
      simulator: 'nvc', executable: nvcPath, path: nvcPath, found: true, envVar: 'VHDL_SIMULATOR',
      error: `Unrecognised ${nvcPath} --version output: not a simulator`,
    });
    expect(lines(result)[7]).toBe(`vhdl: error: Unrecognised ${nvcPath} --version output: not a simulator`);
  });
});

describe('rars_status over MCP', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  type ListRoots = () => Promise<{ roots: Array<{ uri: string; name?: string }> }>;

  function folders(roots: string[]): ListRoots {
    return async () => ({ roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: 'project' })) });
  }

  async function serve(roots: string[] | ListRoots) {
    const configured = await mkdtemp(join(tmpdir(), 'rars-status-configured-'));
    const server = createMcpServer(await dependencies({ workspace: await Workspace.create(configured) }));
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', typeof roots === 'function' ? roots : folders(roots));
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
      workspace: { roots: [await realpath(configured)], clientRoots: [await realpath(clientRoot)], skippedClientRoots: [] },
    });
    expect(JSON.stringify(result.content)).toContain(
      `workspace: ok (${await realpath(configured)}; client roots: ${await realpath(clientRoot)})`,
    );
  });

  it('lists the client roots it skipped with the reason', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-status-client-'));
    const missingRoot = join(await mkdtemp(join(tmpdir(), 'rars-status-client-')), 'missing');
    const { client, configured } = await serve(async () => ({
      roots: [{ uri: pathToFileURL(missingRoot).href }, { uri: 'file://otherhost/project' }, { uri: pathToFileURL(clientRoot).href }],
    }));

    const result = await client.callTool({ name: 'rars_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    const missingReason = `ENOENT: no such file or directory, realpath '${missingRoot}'`;
    expect(result.structuredContent).toHaveProperty('workspace', {
      roots: [await realpath(configured)],
      clientRoots: [await realpath(clientRoot)],
      skippedClientRoots: [
        { root: missingRoot, reason: missingReason },
        { root: 'file://otherhost/project', reason: expect.stringContaining('host must be "localhost" or empty') },
      ],
    });
    const [, remote] = (result.structuredContent as { workspace: { skippedClientRoots: Array<{ reason: string }> } })
      .workspace.skippedClientRoots;
    expect(lines(result)[3]).toBe(`workspace: ok (${await realpath(configured)}; client roots: ${await realpath(clientRoot)}; `
      + `skipped client roots: ${missingRoot} (${missingReason}), file://otherhost/project (${remote!.reason}))`);
  });

  it('reports a failed roots/list and asks again on the next call', async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), 'rars-status-client-'));
    let asked = 0;
    const { client, configured } = await serve(async () => {
      asked += 1;
      if (asked === 1) throw new ProtocolError(ProtocolErrorCode.InternalError, 'roots are not ready');
      return folders([clientRoot])();
    });

    const failed = await client.callTool({ name: 'rars_status', arguments: {} });
    const retried = await client.callTool({ name: 'rars_status', arguments: {} });

    expect(failed.isError).toBeFalsy();
    expect(failed.structuredContent).toHaveProperty('workspace', {
      roots: [await realpath(configured)], error: expect.stringContaining('roots are not ready'),
    });
    expect(lines(failed)[3]).toMatch(/^workspace: error: Could not list the client's roots: .*roots are not ready/);
    expect(retried.structuredContent).toHaveProperty('workspace', {
      roots: [await realpath(configured)], clientRoots: [await realpath(clientRoot)], skippedClientRoots: [],
    });
    expect(asked).toBe(2);
  });
});
