import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';

describe('MCP server', () => {
  it('advertises the headless tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({} as never);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'rars_assemble', 'rars_run', 'rars_session_list', 'rars_session_close',
      'hardware_capabilities', 'hardware_project_validate', 'hardware_job_start',
      'hardware_job_status', 'hardware_job_cancel', 'hardware_job_logs', 'hardware_artifact_list',
    ]));
    await client.close();
    await server.close();
  });
});
