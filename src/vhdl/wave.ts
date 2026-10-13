// What a waveform query asks for and returns, shared by the VCD and FST readers: requested signals
// are found by name, and the value each one holds is sampled at every requested time.

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

export interface WaveRow {
  time: string;
  // Set when the time is before the first timestamp or after the last one, so its values were not recorded.
  beyond?: 'before' | 'after';
  [signal: string]: string | WaveValue;
}

export interface WaveQueryResult {
  timescale: string | null;
  // The first and last timestamps of the dump.
  startTime: string;
  endTime: string;
  signals: WaveSignal[];
  values: WaveRow[];
}

export type WaveKind = 'bits' | 'real' | 'string';

export interface WaveVariable extends WaveSignal {
  // Variables with the same id are one signal under several names.
  id: string;
  kind: WaveKind;
  // Last part of the name, and the names it answers to: without and with its declared bit range.
  leaf: string;
  keys: string[];
}

export interface Timescale {
  magnitude: bigint;
  exponent: number;
  label: string;
}

export const UNIT_EXPONENTS: Readonly<Record<string, number>> = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };
// The states a bit can hold, in either case: IEEE 1164 values plus Verilog's x and z.
export const BIT_STATES = /^[01xzuwlh-]+$/i;
const TIME = /^(\d+(?:\.\d*)?|\.\d+)\s*(fs|ps|ns|us|ms|s)?$/i;
const LISTED_NAMES = 20;

export function waveVariable(scopes: string[], type: string, width: number, id: string, reference: string, kind: WaveKind): WaveVariable {
  // nvc writes the range into the name, s_a[3:0]; other writers give it as its own token.
  const ranged = /^(.+?)(\[\d+:\d+\])$/.exec(reference);
  const leaf = ranged === null ? reference : ranged[1]!;
  const name = [...scopes, leaf].join('.');
  return { name, width, type, id, kind, leaf, keys: ranged === null ? [name] : [name, `${name}${ranged[2]}`] };
}

// Holds the current value of each requested signal while a reader replays the changes in time
// order, and records those values as the replay passes each requested time.
export class Sampler {
  private readonly signals: WaveVariable[] = [];
  private readonly watched = new Map<string, WaveVariable>();
  private readonly current = new Map<string, string | number>();
  // Requested times in ascending order, each answered once the replay moves past it.
  private readonly pending: Array<{ index: number } & Ticks>;
  private readonly rows: Array<Array<string | number | undefined>> = [];
  private answered = 0;

  constructor(variables: WaveVariable[], private readonly timescale: Timescale | undefined, private readonly query: WaveQuery) {
    const lookup = new Map<string, WaveVariable[]>();
    for (const variable of variables) {
      for (const key of variable.keys.map((name) => name.toLowerCase())) {
        const matches = lookup.get(key) ?? [];
        matches.push(variable);
        lookup.set(key, matches);
      }
    }
    for (const requested of query.signals) {
      const found = resolve(requested, lookup, variables);
      if (this.signals.some((signal) => signal.name === found.name)) continue;
      this.signals.push(found);
      this.watched.set(found.id, found);
    }
    this.pending = query.times
      .map((time, index) => ({ index, ...ticks(time, timescale) }))
      .sort((left, right) => (left.ticks < right.ticks ? -1 : left.ticks > right.ticks ? 1 : 0));
  }

  get ids(): string[] {
    return [...this.watched.keys()];
  }

  watching(id: string): WaveVariable | undefined {
    return this.watched.get(id);
  }

  // A bits value must be as wide as its signal and lower case; undefined means no value yet.
  set(id: string, value: string | number | undefined): void {
    if (value === undefined) this.current.delete(id);
    else this.current.set(id, value);
  }

  // Records the current values for every pending time before `time`. True once every requested
  // time is answered, so the rest of the file cannot change the result.
  advance(time: bigint): boolean {
    while (this.answered < this.pending.length && this.pending[this.answered]!.ticks < time) this.record();
    return this.answered === this.pending.length;
  }

  // `first` and `last` are the dump's first and last timestamps, in ticks.
  finish(first: bigint, last: bigint): WaveQueryResult {
    while (this.answered < this.pending.length) this.record();
    const beyond: Array<'before' | 'after' | undefined> = [];
    for (const { index, ticks, between } of this.pending) {
      const after = ticks > last || (ticks === last && between);
      beyond[index] = ticks < first ? 'before' : after ? 'after' : undefined;
    }
    return {
      timescale: this.timescale?.label ?? null,
      startTime: formatTime(first, this.timescale),
      endTime: formatTime(last, this.timescale),
      signals: this.signals.map(({ name, width, type }) => ({ name, width, type })),
      values: this.query.times.map((time, index) => ({
        time,
        ...(beyond[index] === undefined ? {} : { beyond: beyond[index] }),
        ...Object.fromEntries(this.signals.map((signal, column) => [signal.name, waveValue(signal, this.rows[index]![column])])),
      })),
    };
  }

  private record(): void {
    this.rows[this.pending[this.answered]!.index] = this.signals.map((signal) => this.current.get(signal.id));
    this.answered += 1;
  }
}

function resolve(requested: string, lookup: Map<string, WaveVariable[]>, variables: WaveVariable[]): WaveVariable {
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
  const listing = (names: WaveVariable[]) => `(${names.length > LISTED_NAMES ? `${LISTED_NAMES} of ` : ''}${names.length}): `
    + names.slice(0, LISTED_NAMES).map((candidate) => candidate.name).join(', ');
  if (sameLeaf.length > 0) throw new Error(`Unknown signal ${requested}. Signals named ${leaf} ${listing(sameLeaf)}`);
  if (variables.length === 0) throw new Error(`Unknown signal ${requested}. The file declares no signals`);
  throw new Error(`Unknown signal ${requested}. No signal is named ${leaf}; signals in the file ${listing(variables)}`);
}

interface Ticks {
  ticks: bigint;
  between: boolean;
}

// A time in whole ticks of the timescale, and whether it falls between two ticks. A change only happens on
// a whole tick, so a time between two ticks rounds down to the tick before it, which still finds the last
// change at or before it.
function ticks(time: string, timescale: Timescale | undefined): Ticks {
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
  const numerator = exponent >= 0 ? digits * 10n ** BigInt(exponent) : digits;
  const denominator = exponent >= 0 ? divisor : divisor * 10n ** BigInt(-exponent);
  return { ticks: numerator / denominator, between: numerator % denominator !== 0n };
}

// Ticks as a time in the largest unit that keeps the number at least 1, such as "20 ns" or "1.5 us", or as
// a bare number of ticks when the file has no timescale. Zero is given in the unit of the timescale.
function formatTime(count: bigint, timescale: Timescale | undefined): string {
  if (timescale === undefined) return count.toString();
  // Counted in femtoseconds, the smallest unit, so every time is a whole number.
  const femtoseconds = count * timescale.magnitude * 10n ** BigInt(timescale.exponent + 15);
  const units = Object.entries(UNIT_EXPONENTS).map(([unit, exponent]) => ({ unit, digits: exponent + 15 }));
  const { unit, digits } = units.find(({ digits }) => femtoseconds >= 10n ** BigInt(digits))
    ?? units.find(({ digits }) => digits === timescale.exponent + 15)!;
  const size = 10n ** BigInt(digits);
  const fraction = (femtoseconds % size).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${femtoseconds / size}${fraction === '' ? '' : `.${fraction}`} ${unit}`;
}

function waveValue(signal: WaveVariable, value: string | number | undefined): WaveValue {
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
