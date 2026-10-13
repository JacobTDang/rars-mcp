// Reads signal values at chosen times from an FST file, the Fast Signal Trace format of GTKWave's
// libfst (fstapi.c), in the form nvc writes it: zlib-compressed value changes, gzip-compressed signal
// names and, usually, the whole file wrapped in gzip. The file is read whole, but only the value
// changes of the requested signals are unpacked. The header gives the first and last timestamps, so
// reading stops once every requested time is answered.

import { gunzipSync, inflateSync } from 'node:zlib';

import {
  BIT_STATES, Sampler, UNIT_EXPONENTS, waveVariable,
  type Timescale, type WaveKind, type WaveQuery, type WaveQueryResult, type WaveVariable,
} from './wave.js';

export interface FstOptions {
  // How errors name the file.
  name: string;
  // WAVE_MAX_BYTES: the most the file, or any part of it, may unpack to.
  maxBytes: number;
}

// Block types, from enum fstBlockType.
const HEADER = 0;
const VALUE_CHANGES = 1;
const BLACKOUT = 2;
const GEOMETRY = 3;
const HIERARCHY = 4;
const VALUE_CHANGES_ALIAS = 5;
const HIERARCHY_LZ4 = 6;
const HIERARCHY_LZ4_DUO = 7;
const VALUE_CHANGES_ALIAS2 = 8;
const GZIP_WRAPPER = 254;
const UNFINISHED = 255;

const HEADER_LENGTH = 329;
// The header stores e as a double so a reader can tell the byte order of the reals in the file.
const BYTE_ORDER_MARK = 2.7182818284590452354;

// Hierarchy entries: these four tags, or a variable whose tag is its enum fstVarType, named here
// as libfst names it in VCD.
const SCOPE = 254;
const UPSCOPE = 255;
const ATTRIBUTE = 252;
const ATTRIBUTE_END = 253;
const VAR_TYPES = [
  'event', 'integer', 'parameter', 'real', 'real_parameter', 'reg', 'supply0', 'supply1', 'time', 'tri',
  'triand', 'trior', 'trireg', 'tri0', 'tri1', 'wand', 'wire', 'wor', 'port', 'sparray', 'realtime',
  'string', 'bit', 'logic', 'int', 'shortint', 'longint', 'byte', 'enum', 'shortreal',
];

// The geometry block gives each signal's width in bits, or one of these.
const REAL = 0;
const VARIABLE_LENGTH = 0xffffffff;
// A one-bit change that is not 0 or 1 carries one of these by a 3-bit code.
const ONE_BIT_STATES = 'xzhuwl-?';
// Each byte value as its 8 bits, most significant first.
const BYTE_BITS = Array.from({ length: 256 }, (_, byte) => byte.toString(2).padStart(8, '0'));

interface Block {
  type: number;
  offset: number;
  // Everything after the type byte, starting with the section's own length.
  section: Buffer;
}

interface Chain {
  offset: number;
  length: number;
}

type Fail = (detail: string, cause?: unknown) => Error;

export function queryFst(data: Buffer, query: WaveQuery, options: FstOptions): WaveQueryResult {
  return new FstFile(data, options).query(query);
}

class FstFile {
  private readonly changeBlocks: Block[] = [];
  private readonly variables: WaveVariable[] = [];
  private readonly timescale: Timescale;
  private readonly startTime: bigint;
  private readonly endTime: bigint;
  private readonly littleEndian: boolean;
  // Indexed by handle - 1: each signal's geometry entry, and where its value sits in a block's start-of-block values.
  private readonly widths: number[];
  private readonly frameOffsets: number[];
  private time = 0n;

  constructor(data: Buffer, private readonly options: FstOptions) {
    const file = this.unwrap(data);
    const [header, ...blocks] = this.blocks(file);
    if (header?.type !== HEADER || header.section.length !== HEADER_LENGTH) throw this.unreadable('it does not start with an FST header');
    let geometry: Block | undefined;
    let hierarchy: Block | undefined;
    for (const block of blocks) {
      switch (block.type) {
        case VALUE_CHANGES_ALIAS2: this.changeBlocks.push(block); break;
        case GEOMETRY: geometry = this.only(geometry, block, 'signal widths'); break;
        case HIERARCHY: hierarchy = this.only(hierarchy, block, 'signal names'); break;
        case HIERARCHY_LZ4:
        case HIERARCHY_LZ4_DUO: throw this.unsupported('stores its signal names LZ4-compressed');
        case VALUE_CHANGES:
        case VALUE_CHANGES_ALIAS: throw this.unsupported(`has value change blocks of type ${block.type}`);
        case BLACKOUT: throw this.unsupported('has $dumpoff periods');
        case UNFINISHED:
          throw this.unreadable(`the block at byte ${block.offset} was never finished, as happens when the simulation `
            + 'is still running or stopped before closing the file');
        default: throw this.unreadable(`the block at byte ${block.offset} has unknown type ${block.type}`);
      }
    }
    if (hierarchy === undefined) throw this.unreadable('it has no signal names (hierarchy block)');
    if (geometry === undefined) throw this.unreadable('it has no signal widths (geometry block)');

    const section = header.section;
    this.startTime = section.readBigUInt64BE(8);
    this.endTime = section.readBigUInt64BE(16);
    if (section.readDoubleLE(24) === BYTE_ORDER_MARK) this.littleEndian = true;
    else if (section.readDoubleBE(24) === BYTE_ORDER_MARK) this.littleEndian = false;
    else throw this.unreadable('its header has no byte-order mark');
    const changeBlockCount = section.readBigUInt64BE(64);
    if (changeBlockCount !== BigInt(this.changeBlocks.length)) {
      throw this.unreadable(`its header counts ${changeBlockCount} value change blocks, but it has ${this.changeBlocks.length}`);
    }
    this.timescale = this.timescaleOf(section.readInt8(72));
    const timeZero = section.readBigInt64BE(321);
    if (timeZero !== 0n) throw this.unsupported(`has a time zero of ${timeZero}`);

    this.widths = this.readGeometry(geometry.section);
    this.frameOffsets = [0];
    for (const width of this.widths) {
      this.frameOffsets.push(this.frameOffsets.at(-1)! + (width === REAL ? 8 : width === VARIABLE_LENGTH ? 0 : width));
    }
    this.readHierarchy(hierarchy.section);
  }

  query(query: WaveQuery): WaveQueryResult {
    const sampler = new Sampler(this.variables, this.timescale, query);
    const handles = sampler.ids.map(Number);
    for (const block of this.changeBlocks) {
      if (this.replay(block, sampler, handles)) break;
    }
    return sampler.finish(this.startTime, this.endTime);
  }

  private unwrap(data: Buffer): Buffer {
    if (data[0] !== GZIP_WRAPPER) return data;
    if (data.length < 17) throw this.unreadable('its gzip wrapper ends early');
    const end = 1n + data.readBigUInt64BE(1);
    if (end !== BigInt(data.length)) {
      throw this.unreadable(`its gzip wrapper ${end > BigInt(data.length) ? 'runs past the end of the file' : 'is followed by other data'}`);
    }
    const length = data.readBigUInt64BE(9);
    if (length > BigInt(this.options.maxBytes)) throw this.tooLarge(`it unpacks to ${length} bytes`);
    return this.unpack(data.subarray(17), Number(length), 'gzip-wrapped contents', gunzipSync);
  }

  private blocks(file: Buffer): Block[] {
    const blocks: Block[] = [];
    for (let offset = 0; offset < file.length;) {
      const end = offset + 9 > file.length ? Infinity : offset + 1 + Number(file.readBigUInt64BE(offset + 1));
      if (end > file.length) throw this.unreadable(`the block at byte ${offset} runs past the end of the file`);
      if (end < offset + 9) throw this.unreadable(`the block at byte ${offset} is too short to hold its own length`);
      blocks.push({ type: file[offset]!, offset, section: file.subarray(offset + 1, end) });
      offset = end;
    }
    return blocks;
  }

  private only(found: Block | undefined, block: Block, what: string): Block {
    if (found !== undefined) throw this.unreadable(`it has its ${what} twice, at bytes ${found.offset} and ${block.offset}`);
    return block;
  }

  // An exponent of -14 is a tick of 10 fs.
  private timescaleOf(exponent: number): Timescale {
    const unitExponent = Math.floor(exponent / 3) * 3;
    const unit = Object.keys(UNIT_EXPONENTS).find((name) => UNIT_EXPONENTS[name] === unitExponent);
    if (unit === undefined) throw this.unsupported(`has a timescale of 1e${exponent} s`);
    const magnitude = 10n ** BigInt(exponent - unitExponent);
    return { magnitude, exponent: unitExponent, label: `${magnitude} ${unit}` };
  }

  private readGeometry(section: Buffer): number[] {
    if (section.length < 24) throw this.unreadable('its signal widths end early');
    const length = this.safe(section.readBigUInt64BE(8), 'signal widths');
    const count = this.safe(section.readBigUInt64BE(16), 'signal widths');
    const data = this.stored(section.subarray(24), length, 'signal widths');
    // Each width takes at least one byte.
    if (count > data.length) throw this.unreadable(`its signal widths count ${count} signals but hold ${data.length} bytes`);
    const reader = new Reader(data, 'signal widths', this.unreadable);
    const widths = Array.from({ length: count }, () => reader.varint());
    if (!reader.done) throw this.unreadable(`its signal widths hold more than the ${count} signals they count`);
    return widths;
  }

  private readHierarchy(section: Buffer): void {
    if (section.length < 16) throw this.unreadable('its signal names end early');
    const length = this.safe(section.readBigUInt64BE(8), 'signal names');
    const reader = new Reader(this.unpack(section.subarray(16), length, 'signal names', gunzipSync), 'signal names', this.unreadable);
    const scopes: string[] = [];
    let handles = 0;
    while (!reader.done) {
      const tag = reader.byte();
      if (tag === SCOPE) {
        reader.byte();
        scopes.push(reader.string());
        reader.string();
      } else if (tag === UPSCOPE) {
        if (scopes.pop() === undefined) throw this.unreadable('its signal names close a scope that was never opened');
      } else if (tag === ATTRIBUTE) {
        reader.bytes(2);
        reader.string();
        reader.skipVarint();
      } else if (tag !== ATTRIBUTE_END) {
        const type = VAR_TYPES[tag];
        if (type === undefined) throw this.unreadable(`its signal names hold an entry of unknown type ${tag}`);
        reader.byte();
        const reference = reader.string();
        reader.varint();
        const alias = reader.varint();
        const handle = alias === 0 ? ++handles : alias;
        const width = this.widths[handle - 1];
        if (width === undefined) {
          throw this.unreadable(`its signal ${reference} has handle ${handle}, past the ${this.widths.length} signals it gives widths for`);
        }
        const kind: WaveKind = width === REAL ? 'real' : width === VARIABLE_LENGTH ? 'string' : 'bits';
        const bits = kind === 'real' ? 64 : kind === 'string' ? 0 : width;
        this.variables.push(waveVariable(scopes, type, bits, String(handle), reference, kind));
      }
    }
  }

  // Replays one block's changes to the requested signals. True once every requested time is answered.
  private replay(block: Block, sampler: Sampler, handles: number[]): boolean {
    const section = block.section;
    const what = `value change block at byte ${block.offset}`;
    if (section.length < 32 + 24) throw this.unreadable(`its ${what} ends early`);
    const begin = section.readBigUInt64BE(8);
    if (begin < this.time) throw this.unreadable(`its ${what} starts at ${begin}, before the block ahead of it ends`);

    const reader = new Reader(section, 'start-of-block values', this.unreadable, 32);
    const frameLength = reader.varint();
    const frameStored = reader.varint();
    const frameHandles = reader.varint();
    const frame = this.stored(reader.bytes(frameStored), frameLength, 'start-of-block values');
    if (frameHandles > this.widths.length || frame.length !== this.frameOffsets[frameHandles]) {
      throw this.unreadable(`the start-of-block values in its ${what} do not fit its signal widths`);
    }
    const changeHandles = reader.varint();
    if (changeHandles > this.widths.length) {
      throw this.unreadable(`its ${what} holds changes for ${changeHandles} signals, but the file gives widths for ${this.widths.length}`);
    }
    // Offsets into the value changes count from this byte, which names their compression.
    const base = reader.position;
    const pack = String.fromCharCode(reader.byte());
    if (pack === '4') throw this.unsupported('stores its value changes LZ4-compressed');
    if (pack === 'F') throw this.unsupported('stores its value changes FastLZ-compressed');
    if (pack !== 'Z') throw this.unreadable(`its ${what} names an unknown compression "${pack}"`);

    // The times sit at the end of the block, after the table of where each signal's changes start.
    const timesLength = this.safe(section.readBigUInt64BE(section.length - 24), 'times');
    const timesStored = this.safe(section.readBigUInt64BE(section.length - 16), 'times');
    const timeCount = this.safe(section.readBigUInt64BE(section.length - 8), 'times');
    const timesStart = section.length - 24 - timesStored;
    if (timesStart - 8 < reader.position) throw this.unreadable(`the times in its ${what} run past its start`);
    const tableLength = this.safe(section.readBigUInt64BE(timesStart - 8), 'value change offsets');
    const tableStart = timesStart - 8 - tableLength;
    if (tableStart < reader.position) throw this.unreadable(`the value change offsets in its ${what} run past its start`);
    const chains = this.chains(section.subarray(tableStart, timesStart - 8), changeHandles, tableStart - base);
    const times = new Times(this.stored(section.subarray(timesStart, section.length - 24), timesLength, 'times'), this.unreadable);

    // A block's start-of-block values hold at its start time, which answers any time before it.
    if (sampler.advance(begin)) return true;
    for (const handle of handles) {
      if (handle <= frameHandles) this.startValue(sampler, frame, handle);
    }
    const streams = handles.flatMap((handle) => {
      const chain = chains[handle - 1];
      if (chain === undefined) return [];
      const start = base + chain.offset;
      if (start + chain.length > tableStart) throw this.unreadable(`the value changes in its ${what} run past their end`);
      const changes = new Reader(section.subarray(start, start + chain.length), 'value changes', this.unreadable);
      const length = changes.varint();
      const data = changes.bytes(chain.length - changes.position);
      return [new Changes(String(handle), length === 0 ? data : this.unpack(data, length, 'value changes', inflateSync),
        this.widths[handle - 1]!, timeCount, this.littleEndian, this.unreadable)];
    });
    for (;;) {
      const index = Math.min(...streams.map((stream) => stream.index));
      if (index === Infinity) break;
      this.time = times.at(index);
      if (sampler.advance(this.time)) return true;
      for (const stream of streams) {
        if (stream.index !== index) continue;
        sampler.set(stream.id, stream.value);
        stream.next();
      }
    }
    if (timeCount > 0) this.time = times.at(timeCount - 1);
    return false;
  }

  private startValue(sampler: Sampler, frame: Buffer, handle: number): void {
    const width = this.widths[handle - 1]!;
    const offset = this.frameOffsets[handle - 1]!;
    // Strings carry no start-of-block value, so they keep the value the block ahead left them.
    if (width === VARIABLE_LENGTH) return;
    if (width === REAL) {
      const value = this.littleEndian ? frame.readDoubleLE(offset) : frame.readDoubleBE(offset);
      sampler.set(String(handle), Number.isNaN(value) ? undefined : value);
      return;
    }
    const bits = frame.toString('latin1', offset, offset + width);
    if (!BIT_STATES.test(bits)) throw this.unreadable(`its start-of-block values hold "${bits}" for handle ${handle}`);
    sampler.set(String(handle), bits.toLowerCase());
  }

  // Where each handle's changes sit in the block, relative to `base`; undefined for a handle with no changes.
  // An entry with its low bit set is a signed step to the next offset or, when not positive, an alias:
  // the handle shares the changes of the earlier handle it names, or of the last one named for a 0.
  // An entry with its low bit clear skips handles that have no changes.
  private chains(table: Buffer, count: number, end: number): Array<Chain | undefined> {
    const offsets = new Array<number>(count).fill(0);
    const aliases = new Array<number>(count).fill(0);
    const lengths = new Array<number>(count).fill(0);
    const reader = new Reader(table, 'value change offsets', this.unreadable);
    let index = 0;
    let offset = 0;
    let previous = -1;
    let alias = 0;
    while (!reader.done) {
      if ((table[reader.position]! & 1) === 1) {
        if (index >= count) throw this.unreadable(`its value change offsets list more than the ${count} signals of their block`);
        const step = Math.floor(reader.svarint() / 2);
        if (step > 0) {
          offset += step;
          offsets[index] = offset;
          if (previous >= 0) lengths[previous] = offset - offsets[previous]!;
          previous = index;
        } else {
          if (step < 0) alias = -step;
          aliases[index] = alias;
        }
        index += 1;
      } else {
        index += Math.floor(reader.varint() / 2);
      }
    }
    if (index > count) throw this.unreadable(`its value change offsets list more than the ${count} signals of their block`);
    if (previous >= 0) lengths[previous] = end - offsets[previous]!;
    const chains: Array<Chain | undefined> = [];
    for (let handle = 0; handle < count; handle += 1) {
      if (offsets[handle]! > 0) {
        chains.push({ offset: offsets[handle]!, length: lengths[handle]! });
      } else if (aliases[handle]! > 0) {
        if (aliases[handle]! > handle) throw this.unreadable(`its value change offsets alias handle ${handle + 1} to a later one`);
        chains.push(chains[aliases[handle]! - 1]);
      } else {
        chains.push(undefined);
      }
    }
    return chains;
  }

  // A section stored as it is when its stored and unpacked lengths agree, and zlib-compressed otherwise.
  private stored(data: Buffer, length: number, what: string): Buffer {
    return data.length === length ? data : this.unpack(data, length, what, inflateSync);
  }

  private unpack(data: Buffer, length: number, what: string, method: typeof inflateSync): Buffer {
    if (length > this.options.maxBytes) throw this.tooLarge(`its ${what} unpack to ${length} bytes`);
    let unpacked: Buffer;
    try {
      unpacked = method(data, { maxOutputLength: Math.max(length, 1) });
    } catch (error) {
      throw this.unreadable(`its ${what} do not unpack: ${(error as Error).message}`, error);
    }
    if (unpacked.length !== length) throw this.unreadable(`its ${what} unpack to ${unpacked.length} bytes, not the ${length} it gives`);
    return unpacked;
  }

  private safe(value: bigint, what: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw this.unreadable(`its ${what} give a length of ${value}`);
    return Number(value);
  }

  private readonly unreadable: Fail = (detail, cause) =>
    new Error(`${this.options.name} is not a readable FST file: ${detail}`, cause === undefined ? undefined : { cause });

  private unsupported(detail: string): Error {
    return new Error(`${this.options.name} ${detail}, which wave_query does not read`);
  }

  private tooLarge(detail: string): Error {
    return new Error(`${this.options.name} is over the WAVE_MAX_BYTES limit of ${this.options.maxBytes}: ${detail}`);
  }
}

// The changes of one signal in one block, read one at a time: each starts with a varint that packs
// the step from the last change's time index together with flags for how its value is stored.
class Changes {
  index = 0;
  value: string | number | undefined;
  private readonly reader: Reader;

  constructor(
    readonly id: string,
    data: Buffer,
    private readonly width: number,
    private readonly timeCount: number,
    private readonly littleEndian: boolean,
    private readonly fail: Fail,
  ) {
    this.reader = new Reader(data, 'value changes', fail);
    this.next();
  }

  // Reads the next change into index and value; index is Infinity once there are none left.
  next(): void {
    if (this.reader.done) {
      this.index = Infinity;
      return;
    }
    const head = this.reader.varint();
    const flagged = head % 2 === 1;
    if (this.width === 1) {
      // 0 and 1 take one flag bit; any other state takes three more.
      this.index += Math.floor(head / (flagged ? 16 : 4));
      this.value = flagged ? this.state(ONE_BIT_STATES[Math.floor(head / 2) % 8]!) : String(Math.floor(head / 2) % 2);
    } else {
      this.index += Math.floor(head / 2);
      if (this.width === REAL) {
        const bytes = this.reader.bytes(8);
        const value = this.littleEndian ? bytes.readDoubleLE(0) : bytes.readDoubleBE(0);
        this.value = Number.isNaN(value) ? undefined : value;
      } else if (this.width === VARIABLE_LENGTH) {
        if (flagged) throw this.fail('its value changes hold a string change it cannot read');
        this.value = this.reader.bytes(this.reader.varint()).toString('utf8');
      } else if (flagged) {
        // One character per bit.
        this.value = this.state(this.reader.bytes(this.width).toString('latin1'));
      } else {
        // Packed 0s and 1s, most significant bit first.
        const bytes = this.reader.bytes(Math.ceil(this.width / 8));
        this.value = Array.from(bytes, (byte) => BYTE_BITS[byte]!).join('').slice(0, this.width);
      }
    }
    if (this.index >= this.timeCount) throw this.fail(`its value changes point past the ${this.timeCount} times of their block`);
  }

  private state(text: string): string {
    if (!BIT_STATES.test(text)) throw this.fail(`its value changes hold the unknown state "${text}"`);
    return text.toLowerCase();
  }
}

// A block's times, stored as varint steps from the one before, read forward as far as needed.
class Times {
  private readonly reader: Reader;
  private index = -1;
  private time = 0n;

  constructor(data: Buffer, fail: Fail) {
    this.reader = new Reader(data, 'times', fail);
  }

  at(index: number): bigint {
    while (this.index < index) {
      this.time += this.reader.bigVarint();
      this.index += 1;
    }
    return this.time;
  }
}

class Reader {
  position: number;

  constructor(private readonly data: Buffer, private readonly what: string, private readonly fail: Fail, start = 0) {
    this.position = start;
  }

  get done(): boolean {
    return this.position >= this.data.length;
  }

  byte(): number {
    return this.bytes(1)[0]!;
  }

  bytes(length: number): Buffer {
    if (this.position + length > this.data.length) throw this.fail(`its ${this.what} end early`);
    const bytes = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return bytes;
  }

  string(): string {
    const end = this.data.indexOf(0, this.position);
    if (end < 0) throw this.fail(`its ${this.what} end early`);
    const text = this.data.toString('utf8', this.position, end);
    this.position = end + 1;
    return text;
  }

  varint(): number {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
    }
    if (!Number.isSafeInteger(value)) throw this.fail(`its ${this.what} hold a number too large to read`);
    return value;
  }

  bigVarint(): bigint {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  }

  // Sign-extended from bit 6 of the last byte.
  svarint(): number {
    let value = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = this.byte();
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte >= 0x80);
    if (!Number.isSafeInteger(value)) throw this.fail(`its ${this.what} hold a number too large to read`);
    return (byte & 0x40) === 0 ? value : value - scale;
  }

  skipVarint(): void {
    while (this.byte() >= 0x80);
  }
}
