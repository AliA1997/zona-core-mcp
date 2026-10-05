#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createServer } from './server.js';
import { checkToken } from './startup.js';
import { ZonaClient } from './zona-client.js';

// stdout is the MCP channel; every human-readable line goes to stderr.
const log = (message: string) => console.error(`zona-core-mcp: ${message}`);

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(error.message);
    process.exitCode = 1;
    return;
  }

  const zona = new ZonaClient(config);
  const check = await checkToken(zona);
  if (check.kind === 'rejected' || check.kind === 'untrusted') {
    log(
      check.kind === 'rejected'
        ? "Zona rejected ZONA_AGENT_TOKEN. It may be revoked or mistyped. Ask the agent's owner for a new token."
        : check.reason,
    );
    await zona.close();
    process.exitCode = 1;
    return;
  }
  if (check.kind === 'degraded') log(`starting without verifying the token: ${check.reason}`);

  await createServer(zona).connect(new StdioServerTransport());
  log(check.kind === 'ok' ? `connected to ${config.supabaseUrl} as @${check.username}` : `connected to ${config.supabaseUrl}`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
