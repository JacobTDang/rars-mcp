// Reads signal values at chosen times from a Value Change Dump (IEEE 1364, section 18). The text
// arrives in chunks and only the requested signals are kept, so memory follows the query, not the file.

import {
  BIT_STATES, Sampler, UNIT_EXPONENTS, waveVariable,
  type Timescale, type WaveKind, type WaveQuery, type WaveQueryResult, type WaveVariable,
} from './wave.js';

// The whole file is read, even after every requested time is answered, to find its last timestamp.
export async function queryVcd(chunks: AsyncIterable<string> | Iterable<string>, query: WaveQuery): Promise<WaveQueryResult> {
  const definitions = new Definitions();
  let dump: Dump | undefined;
  for await (const tokens of tokenBatches(chunks)) {
    for (const token of tokens) {
      if (dump === undefined) {
        if (definitions.read(token)) dump = new Dump(definitions, query);
      } else {
        dump.read(token);
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
  readonly variables: WaveVariable[] = [];
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

function variable(scopes: string[], type: string, width: number, id: string, reference: string): WaveVariable {
  const kind: WaveKind = ['real', 'realtime', 'shortreal'].includes(type) ? 'real' : type === 'string' ? 'string' : 'bits';
  return waveVariable(scopes, type, width, id, reference, kind);
}

class Dump {
  private readonly sampler: Sampler;
  private first: bigint | undefined;
  private time: bigint | undefined;
  private value: string | undefined;
  private skipping = false;

  constructor(definitions: Definitions, query: WaveQuery) {
    this.sampler = new Sampler(definitions.variables, definitions.timescale, query);
  }

  read(token: string): void {
    if (this.skipping) {
      this.skipping = token !== '$end';
      return;
    }
    if (this.value !== undefined) {
      this.change(this.value, token);
      this.value = undefined;
      return;
    }
    const first = token[0]!;
    if (first === '#') {
      this.advance(token);
    } else if (first === '$') {
      // These only bracket value changes; any other section, such as $comment, is skipped.
      this.skipping = !['$dumpvars', '$dumpall', '$dumpon', '$dumpoff', '$end'].includes(token);
    } else if ('bBrRsS'.includes(first)) {
      this.value = token;
    } else if (BIT_STATES.test(first) && token.length > 1) {
      this.change(first, token.slice(1));
    } else {
      throw new Error(`Cannot read VCD value change "${clip(token)}" at #${this.time ?? 0}`);
    }
  }

  finish(): WaveQueryResult {
    const { first, time: last } = this;
    if (first === undefined || last === undefined) throw new Error('The VCD file has no timestamp after $enddefinitions');
    return this.sampler.finish(first, last);
  }

  private advance(token: string): void {
    if (!/^#\d+$/.test(token)) throw new Error(`Cannot read VCD time "${clip(token)}"`);
    const time = BigInt(token.slice(1));
    if (this.time !== undefined && time < this.time) throw new Error(`VCD time goes backwards: ${token} after #${this.time}`);
    this.sampler.advance(time);
    this.first ??= time;
    this.time = time;
  }

  private change(value: string, id: string): void {
    const kind = value.length === 1 ? 'bits' : ({ b: 'bits', r: 'real', s: 'string' } as const)[value[0]!.toLowerCase() as 'b' | 'r' | 's'];
    const text = value.length === 1 ? value : value.slice(1);
    const where = () => `"${clip(value)} ${clip(id)}" at #${this.time ?? 0}`;
    let parsed: string | number = text;
    if (kind === 'bits') {
      if (!BIT_STATES.test(text)) throw new Error(`Cannot read VCD value change ${where()}`);
      parsed = text.toLowerCase();
    } else if (kind === 'real') {
      parsed = Number(text);
      if (text === '' || Number.isNaN(parsed)) throw new Error(`Cannot read VCD value change ${where()}`);
    }
    const signal = this.sampler.watching(id);
    if (signal === undefined) return;
    if (kind !== signal.kind) throw new Error(`VCD value change ${where()} does not fit ${signal.type} signal ${signal.name}`);
    this.sampler.set(id, kind === 'bits' ? extend(parsed as string, signal) : parsed);
  }
}

// A value shorter than its signal is padded on the left: with 0 after a 0 or 1, otherwise with its first state.
function extend(bits: string, signal: WaveVariable): string {
  if (bits.length > signal.width) {
    throw new Error(`VCD value b${clip(bits)} is wider than the ${signal.width} bits of ${signal.name}`);
  }
  return (bits[0] === '1' ? '0' : bits[0]!).repeat(signal.width - bits.length) + bits;
}
