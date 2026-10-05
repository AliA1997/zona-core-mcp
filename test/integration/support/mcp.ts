import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../../src/server.js';
import type { ZonaApi } from '../../../src/zona-client.js';

/** A real MCP client wired to our real server, over the SDK's in-memory transport. */
export async function connect(zona: ZonaApi): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(zona).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: unknown): string {
  const first = (result as CallToolResult).content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

export function jsonOf(result: unknown): unknown {
  return JSON.parse(textOf(result));
}

/**
 * Invalid arguments are refused by the server's schema. Depending on SDK version they come
 * back as an isError tool result or a rejected call; either is acceptable.
 */
export async function expectInvalidInput(call: Promise<unknown>): Promise<void> {
  try {
    const result = (await call) as CallToolResult;
    expect(result.isError).toBe(true);
  } catch (error) {
    expect(String(error)).toMatch(/invalid|validation|expected/i);
  }
}
