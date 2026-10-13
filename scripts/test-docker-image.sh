#!/bin/sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
image="${1:-rars-mcp:smoke}"
docker build -t "$image" .
docker run --rm --entrypoint nvc "$image" --version
test "$(printf 'puts ok\n' | docker run --rm -i --entrypoint tclsh "$image")" = ok
echo 'tclsh: ok'

# Keep fixtures read-only; all generated files live in the disposable container.
docker run --rm -i \
  --mount "type=bind,source=$PWD/tests/fixtures/vhdl,target=/fixtures,readonly" \
  "$image" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

assert.notEqual(process.getuid(), 0, 'The image must run as a non-root user');
for (const file of ['adder.vhd', 'adder_tb.vhd']) {
  await copyFile(`/fixtures/${file}`, `/workspace/${file}`);
}
await writeFile('/workspace/smoke.do',
  'vlib work\nvcom -2008 adder.vhd adder_tb.vhd\nvsim work.adder_tb\nrun 30 ns\n');

// The client sends JSON-RPC to the image's actual stdio entry point.
const client = new Client({ name: 'docker-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: 'node', args: ['dist/src/stdio.js'], env: process.env, stderr: 'inherit',
});
const watchdog = setTimeout(() => {
  console.error('Docker smoke test timed out after 60 seconds');
  process.exit(1);
}, 60_000);

try {
  await client.connect(transport);
  const compilation = await client.callTool({ name: 'vhdl_compile', arguments: {
    files: ['adder.vhd', 'adder_tb.vhd'],
  } });
  assert.ok(!compilation.isError, JSON.stringify(compilation));
  assert.equal(compilation.structuredContent?.ok, true, JSON.stringify(compilation));
  console.log('vhdl_compile: analysis passed');

  const simulation = await client.callTool({ name: 'vhdl_run', arguments: {
    files: ['adder.vhd', 'adder_tb.vhd'], testbench: 'adder_tb', stopTime: '30 ns',
  } });
  assert.ok(!simulation.isError, JSON.stringify(simulation));
  assert.equal(simulation.structuredContent?.ok, true, JSON.stringify(simulation));
  assert.ok(simulation.structuredContent.messages.some(message => message.text === 'adder passed'),
    JSON.stringify(simulation));
  console.log('vhdl_run: adder passed');

  const mutation = await client.callTool({ name: 'vhdl_mutate', arguments: {
    file: 'adder.vhd',
    testbenches: [{ files: ['adder.vhd', 'adder_tb.vhd'], top: 'adder_tb' }],
    mutations: [{ find: ' + ', replace: ' - ' }], stopTime: '30 ns',
  } });
  assert.ok(!mutation.isError, JSON.stringify(mutation));
  assert.deepEqual(mutation.structuredContent?.score, { caught: 1, total: 1, ratio: 1 },
    JSON.stringify(mutation));
  console.log('vhdl_mutate: arithmetic mutation caught');

  const script = await client.callTool({ name: 'do_file_check', arguments: { path: 'smoke.do' } });
  assert.ok(!script.isError, JSON.stringify(script));
  assert.equal(script.structuredContent?.ok, true, JSON.stringify(script));
  assert.equal(script.structuredContent.compiles.length, 2, JSON.stringify(script));
  assert.deepEqual(script.structuredContent.missing, [], JSON.stringify(script));
  assert.equal(script.structuredContent.simulate.top, 'work.adder_tb', JSON.stringify(script));
  console.log('do_file_check: two compile inputs found');
} finally {
  await client.close();
  clearTimeout(watchdog);
}
JS

echo 'Docker image smoke test passed'
