import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, rotateAgentToken } from '../../src/admin/agents.js';
import { formatAgentToken, newAgentSecret } from '../../src/agent-token.js';
import { ZonaApiError, ZonaClient, ZonaNetworkError, ZonaSessionError } from '../../src/zona-client.js';
import { DEAD_URL, NOBODY, agentConfig, fixtures, uniqueText } from './support/fixtures.js';
import { mismatchedAuthServer, silentServer } from './support/local-servers.js';

let atlas: ZonaClient;

beforeAll(() => {
  atlas = new ZonaClient(agentConfig(fixtures().atlas.token));
});

afterAll(async () => {
  await atlas.close();
});

describe('ZonaClient against the real project', () => {
  it("signs in as the token's agent", async () => {
    const { atlas: agent, ownerUsername } = fixtures();
    expect(await atlas.getMe()).toMatchObject({
      userId: agent.agentId,
      username: agent.username,
      isAgent: true,
      model: 'custom',
      status: 'online',
      ownerUsername,
    });
  });

  it('pages the timeline', async () => {
    const page = await atlas.getTimeline({ page: 1, limit: 3 });
    expect(page.items.length).toBeLessThanOrEqual(3);
    expect(page.pagination).toMatchObject({ currentPage: 1, itemsPerPage: 3 });
  });

  it('round-trips a post with author id, model and status', async () => {
    const text = uniqueText('client');
    const { postId } = await atlas.createPost(text);

    const thread = await atlas.getThread(postId);

    expect(thread.post).toMatchObject({
      postId,
      text,
      authorId: fixtures().atlas.agentId,
      authorModel: 'custom',
      authorStatus: 'online',
      replyToPostId: null,
      likedByMe: false,
    });
    expect(thread.replies.items).toEqual([]);
  });

  it('maps an unknown post to a 404 carrying the database message', async () => {
    const error = await atlas.getThread(NOBODY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZonaApiError);
    expect(error).toMatchObject({ status: 404, detail: 'Post not found.' });
  });

  it('maps a database rule to a 400', async () => {
    await expect(atlas.setFollowing(fixtures().atlas.agentId, true))
      .rejects.toMatchObject({ status: 400, detail: 'An agent cannot follow itself.' });
  });

  it('rejects a token with the wrong secret as a 401', async () => {
    const wrong = new ZonaClient(agentConfig(formatAgentToken(fixtures().atlas.agentId, newAgentSecret())));
    await expect(wrong.getMe()).rejects.toMatchObject({ status: 401 });
    await wrong.close();
  });

  it('a rotated token stops working mid-session', async () => {
    const { env, ownerId, run } = fixtures();
    const agent = await createAgent(env, { ownerId, username: `zmcp_test_cli_${run}`, test: true });
    const client = new ZonaClient(agentConfig(agent.token));
    await client.getMe();

    await rotateAgentToken(env, agent.agentId);

    await expect(client.getMe()).rejects.toMatchObject({ status: 401 });
    await client.close();
  });

  it('reports an unreachable project as a network error without leaking the token', async () => {
    const dead = new ZonaClient(agentConfig(fixtures().atlas.token, { SUPABASE_URL: DEAD_URL }));
    const error = await dead.getMe().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ZonaNetworkError);
    expect((error as Error).message).toBe(`Could not reach Zona at ${DEAD_URL}.`);
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toContain(fixtures().atlas.token.slice(37));
    await dead.close();
  });

  it('reports a project that never answers as a timeout', async () => {
    const silent = await silentServer();
    try {
      const slow = new ZonaClient(agentConfig(fixtures().atlas.token, { SUPABASE_URL: silent.url }), 300);
      await expect(slow.getMe()).rejects.toThrowError(`Zona at ${silent.url} did not respond within 0.3s.`);
      await slow.close();
    } finally {
      await silent.close();
    }
  });

  it('refuses a session that Supabase Auth does not confirm for this agent', async () => {
    const auth = await mismatchedAuthServer();
    try {
      const untrusting = new ZonaClient(agentConfig(fixtures().atlas.token, { SUPABASE_URL: auth.url }));
      const error = await untrusting.getMe().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZonaSessionError);
      expect((error as Error).message).toMatch(/would not confirm|different account/);
      await untrusting.close();
    } finally {
      await auth.close();
    }
  });
});
