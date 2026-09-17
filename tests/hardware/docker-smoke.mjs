import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'hardware-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
const names = (await client.listTools()).tools.map(({ name }) => name);
for (const name of ['rars_run', 'hardware_capabilities', 'hardware_job_start', 'hardware_job_status']) {
  if (!names.includes(name)) throw new Error(`missing tool ${name}`);
}
const capabilities = await client.callTool({ name: 'hardware_capabilities', arguments: {} });
if (capabilities.isError || !JSON.stringify(capabilities).includes('verilator')) throw new Error(JSON.stringify(capabilities));

let traceJobId;
for (const [manifestPath, target] of [['sv/hardware.project.yaml', 'unit'], ['vhdl/hardware.project.yaml', 'unit'], ['rars/hardware.project.yaml', 'trace']]) {
  const validation = await client.callTool({ name: 'hardware_project_validate', arguments: { manifestPath, target } });
  if (validation.isError) throw new Error(JSON.stringify(validation));
  const started = await client.callTool({ name: 'hardware_job_start', arguments: { manifestPath, target } });
  if (started.isError) throw new Error(JSON.stringify(started));
  const id = started.structuredContent.id;
  let terminal;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await client.callTool({ name: 'hardware_job_status', arguments: { jobId: id } });
    terminal = status.structuredContent;
    if (['succeeded', 'failed', 'cancelled', 'aborted'].includes(terminal.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (terminal?.state !== 'succeeded') throw new Error(JSON.stringify(terminal));
  if (target === 'trace') traceJobId = id;
}

const traceArtifacts = await client.callTool({ name: 'hardware_artifact_list', arguments: { jobId: traceJobId } });
const traceArtifact = traceArtifacts.structuredContent.artifacts.find(({ type }) => type === 'trace');
if (!traceArtifact) throw new Error(JSON.stringify(traceArtifacts));
const compared = await client.callTool({ name: 'hardware_trace_compare', arguments: { left: { jobId: traceJobId, artifactId: traceArtifact.id, format: 'normalized' }, right: { jobId: traceJobId, artifactId: traceArtifact.id, format: 'normalized' } } });
if (compared.isError || compared.structuredContent.equal !== true) throw new Error(JSON.stringify(compared));

const rars = await client.callTool({ name: 'rars_run', arguments: { files: ['hello.asm'] } });
if (rars.isError || !JSON.stringify(rars).includes('hello from rars')) throw new Error(JSON.stringify(rars));
await client.close();
