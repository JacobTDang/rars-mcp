import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { toNodeHandler } from '@modelcontextprotocol/node';

import { loadConfig } from '../config.js';
import { createHardwareWorker } from './worker.js';

function version(executable: string): string | null {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.split(/\r?\n/u)[0]?.trim() || null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const token = config.hardware.workerToken;
  if (!token) throw new Error('HARDWARE_WORKER_TOKEN is required');
  const worker = await createHardwareWorker({
    workspaceRoot: config.workspaceRoot,
    stateRoot: config.hardware.stateDir,
    token,
    allowRepositoryCommands: config.hardware.allowRepositoryCommands,
    limits: config.hardware.limits,
    executableVersions: { verilator: version('verilator'), ghdl: version('ghdl'), cocotb: version('cocotb-config'), yosys: version('yosys'), sby: version('sby'), 'riscv-formal': version('sby'), spike: version('spike'), 'rars-trace': 'RARS 1.6' },
  });
  const handler = toNodeHandler(worker);
  const server = createServer((request, response) => void handler(request as never, response as never));
  const port = Number(process.env.HARDWARE_WORKER_PORT ?? '3010');
  server.listen(port, '0.0.0.0', () => console.error(`Hardware worker listening on port ${port}`));
  const shutdown = async () => { server.close(); await worker.close(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
