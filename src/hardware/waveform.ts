import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RarsError } from '../errors.js';

export interface WaveTransition { time: number; value: string }
export interface WaveSignal { id: string; name: string; path: string; width: number; type: string; transitions: WaveTransition[]; role?: string }
export interface WaveIndex { version: 1; sourceSha256: string; timescale: string; startTime: number; endTime: number; scopes: string[]; signals: WaveSignal[] }

export function parseVcd(contents: string, sourceSha256 = createHash('sha256').update(contents).digest('hex')): WaveIndex {
  const scopes: string[] = [];
  const allScopes = new Set<string>();
  const byId = new Map<string, WaveSignal>();
  let timescale = '1s'; let time = 0; let header = true;
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    if (header) {
      if (line.startsWith('$timescale')) {
        let value = line.replace('$timescale', '').replace('$end', '').trim();
        while (!value && i + 1 < lines.length) value = (lines[++i] ?? '').replace('$end', '').trim();
        timescale = value.replace(/\s+/gu, '');
      } else if (line.startsWith('$scope')) {
        const match = /^\$scope\s+\S+\s+(\S+)\s+\$end$/u.exec(line); if (match?.[1]) { scopes.push(match[1]); allScopes.add(scopes.join('.')); }
      } else if (line.startsWith('$upscope')) scopes.pop();
      else if (line.startsWith('$var')) {
        const match = /^\$var\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+?)\s+\$end$/u.exec(line);
        if (match) { const [, type, width, id, name] = match; if (type && width && id && name) byId.set(id, { id, name, path: [...scopes, name].join('.'), width: Number(width), type, transitions: [] }); }
      } else if (line.startsWith('$enddefinitions')) header = false;
      continue;
    }
    if (line[0] === '#') { time = Number(line.slice(1)); continue; }
    if (line[0] === '$') continue;
    const vector = /^[bBrR]([^\s]+)\s+(\S+)$/u.exec(line);
    if (vector) { const signal = byId.get(vector[2] as string); if (signal) pushTransition(signal, time, (vector[1] as string).toLowerCase()); continue; }
    const scalar = /^([01xXzZ])(.+)$/u.exec(line);
    if (scalar) { const signal = byId.get(scalar[2] as string); if (signal) pushTransition(signal, time, (scalar[1] as string).toLowerCase()); }
  }
  const signals = [...byId.values()].sort((a, b) => a.path.localeCompare(b.path));
  const endTime = Math.max(0, ...signals.flatMap((signal) => signal.transitions.map((item) => item.time)));
  return { version: 1, sourceSha256, timescale, startTime: 0, endTime, scopes: [...allScopes].sort(), signals };
}

function pushTransition(signal: WaveSignal, time: number, value: string): void {
  if (signal.transitions.at(-1)?.value !== value) signal.transitions.push({ time, value });
}

export async function loadOrCreateVcdIndex(sourcePath: string, indexPath: string, expectedSha256: string, maxIndexBytes = 512 * 1024 * 1024): Promise<WaveIndex> {
  try { const cached = JSON.parse(await readFile(indexPath, 'utf8')) as WaveIndex; if (cached.version === 1 && cached.sourceSha256 === expectedSha256) return cached; } catch {}
  let index: WaveIndex;
  if (sourcePath.toLowerCase().endsWith('.vcd')) index = parseVcd(await readFile(sourcePath, 'utf8'), expectedSha256);
  else {
    try {
      const script = process.env.HARDWARE_WAVE_INDEX_SCRIPT ?? '/app/wave_index.py';
      const { stdout } = await promisify(execFile)('python3', [script, sourcePath], { maxBuffer: 256 * 1024 * 1024 });
      index = JSON.parse(stdout) as WaveIndex;
      if (index.sourceSha256 !== expectedSha256) throw new Error('waveform checksum changed');
    } catch (error) { throw new RarsError('ARTIFACT_CORRUPT', 'Unable to index waveform', { cause: error instanceof Error ? error.message : String(error) }); }
  }
  const encoded = `${JSON.stringify(index)}\n`;
  if (Buffer.byteLength(encoded) > maxIndexBytes) throw new RarsError('ARTIFACT_LIMIT_EXCEEDED', 'Waveform index exceeds the artifact quota', { maximum: maxIndexBytes });
  await writeFile(indexPath, encoded, { mode: 0o600 });
  return index;
}

export function queryWave(index: WaveIndex, input: { operation: string; signal?: string; otherSignal?: string; startTime?: number; endTime?: number; limit?: number; cursor?: number; maxResponseBytes?: number }): Record<string, unknown> {
  const limit = Math.min(10_000, Math.max(1, input.limit ?? 1000)); const cursor = Math.max(0, input.cursor ?? 0);
  const maxBytes = input.maxResponseBytes ?? 262_144;
  if (input.operation === 'hierarchy') return boundedPage({ timescale: index.timescale, startTime: index.startTime, endTime: index.endTime }, 'scopes', index.scopes, cursor, limit, maxBytes);
  if (input.operation === 'signals') return boundedPage({}, 'signals', index.signals.map(({ transitions: _, ...signal }) => signal), cursor, limit, maxBytes);
  const signal = findSignal(index, input.signal);
  const start = input.startTime ?? index.startTime; const end = input.endTime ?? index.endTime;
  const window = signal.transitions.filter((item) => item.time >= start && item.time <= end);
  if (input.operation === 'value_at') { const at = input.startTime ?? 0; return { signal: signal.path, time: at, value: [...signal.transitions].reverse().find((item) => item.time <= at)?.value ?? null }; }
  if (input.operation === 'transitions') return page(signal.path, window, cursor, limit, maxBytes);
  if (input.operation === 'first_edge') return { signal: signal.path, transition: window.find((item, position) => position > 0 && item.value !== window[position - 1]?.value) ?? null };
  if (input.operation === 'first_unknown') return { signal: signal.path, transition: window.find((item) => /[xz]/u.test(item.value)) ?? null };
  if (input.operation === 'pulse_widths') return page(signal.path, window.slice(1).map((item, position) => ({ value: window[position]?.value, startTime: window[position]?.time, endTime: item.time, width: item.time - (window[position]?.time ?? item.time) })), cursor, limit, maxBytes);
  if (input.operation === 'compare') { const other = findSignal(index, input.otherSignal); const times = [...new Set([...signal.transitions, ...other.transitions].map((item) => item.time))].sort((a, b) => a - b); const mismatch = times.find((at) => valueAt(signal, at) !== valueAt(other, at)); return { equal: mismatch === undefined, firstMismatch: mismatch === undefined ? null : { time: mismatch, left: valueAt(signal, mismatch), right: valueAt(other, mismatch) } }; }
  throw new RarsError('INVALID_PROJECT', `Unsupported waveform operation: ${input.operation}`);
}

function findSignal(index: WaveIndex, selector?: string): WaveSignal { const matches = index.signals.filter((item) => item.path === selector || item.name === selector); if (matches.length !== 1) throw new RarsError('INVALID_PROJECT', `Signal selector must match exactly one signal: ${selector ?? ''}`, { matches: matches.map((item) => item.path) }); return matches[0] as WaveSignal; }
function valueAt(signal: WaveSignal, time: number): string | null { return [...signal.transitions].reverse().find((item) => item.time <= time)?.value ?? null; }
function page(signal: string, items: unknown[], cursor: number, limit: number, maxBytes: number): Record<string, unknown> { return boundedPage({ signal }, 'items', items, cursor, limit, maxBytes); }

function boundedPage(prefix: Record<string, unknown>, key: string, items: unknown[], cursor: number, limit: number, maxBytes: number): Record<string, unknown> {
  const selected: unknown[] = [];
  const maximum = Math.min(items.length, cursor + limit);
  for (let position = cursor; position < maximum; position++) {
    const candidate = [...selected, items[position]];
    const nextCursor = position + 1 < items.length ? position + 1 : null;
    const value = { ...prefix, [key]: candidate, nextCursor, ...(position + 1 < maximum ? { truncatedByBytes: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) break;
    selected.push(items[position]);
  }
  if (selected.length === 0 && cursor < maximum) throw new RarsError('ARTIFACT_LIMIT_EXCEEDED', 'Waveform response byte limit is too small for one result', { maximum: maxBytes });
  const consumed = cursor + selected.length;
  const hasMore = consumed < items.length;
  const truncatedByBytes = consumed < maximum;
  const value = { ...prefix, [key]: selected, nextCursor: hasMore ? consumed : null, ...(truncatedByBytes ? { truncatedByBytes: true } : {}) };
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new RarsError('ARTIFACT_LIMIT_EXCEEDED', 'Waveform response exceeds the byte limit', { maximum: maxBytes });
  return value;
}
