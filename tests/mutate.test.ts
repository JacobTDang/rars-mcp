import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { createVhdlMutateHandler } from '../src/tools/mutate.js';
import { applyMutation, discoverMutations } from '../src/vhdl/mutate.js';
import { createNvcSimulator } from '../src/vhdl/nvc.js';
import type { VhdlLimits, VhdlRunRequest, VhdlRunResult, VhdlSimulator } from '../src/vhdl/simulator.js';
import { Workspace } from '../src/workspace.js';

const simulator = process.env.VHDL_SIMULATOR ?? 'nvc';
const fixtures = resolve('tests/fixtures/vhdl');

interface MutateReport {
  baseline: { ok: boolean; perTestbench: Array<{ top: string } & VhdlRunResult> };
  mutations: Array<{ name: string; line: number; caught: boolean; caughtBy: string[]; missedBy: string[] }>;
  score?: { caught: number; total: number; ratio: number };
  capped?: { found: number; limit: number };
}

// nvc's library folders go to the temporary folder, which vhdl.test.ts checks for leftovers while
// it runs alongside this file; a private one keeps the two apart.
const systemTmpdir = process.env.TMPDIR;
let privateTmpdir: string;
beforeAll(async () => {
  privateTmpdir = await mkdtemp(join(tmpdir(), 'vhdl-mutate-tmp-'));
  process.env.TMPDIR = privateTmpdir;
});
afterAll(async () => {
  if (systemTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = systemTmpdir;
  await rm(privateTmpdir, { recursive: true, force: true });
});

function simulatorAvailable(): boolean {
  const result = spawnSync(simulator, ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

async function workspaceWith(files: string[], written: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vhdl-mutate-')));
  await Promise.all(files.map((file) => copyFile(join(fixtures, file), join(root, file))));
  await Promise.all(Object.entries(written).map(([file, text]) => writeFile(join(root, file), text)));
  return root;
}

async function mutantFolders(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('vhdl-mutant-'));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? '').join('\n');
}

const passed: VhdlRunResult = {
  ok: true, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, diagnostics: [], messages: [],
};

// Stands in for the simulator and records every run it is asked for.
function recordingSimulator() {
  const runs: Array<{ request: VhdlRunRequest; limits: VhdlLimits }> = [];
  const vhdl: VhdlSimulator = {
    compile: async () => { throw new Error('vhdl_mutate only runs testbenches'); },
    run: async (request, limits) => { runs.push({ request, limits }); return passed; },
  };
  return { vhdl, runs };
}

// The real simulator, counting the runs it makes.
function countingNvc() {
  const nvc = createNvcSimulator({ executable: simulator });
  const runs: VhdlRunRequest[] = [];
  const vhdl: VhdlSimulator = {
    compile: nvc.compile,
    run: (request, limits) => { runs.push(request); return nvc.run(request, limits); },
  };
  return { vhdl, runs };
}

async function mutateHandler(root: string, vhdl: VhdlSimulator, timeoutMs = 10_000) {
  return createVhdlMutateHandler({ workspace: await Workspace.create(root), vhdl, timeoutMs, maxOutputBytes: 1024 * 1024 });
}

const adderBenches = [
  { top: 'adder_tb', files: ['adder.vhd', 'adder_tb.vhd'] },
  { top: 'adder_weak_tb', files: ['adder.vhd', 'adder_weak_tb.vhd'] },
];

describe('applyMutation', () => {
  it('replaces every match and reports the line of the first', () => {
    expect(applyMutation('a + b\nc + d\n', { find: '+', replace: '-' })).toEqual({
      name: '+ -> -', line: 1, source: 'a - b\nc - d\n',
    });
  });

  it('replaces only the chosen occurrence', () => {
    expect(applyMutation('a + b\nc + d\n', { find: '+', replace: '-', occurrence: 2 })).toEqual({
      name: '+ -> - (occurrence 2)', line: 2, source: 'a + b\nc - d\n',
    });
    expect(applyMutation('a + b\nc + d\n', { name: 'second sum', find: '+', replace: '-', occurrence: 2 }).name).toBe('second sum');
  });

  it('names a find that does not match', () => {
    expect(() => applyMutation('a + b\n', { name: 'times', find: 'a * b', replace: 'a / b' })).toThrow(
      'Mutation "times": "a * b" is not in the file',
    );
  });

  it('refuses an occurrence past the last match', () => {
    expect(() => applyMutation('a + b\nc + d\n', { find: '+', replace: '-', occurrence: 3 })).toThrow(
      'Mutation "+ -> - (occurrence 3)": "+" occurs 2 times, so there is no occurrence 3',
    );
  });

  it('refuses a mutation that changes nothing', () => {
    expect(() => applyMutation('a + b\n', { find: '+', replace: '+' })).toThrow('Mutation "+ -> +" changes nothing');
  });
});

describe('discoverMutations', () => {
  it('finds each operator, one mutation per occurrence, named by line', () => {
    const source = [
      'architecture rtl of demo is',
      "  signal s : unsigned(N-1 downto 0) := (others => '0');",
      'begin',
      '  y <= a + b - c;',
      "  z <= '1' when a = b else '0';",
      '  process (all)',
      '  begin',
      '    if a < b and not c then',
      '      w <= x or y;',
      '    elsif a >= b then',
      '      v := a <= b;',
      '    end if;',
      '    assert a /= b and c > d report "a - b <= 0" severity error;',
      '  end process;',
      'end architecture rtl;',
    ].join('\n');

    expect(discoverMutations(source).mutants.map(({ name, line }) => ({ name, line }))).toEqual([
      { name: 'line 4: + -> -', line: 4 },
      { name: 'line 4: - -> +', line: 4 },
      { name: "line 5: '1' -> '0'", line: 5 },
      { name: 'line 5: = -> /=', line: 5 },
      { name: "line 5: '0' -> '1'", line: 5 },
      { name: 'line 8: < -> >=', line: 8 },
      { name: 'line 8: and -> or', line: 8 },
      { name: 'line 8: remove not', line: 8 },
      { name: 'line 9: or -> and', line: 9 },
      { name: 'line 10: >= -> <', line: 10 },
      { name: 'line 11: <= -> >', line: 11 },
      { name: 'line 13: /= -> =', line: 13 },
      { name: 'line 13: and -> or', line: 13 },
      { name: 'line 13: > -> <=', line: 13 },
    ]);
  });

  it('changes one spot in each mutated copy', () => {
    const source = "  y <= a + b;\n  z <= not a;\n  q <= '1';\n";

    expect(discoverMutations(source).mutants.map((mutant) => mutant.source)).toEqual([
      "  y <= a - b;\n  z <= not a;\n  q <= '1';\n",
      "  y <= a + b;\n  z <= a;\n  q <= '1';\n",
      "  y <= a + b;\n  z <= not a;\n  q <= '0';\n",
    ]);
  });

  it('leaves comments, strings, declarations, attributes and signal assignments alone', () => {
    const source = [
      "-- y <= a + b when c = '1';",
      '/* a < b and not c */',
      'entity e is',
      "  port (a : in std_logic_vector(N-1 downto 0) := (others => '1'); y : out bit);",
      'end entity e;',
      'architecture rtl of e is',
      "  constant ONE : std_logic := '1';",
      'begin',
      '  dut : entity work.core port map (x => a(N-1), y => y);',
      '  report "a + b <= c";',
      "  wait until clk'event;",
      "  t <= x\"FF\" & 16#F#E+2;",
      'end architecture rtl;',
    ].join('\n');

    expect(discoverMutations(source)).toEqual({ mutants: [], found: 0 });
  });

  it('keeps character literals apart from attributes and choices', () => {
    const source = [
      "  if clk'event and clk = '1' then",
      "    q <= std_logic'('1');",
      '  end if;',
      "  with sel select y <= '0' when '1', '1' when others;",
    ].join('\n');

    expect(discoverMutations(source).mutants.map((mutant) => mutant.name)).toEqual([
      'line 1: and -> or',
      'line 1: = -> /=',
      "line 2: '1' -> '0'",
      "line 4: '0' -> '1'",
      "line 4: '1' -> '0'",
    ]);
  });

  it('builds only the first mutations up to the limit and counts the rest', () => {
    const { mutants, found } = discoverMutations('  y <= a + b - c + d;\n', 2);

    expect(mutants.map((mutant) => mutant.name)).toEqual(['line 1: + -> -', 'line 1: - -> +']);
    expect(found).toBe(3);
  });

  it('swaps only binary + and -, as numeric_std has no unary + for signed', () => {
    const source = '  tmp := -signed(b);\n  y <= a - (-b) + 1;\n  if x > -1 then\n';

    expect(discoverMutations(source).mutants.map((mutant) => mutant.name)).toEqual([
      'line 2: - -> +', 'line 2: + -> -', 'line 3: > -> <=',
    ]);
  });

  it('keeps the case of a word operator', () => {
    expect(discoverMutations('  y <= a AND b;\n').mutants).toMatchObject([{ name: 'line 1: AND -> OR', source: '  y <= a OR b;\n' }]);
  });
});

describe('vhdl_mutate without a simulator run', () => {
  it('refuses a testbench that does not list the design file', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd', 'adder_weak_tb.vhd']);
    const { vhdl, runs } = recordingSimulator();
    const handler = await mutateHandler(root, vhdl);

    await expect(handler({
      file: 'adder.vhd', testbenches: [adderBenches[0]!, { top: 'adder_weak_tb', files: ['adder_weak_tb.vhd'] }],
    })).rejects.toThrow('Testbench adder_weak_tb does not list adder.vhd in its files');
    expect(runs).toEqual([]);
  });

  it('runs the baseline, then each mutated copy in place of the design, with the requested limits', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd']);
    const { vhdl, runs } = recordingSimulator();
    const handler = await mutateHandler(root, vhdl);

    await handler({
      file: 'adder.vhd', testbenches: [adderBenches[0]!], mutations: [{ find: '+', replace: '-' }],
      std: '02', stopTime: '1 us', timeoutMs: 1234,
    });

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      request: {
        testbench: 'adder_tb', files: [join(root, 'adder.vhd'), join(root, 'adder_tb.vhd')], std: '02', work: 'work', stopTime: '1 us',
      },
      limits: { timeoutMs: 1234, maxOutputBytes: 1024 * 1024 },
    });
    const mutated = runs[1]!.request.files;
    expect(mutated[0]).toMatch(/vhdl-mutant-.*adder\.vhd$/);
    expect(mutated[1]).toBe(join(root, 'adder_tb.vhd'));
    expect(runs[1]!.limits.timeoutMs).toBe(1234);
  });

  it('caps the built-in mutations at 64 and says so', async () => {
    const lines = Array.from({ length: 70 }, (_, index) => `  y${index} <= a + b;`);
    const root = await workspaceWith(['adder_tb.vhd'], { 'adder.vhd': `${lines.join('\n')}\n` });
    const { vhdl, runs } = recordingSimulator();
    const handler = await mutateHandler(root, vhdl);

    const result = await handler({ file: 'adder.vhd', testbenches: [adderBenches[0]!] });

    const report = result.structuredContent as unknown as MutateReport;
    expect(result.isError).toBeFalsy();
    expect(report.mutations).toHaveLength(64);
    expect(report.capped).toEqual({ found: 70, limit: 64 });
    expect(report.score).toEqual({ caught: 0, total: 64, ratio: 0 });
    expect(runs).toHaveLength(65);
    expect(textOf(result)).toContain('Found 70 mutations; ran the first 64.');
  });

  it('refuses a design with nothing to mutate', async () => {
    const root = await workspaceWith(['adder_tb.vhd'], { 'adder.vhd': 'entity adder is\nend entity adder;\n' });
    const { vhdl, runs } = recordingSimulator();
    const handler = await mutateHandler(root, vhdl);

    await expect(handler({ file: 'adder.vhd', testbenches: [adderBenches[0]!] })).rejects.toThrow(
      'No built-in mutations apply to adder.vhd; pass mutations instead',
    );
    expect(runs).toEqual([]);
  });

  it('refuses to run without a configured simulator', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd']);
    const handler = createVhdlMutateHandler({ workspace: await Workspace.create(root), timeoutMs: 1000, maxOutputBytes: 1024 });

    await expect(handler({ file: 'adder.vhd', testbenches: [adderBenches[0]!] })).rejects.toThrow('VHDL simulator is not configured');
  });
});

describe('vhdl_mutate on the MCP server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const workspace = await Workspace.create(await mkdtemp(join(tmpdir(), 'vhdl-server-')));
    const server = createMcpServer({ workspace } as never);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await server.close(); };
    return client;
  }

  it('advertises vhdl_mutate with its options', async () => {
    const client = await connect();

    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'vhdl_mutate');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        file: { type: 'string' },
        testbenches: {
          type: 'array',
          items: { type: 'object', properties: { top: { type: 'string' }, files: { type: 'array' } }, required: ['top', 'files'] },
        },
        mutations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, occurrence: { type: 'integer' } },
            required: ['find', 'replace'],
          },
        },
        std: { enum: ['93', '02', '08', '19'] },
        stopTime: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
      required: ['file', 'testbenches'],
    });
  });

  it('rejects invalid options before running anything', async () => {
    const client = await connect();
    const bench = { top: 'adder_tb', files: ['adder.vhd', 'adder_tb.vhd'] };

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ file: 'adder.vhd', testbenches: [] }, 'testbenches'],
      [{ file: 'adder.vhd', testbenches: [{ top: '-rf', files: ['adder.vhd'] }] }, 'top'],
      [{ file: 'adder.vhd', testbenches: [bench], mutations: [] }, 'mutations'],
      [{ file: 'adder.vhd', testbenches: [bench], mutations: [{ find: '', replace: '-' }] }, 'find'],
      [{ file: 'adder.vhd', testbenches: [bench], mutations: [{ find: '+', replace: '-', occurrence: 0 }] }, 'occurrence'],
      [{ file: 'adder.vhd', testbenches: [bench], stopTime: 'soon' }, 'stopTime'],
      [{ file: 'adder.vhd', testbenches: [bench], timeoutMs: 0 }, 'timeoutMs'],
    ];
    for (const [input, message] of cases) {
      const result = await client.callTool({ name: 'vhdl_mutate', arguments: input });
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.stringify(result.content), JSON.stringify(input)).toContain(message);
    }
  });
});

describe.runIf(simulatorAvailable())('vhdl_mutate with nvc', { timeout: 60_000 }, () => {
  it('reports that the good testbench catches + -> - and the weak one misses it', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd', 'adder_weak_tb.vhd']);
    const handler = await mutateHandler(root, createNvcSimulator({ executable: simulator }));

    const result = await handler({ file: 'adder.vhd', testbenches: adderBenches, mutations: [{ find: '+', replace: '-' }] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      baseline: { ok: true, perTestbench: [{ top: 'adder_tb', ok: true }, { top: 'adder_weak_tb', ok: true }] },
      mutations: [{ name: '+ -> -', line: 18, caught: true, caughtBy: ['adder_tb'], missedBy: ['adder_weak_tb'] }],
      score: { caught: 1, total: 1, ratio: 1 },
    });
    expect(textOf(result)).toBe('mutation | caught by | missed by\n+ -> - | adder_tb | adder_weak_tb\nscore: 1/1');
  });

  it('scores a mutation that no testbench catches as missed', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_weak_tb.vhd']);
    const handler = await mutateHandler(root, createNvcSimulator({ executable: simulator }));

    const result = await handler({ file: 'adder.vhd', testbenches: [adderBenches[1]!], mutations: [{ find: '+', replace: '-' }] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      mutations: [{ name: '+ -> -', caught: false, caughtBy: [], missedBy: ['adder_weak_tb'] }],
      score: { caught: 0, total: 1, ratio: 0 },
    });
    expect(textOf(result)).toBe('mutation | caught by | missed by\n+ -> - | - | adder_weak_tb\nscore: 0/1');
  });

  it('stops when a testbench fails on the unmutated design', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd', 'failing_tb.vhd']);
    const { vhdl, runs } = countingNvc();
    const handler = await mutateHandler(root, vhdl);

    const result = await handler({
      file: 'adder.vhd',
      testbenches: [adderBenches[0]!, { top: 'failing_tb', files: ['adder.vhd', 'failing_tb.vhd'] }],
      mutations: [{ find: '+', replace: '-' }],
    });

    expect(result.isError).toBe(true);
    expect(runs).toHaveLength(2);
    const report = result.structuredContent as unknown as MutateReport;
    expect(report).toMatchObject({
      baseline: {
        ok: false,
        perTestbench: [
          { top: 'adder_tb', ok: true },
          { top: 'failing_tb', ok: false, messages: [{ severity: 'error', text: 'count is 5, expected 4' }] },
        ],
      },
      mutations: [],
    });
    expect(report.score).toBeUndefined();
    expect(textOf(result)).toContain('Baseline failed, so no mutations were run.');
    expect(textOf(result)).toContain('failing_tb failed');
    expect(textOf(result)).toContain('count is 5, expected 4');
  });

  it('names an unmatched find before running anything', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd']);
    const { vhdl, runs } = countingNvc();
    const handler = await mutateHandler(root, vhdl);

    await expect(handler({
      file: 'adder.vhd', testbenches: [adderBenches[0]!], mutations: [{ find: '+', replace: '-' }, { find: 'a * b', replace: 'a / b' }],
    })).rejects.toThrow('Mutation "a * b -> a / b": "a * b" is not in the file');
    expect(runs).toEqual([]);
  });

  it('discovers the operators in the design and names them by line', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd', 'adder_weak_tb.vhd']);
    const handler = await mutateHandler(root, createNvcSimulator({ executable: simulator }));

    const result = await handler({ file: 'adder.vhd', testbenches: adderBenches });

    const caught = { caught: true, caughtBy: ['adder_tb'], missedBy: ['adder_weak_tb'] };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      baseline: { ok: true },
      mutations: [
        { name: 'line 18: + -> -', line: 18, ...caught },
        { name: "line 21: '1' -> '0'", line: 21, ...caught },
        { name: 'line 21: = -> /=', line: 21, ...caught },
        { name: "line 21: '0' -> '1'", line: 21, ...caught },
      ],
      score: { caught: 4, total: 4, ratio: 1 },
    });
    expect(result.structuredContent).not.toHaveProperty('capped');
    expect(textOf(result)).toBe([
      'mutation | caught by | missed by',
      'line 18: + -> - | adder_tb | adder_weak_tb',
      "line 21: '1' -> '0' | adder_tb | adder_weak_tb",
      'line 21: = -> /= | adder_tb | adder_weak_tb',
      "line 21: '0' -> '1' | adder_tb | adder_weak_tb",
      'score: 4/4',
    ].join('\n'));
  });

  it('removes its temporary folder and leaves the workspace as it was', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd']);
    const handler = await mutateHandler(root, createNvcSimulator({ executable: simulator }));
    const before = await mutantFolders();

    await handler({ file: 'adder.vhd', testbenches: [adderBenches[0]!], mutations: [{ find: '+', replace: '-' }] });

    expect(await mutantFolders()).toEqual(before);
    expect((await readdir(root)).sort()).toEqual(['adder.vhd', 'adder_tb.vhd']);
    expect(await readFile(join(root, 'adder.vhd'), 'utf8')).toBe(await readFile(join(fixtures, 'adder.vhd'), 'utf8'));
  });

  it('names a mutation that does not analyse and still removes its temporary folder', async () => {
    const root = await workspaceWith(['adder.vhd', 'adder_tb.vhd']);
    const handler = await mutateHandler(root, createNvcSimulator({ executable: simulator }));
    const before = await mutantFolders();

    await expect(handler({
      file: 'adder.vhd', testbenches: [adderBenches[0]!], mutations: [{ name: 'typo', find: 'carry <= total(4);', replace: 'carry <= totl(4);' }],
    })).rejects.toThrow(/^Mutation "typo" does not analyse: line 20: /);
    expect(await mutantFolders()).toEqual(before);
  });
});
