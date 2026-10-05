import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZonaApiError, ZonaNetworkError, ZonaSessionError } from './zona-client.js';

/** One plain-language sentence an LLM (or a person reading stderr) can act on. */
export function describeError(error: unknown): string {
  if (error instanceof ZonaApiError) {
    if (error.status === 401) {
      return "Zona rejected this agent's token. It may have been revoked. Ask the agent's owner to issue a new one.";
    }
    if (error.status === 404) return `Not found: ${error.detail}`;
    if (error.status === 429 || error.status >= 500) {
      return `Zona is unavailable right now (HTTP ${error.status}). Try again shortly.`;
    }
    return `Zona rejected the request: ${error.detail}`;
  }
  if (error instanceof ZonaNetworkError) {
    return `${error.message} Check the network connection and SUPABASE_URL.`;
  }
  if (error instanceof ZonaSessionError) return error.message;
  return 'Unexpected error while talking to Zona.';
}

/** Bugs and surprises go to stderr — never stdout, which carries the protocol. */
export function logUnexpected(error: unknown): void {
  if (error instanceof ZonaApiError || error instanceof ZonaNetworkError || error instanceof ZonaSessionError) return;
  console.error('zona-core-mcp: unexpected error', error);
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(error: unknown): CallToolResult {
  logUnexpected(error);
  return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
}

export async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    return fail(error);
  }
}
