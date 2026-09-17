import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import fg from 'fast-glob';
import { parse } from 'yaml';
import { z } from 'zod';

import { RarsError } from '../errors.js';
import type { HardwareLimits, ProviderCapability, ResolvedProject, ResolvedTarget } from './types.js';

const limitSchema = z.object({
  wall_time_seconds: z.number().int().positive().optional(),
  memory_mb: z.number().int().positive().optional(),
  pids: z.number().int().positive().optional(),
  output_bytes: z.number().int().positive().optional(),
  artifact_mb: z.number().int().positive().optional(),
}).strict();

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const targetSchema = z.object({
  provider: z.string().min(1),
  action: z.string().min(1),
  language: z.string().min(1).optional(),
  standard: z.string().min(1).optional(),
  top: z.string().min(1).optional(),
  parameters: z.record(z.string(), scalarSchema).default({}),
  defines: z.array(z.string()).default([]),
  include_dirs: z.array(z.string()).default([]),
  options: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.string()).default({}),
  command: z.array(z.string().min(1)).min(1).optional(),
  allow_repository_command: z.boolean().default(false),
  limits: limitSchema.default({}),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  targets: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), targetSchema).refine(
    (targets) => Object.keys(targets).length > 0,
    'At least one target is required',
  ),
}).strict();

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function mergeLimits(server: HardwareLimits, requested: z.infer<typeof limitSchema>): HardwareLimits {
  const mappings = [
    ['wall_time_seconds', 'wallTimeSeconds'], ['memory_mb', 'memoryMb'], ['pids', 'pids'],
    ['output_bytes', 'outputBytes'], ['artifact_mb', 'artifactMb'],
  ] as const;
  const merged = { ...server };
  for (const [input, output] of mappings) {
    const value = requested[input];
    if (value !== undefined) {
      if (value > server[output]) {
        throw new RarsError('INVALID_PROJECT', `${input} exceeds the server maximum`, { requested: value, maximum: server[output] });
      }
      merged[output] = value;
    }
  }
  return merged;
}

export async function loadHardwareProject(
  workspaceRoot: string,
  manifestPath: string,
  serverLimits: HardwareLimits,
  capabilities: ProviderCapability[],
  allowRepositoryCommands: boolean,
): Promise<ResolvedProject> {
  const root = await realpath(workspaceRoot);
  if (isAbsolute(manifestPath)) {
    throw new RarsError('INVALID_PROJECT', 'Manifest path must be workspace-relative', { manifestPath });
  }
  const manifestCandidate = resolve(root, manifestPath);
  const canonicalManifest = await realpath(manifestCandidate).catch(() => {
    throw new RarsError('INVALID_PROJECT', `Manifest does not exist: ${manifestPath}`, { manifestPath });
  });
  if (!isContained(root, canonicalManifest)) {
    throw new RarsError('PATH_OUTSIDE_WORKSPACE', 'Manifest is outside the workspace', { manifestPath });
  }

  let raw: unknown;
  try {
    raw = parse(await readFile(canonicalManifest, 'utf8'));
  } catch (error) {
    if (error instanceof RarsError) throw error;
    throw new RarsError('INVALID_PROJECT', 'Manifest is not valid YAML', { manifestPath, cause: String(error) });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RarsError('INVALID_PROJECT', 'Manifest schema validation failed', { issues: parsed.error.issues });
  }

  for (const pattern of parsed.data.sources) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/u).includes('..')) {
      throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Source pattern is outside the workspace: ${pattern}`, { pattern });
    }
  }
  const matches = await fg(parsed.data.sources, { cwd: root, onlyFiles: true, dot: true, followSymbolicLinks: true });
  const canonical = new Map<string, number>();
  for (const match of matches.sort()) {
    const candidate = resolve(root, match);
    const resolved = await realpath(candidate);
    if (!isContained(root, resolved)) {
      throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Source resolves outside the workspace: ${match}`, { path: match });
    }
    const stat = await lstat(resolved);
    if (!stat.isFile()) continue;
    canonical.set(relative(root, resolved).split(sep).join('/'), stat.size);
  }
  const sources = [...canonical.keys()].sort();
  if (sources.length === 0) throw new RarsError('INVALID_PROJECT', 'Project has no source files', {});
  if (sources.length > serverLimits.sourceFiles) {
    throw new RarsError('INVALID_PROJECT', 'Project exceeds the source file limit', { count: sources.length, maximum: serverLimits.sourceFiles });
  }
  const sourceBytes = [...canonical.values()].reduce((total, size) => total + size, 0);
  if (sourceBytes > serverLimits.sourceBytes) {
    throw new RarsError('INVALID_PROJECT', 'Project exceeds the source byte limit', { sourceBytes, maximum: serverLimits.sourceBytes });
  }

  const capabilityMap = new Map(capabilities.map((capability) => [capability.id, capability]));
  const targets: Record<string, ResolvedTarget> = {};
  for (const [name, target] of Object.entries(parsed.data.targets)) {
    const capability = capabilityMap.get(target.provider);
    if (!capability) throw new RarsError('PROVIDER_UNAVAILABLE', `Unknown provider: ${target.provider}`, { provider: target.provider });
    if (!capability.available) throw new RarsError('PROVIDER_UNAVAILABLE', `Provider is unavailable: ${target.provider}`, { provider: target.provider });
    if (!capability.actions.includes(target.action)) {
      throw new RarsError('INVALID_PROJECT', `Provider does not support action: ${target.action}`, { provider: target.provider, action: target.action });
    }
    if (target.language && !capability.languages.includes(target.language)) {
      throw new RarsError('INVALID_PROJECT', `Provider does not support language: ${target.language}`, { provider: target.provider, language: target.language });
    }
    if (target.standard && !capability.standards.includes(target.standard)) {
      throw new RarsError('INVALID_PROJECT', `Provider does not support standard: ${target.standard}`, { provider: target.provider, standard: target.standard });
    }
    for (const directory of target.include_dirs) {
      if (isAbsolute(directory) || directory.split(/[\\/]/u).includes('..')) throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Include directory is outside the workspace: ${directory}`);
      const resolvedDirectory = await realpath(resolve(root, directory)).catch(() => { throw new RarsError('INVALID_PROJECT', `Include directory does not exist: ${directory}`); });
      if (!isContained(root, resolvedDirectory)) throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Include directory is outside the workspace: ${directory}`);
    }
    if (Object.keys(target.options).length > 0) throw new RarsError('INVALID_PROJECT', `Provider ${target.provider} does not accept options`, { options: Object.keys(target.options) });
    const waveform = target.artifacts.waveform;
    for (const key of Object.keys(target.artifacts)) if (key !== 'waveform') throw new RarsError('INVALID_PROJECT', `Unsupported artifact declaration: ${key}`);
    if (waveform && !capability.artifactFormats.includes(waveform)) throw new RarsError('INVALID_PROJECT', `Unsupported waveform format: ${waveform}`);
    if (target.provider === 'repository-command') {
      if (!target.allow_repository_command || !allowRepositoryCommands) {
        throw new RarsError('INVALID_PROJECT', 'Repository commands are disabled', { target: name });
      }
      if (!target.command) throw new RarsError('INVALID_PROJECT', 'Repository command target requires command', { target: name });
    }
    targets[name] = {
      name, provider: target.provider, action: target.action, sources,
      parameters: target.parameters, defines: target.defines, includeDirs: target.include_dirs,
      options: target.options, artifacts: target.artifacts,
      effectiveLimits: mergeLimits(serverLimits, target.limits),
      ...(target.language === undefined ? {} : { language: target.language }),
      ...(target.standard === undefined ? {} : { standard: target.standard }),
      ...(target.top === undefined ? {} : { top: target.top }),
      ...(target.command === undefined ? {} : { command: target.command }),
    };
  }

  return { version: 1, name: parsed.data.name, root, manifestPath: relative(root, canonicalManifest).split(sep).join('/'), sourceBytes, targets };
}
