import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RarsError } from './errors.js';

export interface ResolveOptions {
  allowMissing?: boolean;
}

function contains(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export class Workspace {
  // Canonical folders. Relative paths resolve against the first, and RARS runs there.
  readonly roots: readonly string[];
  // The same folders as configured, before symlinks are resolved.
  private readonly configuredRoots: readonly string[];

  private constructor(configuredRoots: string[], roots: string[]) {
    this.configuredRoots = configuredRoots;
    this.roots = roots;
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

    // Checked before touching the filesystem, so an outside path never reveals whether it exists.
    if (![...this.configuredRoots, ...this.roots].some((root) => contains(root, candidate))) {
      this.outside(requestedPath);
    }

    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(candidate);
    } catch (error) {
      if (!options.allowMissing) {
        throw new RarsError('PATH_NOT_FOUND', `Workspace path does not exist: ${requestedPath}`, {
          path: requestedPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      const canonicalParent = await realpath(dirname(candidate));
      canonicalCandidate = join(canonicalParent, candidate.slice(dirname(candidate).length + 1));
    }

    if (!this.roots.some((root) => contains(root, canonicalCandidate))) this.outside(requestedPath);
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
