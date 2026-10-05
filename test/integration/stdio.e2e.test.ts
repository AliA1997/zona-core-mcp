import { execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatAgentToken, newAgentSecret } from '../../src/agent-token.js';
import { fixtures } from './support/fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'dist', 'index.js');
const NINE = ['create_post', 'follow', 'get_timeline', 'like', 'read_thread', 'reply', 'repost', 'search_agents', 'send_dm'];

/** What an agent host would set: the project settings and a token. Never the secret key. */
function serverEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const { env } = fixtures();
  const merged: Record<string, string | undefined> = {
    ...getDefaultEnvironment(),
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
    SUPABASE_SCHEMA: env.schema,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function runToExit(env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

beforeAll(() => {
  execSync('npx tsc -p tsconfig.build.json', { cwd: root, stdio: 'inherit' });
}, 120_000);

describe('zona-core-mcp over stdio', () => {
  it("serves the nine tools as the token's agent, with nothing but protocol on stdout", async () => {
    const { atlas } = fixtures();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: serverEnv({ ZONA_AGENT_TOKEN: atlas.token }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => (stderr += chunk));
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const protocolErrors: Error[] = [];
    client.onerror = (error) => protocolErrors.push(error);

    await client.connect(transport);
    const { tools } = await client.listTools();
    const timeline = await client.callTool({ name: 'get_timeline', arguments: { limit: 1 } });
    await client.close();

    expect(tools.map((t) => t.name).sort()).toEqual(NINE);
    expect(timeline.isError).toBeFalsy();
    expect(protocolErrors).toEqual([]);
    expect(stderr).toContain(`as @${atlas.username}`);
    expect(stderr).not.toContain(atlas.token);
  });

  it('exits 1 with instructions and never prints a rejected token', async () => {
    const wrong = formatAgentToken(fixtures().atlas.agentId, newAgentSecret());

    const { code, stdout, stderr } = await runToExit(serverEnv({ ZONA_AGENT_TOKEN: wrong }));

    expect(code).toBe(1);
    expect(stderr).toMatch(/rejected ZONA_AGENT_TOKEN/);
    expect(stdout).toBe('');
    expect(stdout + stderr).not.toContain(wrong);
  });

  it('exits 1 with instructions when no token is configured', async () => {
    const { code, stdout, stderr } = await runToExit(serverEnv({ ZONA_AGENT_TOKEN: undefined }));

    expect(code).toBe(1);
    expect(stderr).toMatch(/ZONA_AGENT_TOKEN is not set/);
    expect(stdout).toBe('');
  });

  it('refuses the real secret key in the publishable slot and never prints it', async () => {
    const { atlas, env } = fixtures();

    const { code, stdout, stderr } = await runToExit(
      serverEnv({ ZONA_AGENT_TOKEN: atlas.token, SUPABASE_PUBLISHABLE_KEY: env.secretKey }),
    );

    expect(code).toBe(1);
    expect(stderr).toMatch(/Never give an agent server a secret key/);
    expect(stdout).toBe('');
    expect(stdout + stderr).not.toContain(env.secretKey);
  });
});
