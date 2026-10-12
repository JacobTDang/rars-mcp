// Reads signal values at chosen times from a Value Change Dump (IEEE 1364, section 18). The text
// arrives in chunks and only the requested signals are kept, so memory follows the query, not the file.

export type WaveValue =
  | { bits: string; hex: string | null; unsigned: number | string | null; signed: number | string | null }
  | { real: number | null }
  | { string: string | null };

export interface WaveSignal {
  name: string;
  width: number;
  type: string;
}

export interface WaveQuery {
  signals: string[];
  times: string[];
}

export interface WaveQueryResult {
  timescale: string | null;
  signals: WaveSignal[];
  values: Array<Record<string, string | WaveValue>>;
}

type Kind = 'bits' | 'real' | 'string';

interface Variable extends WaveSignal {
  id: string;
  kind: Kind;
  // Last part of the name, and the names it answers to: without and with its declared bit range.
  leaf: string;
  keys: string[];
}

interface Timescale {
  magnitude: bigint;
  exponent: number;
  label: string;
}

const UNIT_EXPONENTS: Readonly<Record<string, number>> = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };
const TIME = /^(\d+(?:\.\d*)?|\.\d+)\s*(fs|ps|ns|us|ms|s)?$/i;
const STATES = /^[01xzuwlh-]+$/i;
const LISTED_NAMES = 20;

export async function queryVcd(chunks: AsyncIterable<string> | Iterable<string>, query: WaveQuery): Promise<WaveQueryResult> {
  const definitions = new Definitions();
  let dump: Dump | undefined;
  for await (const tokens of tokenBatches(chunks)) {
    for (const token of tokens) {
      if (dump === undefined) {
        if (definitions.read(token)) dump = new Dump(definitions, query);
      } else if (dump.read(token)) {
        // Every requested time is behind us, so the rest of the file cannot change the answer.
        return dump.finish();
      }
    }
  }
  if (dump === undefined) throw new Error('Not a VCD file: it ends before $enddefinitions');
  return dump.finish();
}

// Whitespace-separated tokens, one batch per chunk, with a token split across chunks joined again.
async function* tokenBatches(chunks: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string[]> {
  let partial = '';
  for await (const chunk of chunks) {
    const tokens = (partial + chunk).split(/\s+/);
    partial = tokens.pop()!;
    yield tokens.filter((token) => token !== '');
  }
  if (partial !== '') yield [partial];
}

const clip = (token: string): string => (token.length > 40 ? `${token.slice(0, 40)}...` : token);

class Definitions {
  readonly variables: Variable[] = [];
  timescale: Timescale | undefined;
  private readonly scopes: string[] = [];
  private keyword: string | undefined;
  private body: string[] = [];

  // True once $enddefinitions has been read.
  read(token: string): boolean {
    if (this.keyword === undefined) {
      if (!token.startsWith('$')) throw new Error(`Not a VCD file: unexpected "${clip(token)}" in the header`);
      this.keyword = token;
      this.body = [];
      return false;
    }
    if (token !== '$end') {
      this.body.push(token);
      return false;
    }
    const keyword = this.keyword;
    this.keyword = undefined;
    return this.declare(keyword, this.body);
  }

  private declare(keyword: string, body: string[]): boolean {
    const declaration = () => `"${[keyword, ...body, '$end'].join(' ')}"`;
    switch (keyword) {
      case '$scope': {
        if (body[1] === undefined) throw new Error(`Cannot read VCD declaration ${declaration()}`);
        this.scopes.push(body[1]);
        return false;
      }
      case '$upscope':
        if (this.scopes.pop() === undefined) throw new Error('Cannot read VCD declaration: $upscope without a matching $scope');
        return false;
      case '$var': {
        const [type, size, id, reference, ...range] = body;
        if (type === undefined || size === undefined || !/^\d+$/.test(size) || id === undefined || reference === undefined) {
          throw new Error(`Cannot read VCD declaration ${declaration()}`);
        }
        this.variables.push(variable(this.scopes, type, Number(size), id, reference + range.join('')));
        return false;
      }
      case '$timescale': {
        const match = /^(1|10|100)(s|ms|us|ns|ps|fs)$/i.exec(body.join(''));
        if (match === null) throw new Error(`Cannot read VCD declaration ${declaration()}`);
        const unit = match[2]!.toLowerCase();
        this.timescale = { magnitude: BigInt(match[1]!), exponent: UNIT_EXPONENTS[unit]!, label: `${match[1]} ${unit}` };
        return false;
      }
      case '$enddefinitions':
        return true;
      default:
        return false;
    }
  }
}

function variable(scopes: string[], type: string, width: number, id: string, reference: string): Variable {
  // nvc writes the range into the name, s_a[3:0]; other writers give it as its own token.
  const ranged = /^(.+?)(\[\d+:\d+\])$/.exec(reference);
  const leaf = ranged === null ? reference : ranged[1]!;
  const name = [...scopes, leaf].join('.');
  const kind: Kind = ['real', 'realtime', 'shortreal'].includes(type) ? 'real' : type === 'string' ? 'string' : 'bits';
  return { name, width, type, id, kind, leaf, keys: ranged === null ? [name] : [name, `${name}${ranged[2]}`] };
}

class Dump {
  private readonly signals: Variable[] = [];
  private readonly watched = new Map<string, Variable>();
  private readonly current = new Map<string, string | number>();
  // Requested times in ascending order, each answered once the dump moves past it.
  private readonly pending: Array<{ index: number; ticks: bigint }>;
  private readonly rows: Array<Array<string | number | undefined>> = [];
  private readonly timescale: Timescale | undefined;
  private answered = 0;
  private time: bigint | undefined;
  private value: string | undefined;
  private skipping = false;

  constructor(definitions: Definitions, private readonly query: WaveQuery) {
    this.timescale = definitions.timescale;
    const lookup = new Map<string, Variable[]>();
    for (const variable of definitions.variables) {
      for (const key of variable.keys.map((name) => name.toLowerCase())) {
        const matches = lookup.get(key) ?? [];
        matches.push(variable);
        lookup.set(key, matches);
      }
    }
    for (const requested of query.signals) {
      const found = resolve(requested, lookup, definitions.variables);
      if (this.signals.some((signal) => signal.name === found.name)) continue;
      this.signals.push(found);
      this.watched.set(found.id, found);
    }
    this.pending = query.times
      .map((time, index) => ({ index, ticks: ticks(time, this.timescale) }))
      .sort((left, right) => (left.ticks < right.ticks ? -1 : left.ticks > right.ticks ? 1 : 0));
  }

  // True once every requested time has been answered.
  read(token: string): boolean {
    if (this.skipping) {
      this.skipping = token !== '$end';
      return false;
    }
    if (this.value !== undefined) {
      this.change(this.value, token);
      this.value = undefined;
      return false;
    }
    const first = token[0]!;
    if (first === '#') return this.advance(token);
    if (first === '$') {
      // These only bracket value changes; any other section, such as $comment, is skipped.
      this.skipping = !['$dumpvars', '$dumpall', '$dumpon', '$dumpoff', '$end'].includes(token);
    } else if ('bBrRsS'.includes(first)) {
      this.value = token;
    } else if (STATES.test(first) && token.length > 1) {
      this.change(first, token.slice(1));
    } else {
      throw new Error(`Cannot read VCD value change "${clip(token)}" at #${this.time ?? 0}`);
    }
    return false;
  }

  finish(): WaveQueryResult {
    this.answer(undefined);
    return {
      timescale: this.timescale?.label ?? null,
      signals: this.signals.map(({ name, width, type }) => ({ name, width, type })),
      values: this.query.times.map((time, index) => Object.fromEntries([
        ['time', time],
        ...this.signals.map((signal, column) => [signal.name, waveValue(signal, this.rows[index]![column])]),
      ])),
    };
  }

  private advance(token: string): boolean {
    if (!/^#\d+$/.test(token)) throw new Error(`Cannot read VCD time "${clip(token)}"`);
    const time = BigInt(token.slice(1));
    if (this.time !== undefined && time < this.time) throw new Error(`VCD time goes backwards: ${token} after #${this.time}`);
    this.answer(time);
    this.time = time;
    return this.answered === this.pending.length;
  }

  // Records the current values for every pending time before `until`, or for all of them.
  private answer(until: bigint | undefined): void {
    while (this.answered < this.pending.length && (until === undefined || this.pending[this.answered]!.ticks < until)) {
      this.rows[this.pending[this.answered]!.index] = this.signals.map((signal) => this.current.get(signal.id));
      this.answered += 1;
    }
  }

  private change(value: string, id: string): void {
    const kind = value.length === 1 ? 'bits' : ({ b: 'bits', r: 'real', s: 'string' } as const)[value[0]!.toLowerCase() as 'b' | 'r' | 's'];
    const text = value.length === 1 ? value : value.slice(1);
    const where = () => `"${clip(value)} ${clip(id)}" at #${this.time ?? 0}`;
    let parsed: string | number = text;
    if (kind === 'bits') {
      if (!STATES.test(text)) throw new Error(`Cannot read VCD value change ${where()}`);
      parsed = text.toLowerCase();
    } else if (kind === 'real') {
      parsed = Number(text);
      if (text === '' || Number.isNaN(parsed)) throw new Error(`Cannot read VCD value change ${where()}`);
    }
    const signal = this.watched.get(id);
    if (signal === undefined) return;
    if (kind !== signal.kind) throw new Error(`VCD value change ${where()} does not fit ${signal.type} signal ${signal.name}`);
    this.current.set(id, kind === 'bits' ? extend(parsed as string, signal) : parsed);
  }
}

function resolve(requested: string, lookup: Map<string, Variable[]>, variables: Variable[]): Variable {
  const parts = requested.split(/[./]/).filter((part) => part !== '');
  const name = parts.join('.');
  const candidates = lookup.get(name.toLowerCase()) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const exact = candidates.filter((candidate) => candidate.keys.includes(name));
    if (exact.length === 1) return exact[0]!;
    throw new Error(`Signal ${requested} is ambiguous: ${candidates.map((candidate) => candidate.name).join(', ')}`);
  }
  const leaf = (parts.at(-1) ?? '').replace(/\[\d+:\d+\]$/, '');
  const sameLeaf = variables.filter((candidate) => candidate.leaf.toLowerCase() === leaf.toLowerCase());
  const listing = (names: Variable[]) => `(${names.length > LISTED_NAMES ? `${LISTED_NAMES} of ` : ''}${names.length}): `
    + names.slice(0, LISTED_NAMES).map((candidate) => candidate.name).join(', ');
  if (sameLeaf.length > 0) throw new Error(`Unknown signal ${requested}. Signals named ${leaf} ${listing(sameLeaf)}`);
  if (variables.length === 0) throw new Error(`Unknown signal ${requested}. The file declares no signals`);
  throw new Error(`Unknown signal ${requested}. No signal is named ${leaf}; signals in the file ${listing(variables)}`);
}

// A time in whole ticks of the timescale. A change only happens on a whole tick, so a time between
// two ticks rounds down to the tick before it, which still finds the last change at or before it.
function ticks(time: string, timescale: Timescale | undefined): bigint {
  const match = TIME.exec(time.trim());
  if (match === null) {
    throw new Error(`Cannot read time "${time}"; use a number with an optional unit (fs, ps, ns, us, ms, s), such as "20 ns"`);
  }
  const [whole = '', fraction = ''] = match[1]!.split('.');
  const digits = BigInt(`${whole}${fraction}` || '0');
  let exponent = -fraction.length;
  let divisor = 1n;
  if (match[2] !== undefined) {
    if (timescale === undefined) {
      throw new Error(`The VCD file has no $timescale, so "${time}" needs to be a bare number of time units`);
    }
    exponent += UNIT_EXPONENTS[match[2].toLowerCase()]! - timescale.exponent;
    divisor = timescale.magnitude;
  }
  return exponent >= 0 ? digits * 10n ** BigInt(exponent) / divisor : digits / (divisor * 10n ** BigInt(-exponent));
}

// A value shorter than its signal is padded on the left: with 0 after a 0 or 1, otherwise with its first state.
function extend(bits: string, signal: Variable): string {
  if (bits.length > signal.width) {
    throw new Error(`VCD value b${clip(bits)} is wider than the ${signal.width} bits of ${signal.name}`);
  }
  return (bits[0] === '1' ? '0' : bits[0]!).repeat(signal.width - bits.length) + bits;
}

function waveValue(signal: Variable, value: string | number | undefined): WaveValue {
  if (signal.kind === 'real') return { real: (value as number | undefined) ?? null };
  if (signal.kind === 'string') return { string: (value as string | undefined) ?? null };
  const bits = (value as string | undefined) ?? 'x'.repeat(signal.width);
  if (!/^[01]+$/.test(bits)) return { bits, hex: null, unsigned: null, signed: null };
  const unsigned = BigInt(`0b${bits}`);
  const signed = bits[0] === '1' ? unsigned - (1n << BigInt(bits.length)) : unsigned;
  return {
    bits,
    hex: `0x${unsigned.toString(16).padStart(Math.ceil(bits.length / 4), '0')}`,
    unsigned: jsonInteger(unsigned),
    signed: jsonInteger(signed),
  };
}

// JSON numbers lose precision past 2^53, so larger values are given as decimal strings.
function jsonInteger(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
