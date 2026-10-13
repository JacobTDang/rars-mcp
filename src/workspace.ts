import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RarsError } from './errors.js';

export interface ResolveOptions {
  allowMissing?: boolean;
}

// Extra folders supplied by the client at run time, for example its MCP roots.
export type RootsProvider = () => Promise<string[]>;

interface Roots {
  configured: readonly string[];
  canonical: readonly string[];
}

function contains(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
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

  // The provider is asked once and the answer reused until the client says its roots changed.
  useRootsProvider(provider: RootsProvider): void {
    this.provider = provider;
    this.provided = undefined;
  }

  rootsChanged(): void {
    this.provided = undefined;
  }

  // The client's roots after symlinks are resolved; empty when the client advertises none.
  async clientRoots(): Promise<readonly string[]> {
    return (await this.providedRoots()).canonical;
  }

  private async providedRoots(): Promise<Roots> {
    if (this.provider === undefined) return { configured: [], canonical: [] };
    this.provided ??= (async (provider: RootsProvider): Promise<Roots> => {
      const configured = (await provider()).map((root) => resolve(root));
      return { configured, canonical: await Promise.all(configured.map((root) => realpath(root))) };
    })(this.provider);
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
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      // The folder must exist; resolving it also catches a folder symlink that leads out.
      canonicalCandidate = join(await realpath(dirname(candidate)), basename(candidate));
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

  private outside(requestedPath: string): never {
    throw new RarsError(
      'PATH_OUTSIDE_WORKSPACE',
      `Workspace path is outside the configured workspace folders: ${requestedPath}`,
      { path: requestedPath },
    );
  }
}
