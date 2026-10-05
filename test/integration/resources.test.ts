import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentPost, AgentProfile, Paginated } from '../../src/types.js';
import { ZonaClient } from '../../src/zona-client.js';
import { DEAD_URL, NOBODY, agentConfig, fixtures, uniqueText } from './support/fixtures.js';
import { connect } from './support/mcp.js';

let zona: ZonaClient;
let client: Client;
let postId: string;

function jsonContent(contents: unknown[]): unknown {
  return JSON.parse((contents[0] as { text: string }).text);
}

beforeAll(async () => {
  zona = new ZonaClient(agentConfig(fixtures().atlas.token));
  client = await connect(zona);
  ({ postId } = await zona.createPost(uniqueText('resources')));
});

afterAll(async () => {
  await client.close();
  await zona.close();
});

describe('resources', () => {
  it('advertises the home feed and the profile template', async () => {
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources.map((r) => r.uri)).toContain('zona://feed/home');
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('zona://agent/{id}/profile');
  });

  it('zona://feed/home is the 20 newest posts as JSON', async () => {
    const { contents } = await client.readResource({ uri: 'zona://feed/home' });

    expect(contents[0]).toMatchObject({ uri: 'zona://feed/home', mimeType: 'application/json' });
    const feed = jsonContent(contents) as Paginated<AgentPost>;
    expect(feed.pagination).toMatchObject({ currentPage: 1, itemsPerPage: 20 });
    expect(feed.items.some((p) => p.postId === postId)).toBe(true);
  });

  it('zona://agent/{id}/profile reads an agent with model, status and owner', async () => {
    const { vale, ownerUsername } = fixtures();
    const uri = `zona://agent/${vale.agentId}/profile`;

    const { contents } = await client.readResource({ uri });

    expect(contents[0]).toMatchObject({ uri, mimeType: 'application/json' });
    expect(jsonContent(contents) as AgentProfile).toMatchObject({
      userId: vale.agentId,
      username: vale.username,
      bio: 'zona-core-mcp test agent for research',
      isAgent: true,
      model: 'custom',
      status: expect.stringMatching(/^(online|idle|offline)$/),
      ownerUsername,
    });
  });

  it("a human's profile has no model or status", async () => {
    const { ownerId, ownerUsername } = fixtures();
    const { contents } = await client.readResource({ uri: `zona://agent/${ownerId}/profile` });

    expect(jsonContent(contents)).toMatchObject({
      username: ownerUsername,
      isAgent: false,
      model: null,
      status: null,
      ownerUsername: null,
    });
  });

  it('rejects a profile URI whose id is not a Zona id', async () => {
    await expect(client.readResource({ uri: 'zona://agent/vale.research/profile' })).rejects.toThrow(/Not a Zona id/);
  });

  it('reports an unknown account as not found', async () => {
    await expect(client.readResource({ uri: `zona://agent/${NOBODY}/profile` })).rejects.toThrow(/Not found: User not found/);
  });

  it('reports an unreachable Zona on the feed', async () => {
    const dead = new ZonaClient(agentConfig(fixtures().atlas.token, { SUPABASE_URL: DEAD_URL }));
    const deadClient = await connect(dead);

    await expect(deadClient.readResource({ uri: 'zona://feed/home' })).rejects.toThrow(/Could not reach Zona/);
    await deadClient.close();
    await dead.close();
  });
});
