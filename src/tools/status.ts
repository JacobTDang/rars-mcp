import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { ToolDependencies, ToolResult } from './handlers.js';

const execFileAsync = promisify(execFile);

export const statusSchema = z.strictObject({});

// Every check reports its own failure in an error field, so one missing piece never hides the rest.
type Checked<T> = T & { error?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function checkRars(deps: ToolDependencies): Promise<Checked<{ jar: string; exists: boolean; version?: string }>> {
  const jar = deps.rarsJar;
  let exists = false;
  try {
    exists = await isFile(jar);
    if (!exists) return { jar, exists, error: `RARS jar not found: ${jar}` };
    // The h option prints the banner and usage, then exits; with no options RARS opens its GUI.
    const { stdout } = await execFileAsync(deps.javaExecutable, ['-jar', jar, 'h'], { timeout: deps.timeoutMs });
    const version = /^RARS (\S+)/m.exec(stdout)?.[1];
    if (version === undefined) return { jar, exists, error: `RARS printed no version banner: ${stdout.slice(0, 200)}` };
    return { jar, exists, version };
  } catch (error) {
    return { jar, exists, error: message(error) };
  }
}

async function checkJava(deps: ToolDependencies): Promise<Checked<{ executable: string; version?: string; home?: string }>> {
  const executable = deps.javaExecutable;
  try {
    // Both the property listing and the version go to stderr.
    const { stderr } = await execFileAsync(executable, ['-XshowSettings:properties', '-version'], { timeout: deps.timeoutMs });
    const version = /version "([^"]+)"/.exec(stderr)?.[1];
    const home = /^\s*java\.home = (.+)$/m.exec(stderr)?.[1];
    if (version === undefined || home === undefined) {
      return { executable, error: `Unrecognised java -version output: ${stderr.slice(0, 200)}` };
    }
    return { executable, version, home };
  } catch (error) {
    return { executable, error: message(error) };
  }
}

async function checkBridge(deps: ToolDependencies): Promise<Checked<{ jar: string | null; exists: boolean; configured: boolean }>> {
  const jar = deps.bridgeJar ?? null;
  const configured = Boolean(deps.bridgeJar && deps.bridgeToken);
  try {
    const exists = jar !== null && await isFile(jar);
    if (!configured) return { jar, exists, configured, error: 'Stateful RARS bridge is not configured' };
    if (!exists) return { jar, exists, configured, error: `Bridge jar not found: ${jar}` };
    return { jar, exists, configured };
  } catch (error) {
    return { jar, exists: false, configured, error: message(error) };
  }
}

async function checkWorkspace(deps: ToolDependencies): Promise<Checked<{ roots: readonly string[]; clientRoots?: readonly string[] }>> {
  const roots = deps.workspace.roots;
  try {
    return { roots, clientRoots: await deps.workspace.clientRoots() };
  } catch (error) {
    return { roots, error: message(error) };
  }
}

function checkLive(deps: ToolDependencies): Checked<{ discoveryDir: string | null; configured: boolean }> {
  const discoveryDir = deps.liveDiscoveryDir ?? null;
  const configured = Boolean(deps.liveDiscoveryDir && deps.bridgeHost);
  return configured ? { discoveryDir, configured } : { discoveryDir, configured, error: 'Live RARS discovery is not configured' };
}

function line(name: string, error: string | undefined, detail: string): string {
  return error === undefined ? `${name}: ok (${detail})` : `${name}: error: ${error}`;
}

export function createStatusHandler(deps: ToolDependencies) {
  return async (_input: Record<string, never> = {}): Promise<ToolResult> => {
    const [rars, java, bridge, workspace] = await Promise.all([
      checkRars(deps), checkJava(deps), checkBridge(deps), checkWorkspace(deps),
    ]);
    const sessions = { count: deps.sessions.size };
    const live = checkLive(deps);
    const clientRoots = workspace.clientRoots?.length ? `; client roots: ${workspace.clientRoots.join(', ')}` : '';
    const text = [
      line('rars', rars.error, `RARS ${rars.version}, ${rars.jar}`),
      line('java', java.error, `${java.version}, ${java.home}`),
      line('bridge', bridge.error, `${bridge.jar}`),
      line('workspace', workspace.error, `${workspace.roots.join(', ')}${clientRoots}`),
      line('sessions', undefined, `${sessions.count} open`),
      line('live', live.error, `${live.discoveryDir}`),
    ].join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { rars, java, bridge, workspace, sessions, live } };
  };
}
