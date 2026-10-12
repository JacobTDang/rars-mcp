import { stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { z } from 'zod';

import { RarsError } from '../errors.js';
import { analyzeSteps, runDoFile, vhdlStandards, type DoFileError, type DoFileStep, type LocatedPath, type StepAnalysis } from '../vhdl/dofile.js';
import type { Workspace } from '../workspace.js';
import type { ToolDependencies, ToolResult } from './handlers.js';

export const doFileCheckSchema = z.object({
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

// Questa resolves a script's paths from the folder it runs in, assumed here to be the script's own.
function locator(workspace: Workspace, cwd: string) {
  return async (path: string): Promise<LocatedPath> => {
    const target = resolve(cwd, path);
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

function summarize(doFile: string, report: DoFileReport): string {
  const count = report.compiles.length;
  const lines = [
    `${basename(doFile)}: ${count} ${count === 1 ? 'file' : 'files'} to compile, ${report.missing.length} missing.`,
    `Paths resolve from ${report.cwd}, assuming Questa runs the script from its own folder.`,
    ...report.compiles.map(({ file, library, std, exists, order }) => {
      const state = exists ? '' : report.missing.includes(file) ? ', missing' : ', outside the workspace';
      return `${order}. ${file} into ${library}${std === undefined ? '' : `, std ${std}`}${state}`;
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
    const locate = locator(deps.workspace, cwd);
    const run = await runDoFile({
      tclshExecutable: deps.tclshExecutable, doFile, cwd, timeoutMs: deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes, locate,
    });
    const analysis = analyzeSteps(run.steps, input.std);

    const errors = [...run.errors];
    const compiles: CompileEntry[] = [];
    const missing = new Set<string>();
    for (const compile of analysis.compiles) {
      let exists = false;
      try {
        exists = (await locate(compile.file)).kind === 'file';
        if (!exists) missing.add(compile.file);
      } catch (error) {
        if (!(error instanceof RarsError && error.code === 'PATH_OUTSIDE_WORKSPACE')) throw error;
        errors.push({ message: `Compiled file is outside the workspace folders: ${compile.file}` });
      }
      compiles.push({ ...compile, resolved: resolve(cwd, compile.file), exists });
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
      content: [{ type: 'text', text: summarize(doFile, report) }],
      structuredContent: report as unknown as Record<string, unknown>,
      ...(report.ok ? {} : { isError: true }),
    };
  };
}
