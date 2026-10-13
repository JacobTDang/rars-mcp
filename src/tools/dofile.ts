import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { z } from 'zod';

import { RarsError } from '../errors.js';
import {
  analyzeSteps, runDoFile, vhdlStandards, type DoFileError, type DoFileStep, type ListFile, type LocatedPath, type PathKind,
  type StepAnalysis,
} from '../vhdl/dofile.js';
import type { Workspace } from '../workspace.js';
import type { ToolDependencies, ToolResult } from './handlers.js';

export const doFileCheckSchema = z.strictObject({
  path: z.string().min(1).describe('The .do file to check'),
  std: z.enum(vhdlStandards).describe('VHDL standard for vcom calls that name none, as in vcom -2008').optional(),
});

export type DoFileCheckInput = z.infer<typeof doFileCheckSchema>;
export type DoFileDependencies = Pick<ToolDependencies, 'workspace' | 'tclshExecutable' | 'timeoutMs' | 'maxOutputBytes'>;

interface CompileEntry {
  file: string;
  resolved: string;
  exists: boolean;
  library: string;
  std?: string;
  list?: string;
  order: number;
}

interface DoFileReport {
  ok: boolean;
  cwd: string;
  steps: DoFileStep[];
  compiles: CompileEntry[];
  missing: string[];
  libraries: string[];
  simulate?: StepAnalysis['simulate'];
  errors: DoFileError[];
}

type CompileState = PathKind | 'outside';
type Locate = (path: string, folder: string) => Promise<LocatedPath>;

const stateNotes: Record<CompileState, string> = {
  file: '', directory: ', a directory', other: ', not a file', missing: ', missing', outside: ', outside the workspace',
};

// Resolves a path from the folder the script is in. Questa resolves a script's paths from the folder it
// runs in, assumed here to be the script's own until a cd moves it.
function locator(workspace: Workspace): Locate {
  return async (path, folder) => {
    const target = resolve(folder, path);
    let canonical: string;
    try {
      canonical = await workspace.resolve(target);
    } catch (error) {
      if (error instanceof RarsError && error.code === 'PATH_NOT_FOUND') return { path: target, kind: 'missing' };
      if (error instanceof RarsError && error.code === 'PATH_OUTSIDE_WORKSPACE') {
        throw new RarsError('PATH_OUTSIDE_WORKSPACE', `Path is outside the workspace folders: ${path}`, { path });
      }
      throw error;
    }
    const stats = await stat(canonical);
    return { path: canonical, kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other' };
  };
}

function listReader(locate: Locate) {
  return async (path: string, folder: string): Promise<ListFile> => {
    let located: LocatedPath;
    try {
      located = await locate(path, folder);
    } catch (error) {
      if (error instanceof RarsError && error.code === 'PATH_OUTSIDE_WORKSPACE') {
        return { error: `List file is outside the workspace folders: ${path}` };
      }
      throw error;
    }
    if (located.kind === 'missing') return { error: `No such list file: ${path}` };
    if (located.kind !== 'file') return { error: `List file is not a file: ${path}` };
    return { path: located.path, text: await readFile(located.path, 'utf8') };
  };
}

function summarize(doFile: string, report: DoFileReport, states: readonly CompileState[]): string {
  const count = report.compiles.length;
  const folders = report.steps.flatMap((step) => (step.folder === undefined ? [] : [step.folder]));
  const lines = [
    `${basename(doFile)}: ${count} ${count === 1 ? 'file' : 'files'} to compile, ${report.missing.length} missing.`,
    `Paths resolve from ${report.cwd}, assuming Questa runs the script from its own folder.`,
    ...(folders.length === 0 ? [] : [`cd moves to ${folders.join(', then ')}.`]),
    ...report.compiles.map(({ file, resolved, library, std, list, order }, index) => {
      const shown = resolved === resolve(report.cwd, file) ? '' : ` (${relative(report.cwd, resolved) || '.'})`;
      return `${order}. ${file}${shown} into ${library}${std === undefined ? '' : `, std ${std}`}`
        + `${list === undefined ? '' : `, listed in ${list}`}${stateNotes[states[index]!]}`;
    }),
  ];
  if (report.libraries.length > 0) lines.push(`Libraries created: ${report.libraries.join(', ')}`);
  if (report.simulate === undefined) lines.push('No vsim call.');
  else lines.push(report.simulate.top === undefined ? 'vsim names no design unit.' : `Simulates ${report.simulate.top}`);
  if (report.errors.length > 0) {
    lines.push('Errors:', ...report.errors.map(({ file, line, message }) =>
      (file === undefined ? message : `${relative(report.cwd, file)}:${line}: ${message}`)));
  }
  return lines.join('\n');
}

export function createDoFileCheckHandler(deps: DoFileDependencies) {
  return async (input: DoFileCheckInput): Promise<ToolResult> => {
    if (deps.tclshExecutable === undefined) throw new Error('The Tcl shell is not configured');
    const doFile = await deps.workspace.resolve(input.path);
    if (!(await stat(doFile)).isFile()) throw new Error(`Not a file: ${input.path}`);
    const cwd = dirname(doFile);
    const locate = locator(deps.workspace);
    const run = await runDoFile({
      tclshExecutable: deps.tclshExecutable, doFile, cwd, timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes, locate,
    });
    const analysis = await analyzeSteps(run.steps, {
      folder: cwd, ...(input.std === undefined ? {} : { std: input.std }), readList: listReader(locate),
    });

    const errors = [...run.errors, ...analysis.errors];
    const compiles: CompileEntry[] = [];
    const states: CompileState[] = [];
    const missing = new Set<string>();
    for (const { folder, ...compile } of analysis.compiles) {
      let state: CompileState;
      try {
        state = (await locate(compile.file, folder)).kind;
      } catch (error) {
        if (!(error instanceof RarsError && error.code === 'PATH_OUTSIDE_WORKSPACE')) throw error;
        state = 'outside';
      }
      if (state === 'missing') missing.add(compile.file);
      else if (state === 'outside') errors.push({ message: `Compiled file is outside the workspace folders: ${compile.file}` });
      else if (state === 'directory') errors.push({ message: `Compiled path is a directory, not a file: ${compile.file}` });
      else if (state === 'other') errors.push({ message: `Compiled path is not a file: ${compile.file}` });
      compiles.push({ ...compile, resolved: resolve(folder, compile.file), exists: state !== 'missing' && state !== 'outside' });
      states.push(state);
    }

    const report: DoFileReport = {
      ok: missing.size === 0 && errors.length === 0,
      cwd,
      steps: run.steps,
      compiles,
      missing: [...missing],
      libraries: analysis.libraries,
      ...(analysis.simulate === undefined ? {} : { simulate: analysis.simulate }),
      errors,
    };
    return {
      content: [{ type: 'text', text: summarize(doFile, report, states) }],
      structuredContent: report as unknown as Record<string, unknown>,
      ...(report.ok ? {} : { isError: true }),
    };
  };
}
