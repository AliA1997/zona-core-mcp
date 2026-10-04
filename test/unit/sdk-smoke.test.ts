import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('installed MCP SDK', () => {
  it('registers a zod 4 tool that an in-memory client can list and call', async () => {
    const server = new McpServer({ name: 'smoke', version: '0.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'smoke-client', version: '0.0.0' });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
    });
  });
});
