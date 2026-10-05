import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createAgent, rotateAgentToken } from '../../src/admin/agents.js';
import type { AgentPost, AgentSummary, AgentThread, Paginated } from '../../src/types.js';
import { ZonaClient } from '../../src/zona-client.js';
import { DEAD_URL, NOBODY, agentConfig, fixtures, uniqueText } from './support/fixtures.js';
import { connect, expectInvalidInput, jsonOf, textOf } from './support/mcp.js';

let atlasZona: ZonaClient;
let valeZona: ZonaClient;
let atlas: Client;
let text: string;
let postId: string;
let replyId: string;

beforeAll(async () => {
  atlasZona = new ZonaClient(agentConfig(fixtures().atlas.token));
  valeZona = new ZonaClient(agentConfig(fixtures().vale.token));
  atlas = await connect(atlasZona);
  text = uniqueText('read-tools');
  ({ postId } = await atlasZona.createPost(text));
  ({ replyId } = await valeZona.reply(postId, 'zmcp test reply'));
});

afterAll(async () => {
  await atlas.close();
  await atlasZona.close();
  await valeZona.close();
});

describe('read tools', () => {
  it('are registered as read-only, with descriptions', async () => {
    const { tools } = await atlas.listTools();
    for (const name of ['get_timeline', 'read_thread', 'search_agents']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations?.readOnlyHint, name).toBe(true);
      expect(tool!.description, name).toBeTruthy();
    }
  });

  it('get_timeline shows the newest posts with author id, model and status', async () => {
    const result = await atlas.callTool({ name: 'get_timeline', arguments: { limit: 10 } });

    expect(result.isError).toBeFalsy();
    const page = jsonOf(result) as Paginated<AgentPost>;
    expect(page.pagination).toMatchObject({ currentPage: 1, itemsPerPage: 10 });
    expect(page.items.find((p) => p.postId === postId)).toMatchObject({
      text,
      authorId: fixtures().atlas.agentId,
      authorUsername: fixtures().atlas.username,
      authorModel: 'custom',
      authorStatus: 'online',
      replyCount: 1,
      likedByMe: false,
    });
  });

  it('get_timeline defaults to 20 per page', async () => {
    const page = jsonOf(await atlas.callTool({ name: 'get_timeline', arguments: {} })) as Paginated<AgentPost>;
    expect(page.pagination).toMatchObject({ currentPage: 1, itemsPerPage: 20 });
  });

  it('get_timeline pages do not overlap', async () => {
    // A real user posting between the two calls could shift one item; rerun before suspecting the SQL.
    const first = jsonOf(await atlas.callTool({ name: 'get_timeline', arguments: { page: 1, limit: 5 } })) as Paginated<AgentPost>;
    const second = jsonOf(await atlas.callTool({ name: 'get_timeline', arguments: { page: 2, limit: 5 } })) as Paginated<AgentPost>;

    expect(second.pagination.currentPage).toBe(2);
    const firstIds = new Set(first.items.map((p) => p.postId));
    expect(second.items.some((p) => firstIds.has(p.postId))).toBe(false);
  });

  it.each([{ limit: 51 }, { limit: 0 }, { page: 0 }, { page: 1.5 }])('get_timeline rejects %o', async (args) => {
    await expectInvalidInput(atlas.callTool({ name: 'get_timeline', arguments: args }));
  });

  it('read_thread shows the post and its replies oldest first, and accepts an upper-case id', async () => {
    const thread = jsonOf(
      await atlas.callTool({ name: 'read_thread', arguments: { postId: postId.toUpperCase() } }),
    ) as AgentThread;

    expect(thread.post).toMatchObject({ postId, text, replyCount: 1 });
    expect(thread.replies.items.map((r) => r.postId)).toEqual([replyId]);
    expect(thread.replies.items[0]).toMatchObject({ authorId: fixtures().vale.agentId, replyToPostId: postId });
  });

  it('read_thread reports an unknown post', async () => {
    const result = await atlas.callTool({ name: 'read_thread', arguments: { postId: NOBODY } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Not found: Post not found.');
  });

  it.each(['atlas.core', 'p1', '', `${NOBODY}x`])('read_thread rejects the non-id %j', async (badId) => {
    await expectInvalidInput(atlas.callTool({ name: 'read_thread', arguments: { postId: badId } }));
  });

  it('search_agents finds an agent by name, trimming the query', async () => {
    const { run, atlas: agent } = fixtures();
    const page = jsonOf(
      await atlas.callTool({ name: 'search_agents', arguments: { query: `  atlas_${run}  ` } }),
    ) as Paginated<AgentSummary>;

    expect(page.items).toEqual([
      expect.objectContaining({ userId: agent.agentId, username: agent.username, model: 'custom', bio: 'zona-core-mcp test agent' }),
    ]);
  });

  it('search_agents finds an agent by bio', async () => {
    const page = jsonOf(
      await atlas.callTool({ name: 'search_agents', arguments: { query: 'test agent for research' } }),
    ) as Paginated<AgentSummary>;
    expect(page.items.map((s) => s.userId)).toContain(fixtures().vale.agentId);
  });

  it('search_agents treats % literally', async () => {
    const page = jsonOf(
      await atlas.callTool({ name: 'search_agents', arguments: { query: 'zmcp%atlas' } }),
    ) as Paginated<AgentSummary>;
    expect(page.items).toEqual([]);
  });

  it.each(['', '   ', 'x'.repeat(101)])('search_agents rejects the query %j', async (query) => {
    await expectInvalidInput(atlas.callTool({ name: 'search_agents', arguments: { query } }));
  });

  it('turns a revoked token into an actionable error result', async () => {
    const { env, ownerId, run } = fixtures();
    const agent = await createAgent(env, { ownerId, username: `zmcp_test_rev_${run}`, test: true });
    const zona = new ZonaClient(agentConfig(agent.token));
    const client = await connect(zona);
    expect((await client.callTool({ name: 'get_timeline', arguments: { limit: 1 } })).isError).toBeFalsy();

    await rotateAgentToken(env, agent.agentId);
    const result = await client.callTool({ name: 'get_timeline', arguments: { limit: 1 } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/revoked/);
    await client.close();
    await zona.close();
  });

  it('survives Zona being unreachable and keeps serving', async () => {
    const zona = new ZonaClient(agentConfig(fixtures().atlas.token, { SUPABASE_URL: DEAD_URL }));
    const client = await connect(zona);

    const down = await client.callTool({ name: 'get_timeline', arguments: {} });

    expect(down.isError).toBe(true);
    expect(textOf(down)).toBe(`Could not reach Zona at ${DEAD_URL}. Check the network connection and SUPABASE_URL.`);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    await zona.close();
  });
});
