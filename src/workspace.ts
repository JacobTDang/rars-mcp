import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RarsError } from './errors.js';

export interface ResolveOptions {
  allowMissing?: boolean;
}

// URIs of extra folders supplied by the client at run time, for example its MCP roots.
export type RootsProvider = () => Promise<string[]>;

// A client root that is not used: the folder, or the URI when it names no local folder.
export interface SkippedRoot {
  root: string;
  reason: string;
}

export interface ClientRoots {
  roots: readonly string[];
  skipped: readonly SkippedRoot[];
}

interface Roots {
  configured: readonly string[];
  canonical: readonly string[];
  skipped: ReadonlyArray<SkippedRoot & { folder?: string }>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contains(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

// One root that cannot be used is skipped and reported, so it never blocks the others.
async function readRoots(provider: RootsProvider): Promise<Roots> {
  let uris: string[];
  try {
    uris = await provider();
  } catch (error) {
    throw new RarsError('CLIENT_ROOTS_UNAVAILABLE', `Could not list the client's roots: ${message(error)}`, {
      cause: message(error),
    });
  }
  const read = await Promise.all(uris.map(async (uri) => {
    let folder: string;
    try {
      folder = resolve(fileURLToPath(uri));
    } catch (error) {
      return { skipped: { root: uri, reason: message(error) } };
    }
    try {
      return { folder, canonical: await realpath(folder) };
    } catch (error) {
      return { skipped: { root: folder, reason: message(error), folder } };
    }
  }));
  return {
    configured: read.flatMap((root) => root.canonical === undefined ? [] : [root.folder]),
    canonical: read.flatMap((root) => root.canonical === undefined ? [] : [root.canonical]),
    skipped: read.flatMap((root) => root.skipped === undefined ? [] : [root.skipped]),
  };
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class Workspace {
  // Canonical folders. Relative paths resolve against the first, and RARS runs there.
  readonly roots: readonly string[];
  // The same folders as configured, before symlinks are resolved.
  private readonly configuredRoots: readonly string[];

  private provider: RootsProvider | undefined;
  private provided: Promise<Roots> | undefined;

  private constructor(configuredRoots: string[], roots: string[]) {
    this.configuredRoots = configuredRoots;
    this.roots = roots;
  }

  // An answer is reused until the client says its roots changed; a failed one is asked again on the next call.
  useRootsProvider(provider: RootsProvider): void {
    this.provider = provider;
    this.provided = undefined;
  }

  rootsChanged(): void {
    this.provided = undefined;
  }

  // The client's roots after symlinks are resolved, and the ones skipped; empty when the client advertises none.
  async clientRoots(): Promise<ClientRoots> {
    const { canonical, skipped } = await this.providedRoots();
    return { roots: canonical, skipped: skipped.map(({ root, reason }) => ({ root, reason })) };
  }

  private async providedRoots(): Promise<Roots> {
    if (this.provider === undefined) return { configured: [], canonical: [], skipped: [] };
    if (this.provided === undefined) {
      const reading: Promise<Roots> = readRoots(this.provider).catch((error: unknown) => {
        if (this.provided === reading) this.provided = undefined;
        throw error;
      });
      this.provided = reading;
    }
    return this.provided;
  }

  get root(): string {
    return this.roots[0]!;
  }

  static async create(...roots: string[]): Promise<Workspace> {
    if (roots.length === 0) {
      throw new RarsError('INVALID_CONFIGURATION', 'A workspace needs at least one folder', {});
    }
    const configured = roots.map((root) => resolve(root));
    return new Workspace(configured, await Promise.all(configured.map((root) => realpath(root))));
  }

  async resolve(requestedPath: string, options: ResolveOptions = {}): Promise<string> {
    const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(this.root, requestedPath);
    const provided = await this.providedRoots();

    // Checked before touching the filesystem, so an outside path never reveals whether it exists.
    const lexicalRoots = [...this.configuredRoots, ...this.roots, ...provided.configured, ...provided.canonical];
    if (!lexicalRoots.some((root) => contains(root, candidate))) {
      const skipped = provided.skipped.find((root) => root.folder !== undefined && contains(root.folder, candidate));
      if (skipped !== undefined) {
        throw new RarsError(
          'PATH_OUTSIDE_WORKSPACE',
          `Workspace path is in a client root that was skipped: ${requestedPath} (${skipped.reason})`,
          { path: requestedPath, root: skipped.root },
        );
      }
      this.outside(requestedPath);
    }

    let canonicalCandidate: string;
    let missing = false;
    try {
      canonicalCandidate = await realpath(candidate);
    } catch (error) {
      if (!options.allowMissing) {
        throw new RarsError('PATH_NOT_FOUND', `Workspace path does not exist: ${requestedPath}`, {
          path: requestedPath,
          cause: message(error),
        });
      }

      // The folder must exist; resolving it also catches a folder symlink that leads out.
      canonicalCandidate = join(await this.existingFolder(requestedPath, dirname(candidate)), basename(candidate));
      missing = true;
    }

    const canonicalRoots = [...this.roots, ...provided.canonical];
    if (!canonicalRoots.some((root) => contains(root, canonicalCandidate))) this.outside(requestedPath);
    // A symlink whose target does not exist is refused: whatever writes the file would follow it there.
    if (missing && await isSymlink(canonicalCandidate)) {
      throw new RarsError('PATH_IS_SYMLINK', `Workspace output path is a symlink whose target does not exist: ${requestedPath}`, {
        path: requestedPath,
      });
    }
    return canonicalCandidate;
  }

  // The canonical form of the folder that will hold the new output requestedPath.
  private async existingFolder(requestedPath: string, folder: string): Promise<string> {
    try {
      return await realpath(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new RarsError('PATH_NOT_FOUND', `folder ${dirname(requestedPath)} does not exist in the workspace`, {
        path: requestedPath,
        cause: message(error),
      });
    }
  }

  private outside(requestedPath: string): never {
    throw new RarsError(
      'PATH_OUTSIDE_WORKSPACE',
      `Workspace path is outside the configured workspace folders: ${requestedPath}`,
      { path: requestedPath },
    );
  }
}
