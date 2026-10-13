import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { applyMutation, discoverMutations, type Mutant } from '../vhdl/mutate.js';
import type { VhdlRunResult } from '../vhdl/simulator.js';
import { timeoutMsSchema } from './schemas.js';
import { describeRun, files, identifier, std, stopTime, type VhdlToolDependencies } from './vhdl.js';

// Built-in mutations run every testbench once each, so their number is bounded.
const MUTATION_LIMIT = 64;

export const vhdlMutateSchema = z.strictObject({
  file: z.string().min(1).describe('Design file to mutate; every testbench must list it in its files'),
  testbenches: z.array(z.strictObject({
    top: identifier.describe('Testbench entity to elaborate and run'),
    files,
  })).min(1).describe('Testbenches to score; one catches a mutation when it exits non-zero or raises an error assertion'),
  mutations: z.array(z.strictObject({
    name: z.string().min(1).describe('Label for the results, "find -> replace" by default').optional(),
    find: z.string().min(1).describe('Exact text to replace'),
    replace: z.string().describe('Text to put in its place'),
    occurrence: z.number().int().positive().describe('Replace only this match, counting from 1; every match by default').optional(),
  })).min(1).describe(`Literal substitutions; without them, one mutation per operator found in the file, up to ${MUTATION_LIMIT}`).optional(),
  std,
  stopTime,
  timeoutMs: timeoutMsSchema.describe('Wall-clock limit for each simulator run, in milliseconds').optional(),
});

export type VhdlMutateInput = z.infer<typeof vhdlMutateSchema>;

interface MutationResult {
  name: string;
  line: number;
  caught: boolean;
  caughtBy: string[];
  missedBy: string[];
}

function mutantsFor(source: string, input: VhdlMutateInput): { mutants: Mutant[]; found: number } {
  if (input.mutations !== undefined) {
    return { mutants: input.mutations.map((spec) => applyMutation(source, spec)), found: input.mutations.length };
  }
  const discovered = discoverMutations(source, MUTATION_LIMIT);
  if (discovered.found === 0) throw new Error(`No built-in mutations apply to ${input.file}; pass mutations instead`);
  return discovered;
}

function table(results: MutationResult[]): string[] {
  const list = (tops: string[]) => (tops.length === 0 ? '-' : tops.join(', '));
  return ['mutation | caught by | missed by', ...results.map(({ name, caughtBy, missedBy }) => `${name} | ${list(caughtBy)} | ${list(missedBy)}`)];
}

export function createVhdlMutateHandler(deps: VhdlToolDependencies) {
  // Parsed again here because a direct handler call does not pass through the tool schema.
  return async (rawInput: VhdlMutateInput): Promise<CallToolResult> => {
    const input = vhdlMutateSchema.parse(rawInput);
    if (deps.vhdl === undefined) throw new Error('VHDL simulator is not configured');
    const vhdl = deps.vhdl;
    const design = await deps.workspace.resolve(input.file);
    const testbenches = await Promise.all(input.testbenches.map(async ({ top, files: paths }) => {
      const resolved = await Promise.all(paths.map((path) => deps.workspace.resolve(path)));
      if (!resolved.includes(design)) throw new Error(`Testbench ${top} does not list ${input.file} in its files`);
      return { top, files: resolved };
    }));
    // Every mutation is checked before anything runs, so a stale list fails at once.
    const { mutants, found } = mutantsFor(await readFile(design, 'utf8'), input);

    // Runs one at a time, each with its own time limit, to keep the load bounded.
    const run = (top: string, paths: string[]) => vhdl.run({
      files: paths, std: input.std ?? '08', work: 'work', testbench: top,
      ...(input.stopTime === undefined ? {} : { stopTime: input.stopTime }),
    }, { timeoutMs: input.timeoutMs ?? deps.timeoutMs, maxOutputBytes: deps.maxOutputBytes });

    const perTestbench: Array<{ top: string } & VhdlRunResult> = [];
    for (const { top, files: paths } of testbenches) perTestbench.push({ top, ...await run(top, paths) });
    const baseline = { ok: perTestbench.every((result) => result.ok), perTestbench };
    // A testbench that fails on the real design would count every mutation as caught.
    if (!baseline.ok) {
      const failures = perTestbench.filter((result) => !result.ok).flatMap((result) => describeRun(result.top, '', result));
      return {
        content: [{ type: 'text', text: ['Baseline failed, so no mutations were run.', ...failures].join('\n') }],
        structuredContent: { baseline, mutations: [] },
        isError: true,
      };
    }

    // The mutated copy keeps the design's file name, in a private folder, so the workspace is never touched.
    const folder = await mkdtemp(join(tmpdir(), 'vhdl-mutant-'));
    const results: MutationResult[] = [];
    try {
      const mutated = join(folder, basename(design));
      for (const mutant of mutants) {
        await writeFile(mutated, mutant.source);
        const caughtBy: string[] = [];
        const missedBy: string[] = [];
        for (const { top, files: paths } of testbenches) {
          const result = await run(top, paths.map((path) => (path === design ? mutated : path)));
          // A copy that does not analyse fails every testbench without testing any of them.
          const broken = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error' && diagnostic.file === mutated);
          if (broken !== undefined) throw new Error(`Mutation "${mutant.name}" does not analyse: line ${broken.line}: ${broken.message}`);
          (result.ok ? missedBy : caughtBy).push(top);
        }
        results.push({ name: mutant.name, line: mutant.line, caught: caughtBy.length > 0, caughtBy, missedBy });
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    const caught = results.filter((result) => result.caught).length;
    const score = { caught, total: results.length, ratio: caught / results.length };
    const capped = found > mutants.length;
    return {
      content: [{
        type: 'text',
        text: [
          ...(capped ? [`Found ${found} mutations; ran the first ${mutants.length}.`] : []),
          ...table(results),
          `score: ${caught}/${results.length}`,
        ].join('\n'),
      }],
      structuredContent: { baseline, mutations: results, score, ...(capped ? { capped: { found, limit: MUTATION_LIMIT } } : {}) },
    };
  };
}
