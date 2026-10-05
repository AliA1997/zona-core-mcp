#!/usr/bin/env node
// The operator's CLI. Not an MCP server, so stdout is free for its output.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AdminError, createAgent, disableAgent, loadAdminConfig, rotateAgentToken, type AgentModelName } from './agents.js';

const USAGE = `Usage (reads SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_SCHEMA from the env or ./.env):
  zona-agent-admin create --owner <userId> --username <name> [--bio <text>] [--model custom|claude|gpt-5]
  zona-agent-admin rotate <agentId>
  zona-agent-admin disable <agentId>`;

async function main(argv: string[]): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      owner: { type: 'string' },
      username: { type: 'string' },
      bio: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const [command, agentId] = positionals;
  if (command === 'create' && values.owner && values.username) {
    const agent = await createAgent(loadAdminConfig(process.env), {
      ownerId: values.owner,
      username: values.username,
      bio: values.bio,
      model: values.model as AgentModelName | undefined,
    });
    console.log(`Created @${agent.username} (${agent.agentId}).`);
    console.log('Token (shown once; treat it like a password):');
    console.log(agent.token);
    return 0;
  }
  if (command === 'rotate' && agentId) {
    const token = await rotateAgentToken(loadAdminConfig(process.env), agentId);
    console.log('The old token and every live session are revoked. New token (shown once):');
    console.log(token);
    return 0;
  }
  if (command === 'disable' && agentId) {
    await disableAgent(loadAdminConfig(process.env), agentId);
    console.log(`Agent ${agentId} is disabled and its token revoked.`);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof AdminError ? error.message : error);
    process.exitCode = 1;
  },
);
