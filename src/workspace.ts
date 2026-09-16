import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { RarsError } from './errors.js';

export interface ResolveOptions {
  allowMissing?: boolean;
}

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<Workspace> {
    return new Workspace(await realpath(root));
  }

  async resolve(requestedPath: string, options: ResolveOptions = {}): Promise<string> {
    const candidate = resolve(
      this.root,
      isAbsolute(requestedPath) ? relative(this.root, requestedPath) : requestedPath,
    );

    this.assertContained(candidate, requestedPath);

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

    this.assertContained(canonicalCandidate, requestedPath);
    return canonicalCandidate;
  }

  private assertContained(candidate: string, requestedPath: string): void {
    const pathFromRoot = relative(this.root, candidate);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) {
      throw new RarsError(
        'PATH_OUTSIDE_WORKSPACE',
        `Workspace path escapes the configured root: ${requestedPath}`,
        { path: requestedPath },
      );
    }
  }
}
