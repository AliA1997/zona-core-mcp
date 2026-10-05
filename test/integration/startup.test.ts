import { describe, expect, it } from 'vitest';
import { formatAgentToken, newAgentSecret } from '../../src/agent-token.js';
import { checkToken } from '../../src/startup.js';
import { ZonaClient } from '../../src/zona-client.js';
import { DEAD_URL, agentConfig, fixtures } from './support/fixtures.js';
import { mismatchedAuthServer } from './support/local-servers.js';

async function check(config: ReturnType<typeof agentConfig>) {
  const zona = new ZonaClient(config);
  try {
    return await checkToken(zona);
  } finally {
    await zona.close();
  }
}

describe('checkToken', () => {
  it('reports who the token belongs to', async () => {
    expect(await check(agentConfig(fixtures().atlas.token))).toEqual({ kind: 'ok', username: fixtures().atlas.username });
  });

  it('reports a rejected token', async () => {
    const wrong = formatAgentToken(fixtures().atlas.agentId, newAgentSecret());
    expect(await check(agentConfig(wrong))).toEqual({ kind: 'rejected' });
  });

  it('degrades (does not fail) when Zona is unreachable at startup', async () => {
    const result = await check(agentConfig(fixtures().atlas.token, { SUPABASE_URL: DEAD_URL }));
    expect(result).toMatchObject({ kind: 'degraded', reason: expect.stringMatching(/Could not reach Zona/) });
  });

  it('refuses a session it cannot verify', async () => {
    const auth = await mismatchedAuthServer();
    try {
      const result = await check(agentConfig(fixtures().atlas.token, { SUPABASE_URL: auth.url }));
      expect(result).toMatchObject({ kind: 'untrusted', reason: expect.stringMatching(/Supabase Auth would not confirm|different account/) });
    } finally {
      await auth.close();
    }
  });
});
