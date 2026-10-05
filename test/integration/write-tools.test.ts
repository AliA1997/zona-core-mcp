import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentThread } from '../../src/types.js';
import { ZonaClient } from '../../src/zona-client.js';
import { NOBODY, agentConfig, countRows, db, fixtures, uniqueText } from './support/fixtures.js';
import { connect, expectInvalidInput, jsonOf, textOf } from './support/mcp.js';

const ALL_TOOLS = [
  'create_post', 'follow', 'get_timeline', 'like', 'read_thread', 'reply', 'repost', 'search_agents', 'send_dm',
];
const A = () => fixtures().atlas.agentId;
const V = () => fixtures().vale.agentId;

let atlasZona: ZonaClient;
let valeZona: ZonaClient;
let atlas: Client;
let target: string; // a post by vale that atlas likes, reposts and replies to

beforeAll(async () => {
  atlasZona = new ZonaClient(agentConfig(fixtures().atlas.token));
  valeZona = new ZonaClient(agentConfig(fixtures().vale.token));
  atlas = await connect(atlasZona);
  ({ postId: target } = await valeZona.createPost(uniqueText('write target')));
});

afterAll(async () => {
  await atlas.close();
  await atlasZona.close();
  await valeZona.close();
});

describe('tool surface', () => {
  it('exposes exactly the nine Zona tools', async () => {
    const { tools } = await atlas.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  it('marks desired-state tools idempotent and writes as not read-only', async () => {
    const byName = new Map((await atlas.listTools()).tools.map((t) => [t.name, t]));
    for (const name of ['like', 'repost', 'follow']) expect(byName.get(name)!.annotations?.idempotentHint, name).toBe(true);
    for (const name of ['create_post', 'reply', 'send_dm']) {
      expect(byName.get(name)!.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)!.annotations?.idempotentHint, name).toBe(false);
    }
  });
});

describe('create_post', () => {
  it('posts trimmed text as the agent', async () => {
    const text = uniqueText('create');

    const { postId } = jsonOf(await atlas.callTool({ name: 'create_post', arguments: { text: `  ${text}  ` } })) as { postId: string };

    const { data } = await db().from('posts').select('user_id, content, post_type, related_post_id').eq('id', postId).single();
    expect(data).toEqual({ user_id: A(), content: text, post_type: 'post', related_post_id: null });
  });

  it.each(['', '   \n', 'x'.repeat(501)])('writes nothing for the text %j', async (text) => {
    const before = await countRows('posts', { user_id: A() });
    await expectInvalidInput(atlas.callTool({ name: 'create_post', arguments: { text } }));
    expect(await countRows('posts', { user_id: A() })).toBe(before);
  });

  it('accepts exactly 500 characters', async () => {
    const result = await atlas.callTool({ name: 'create_post', arguments: { text: uniqueText('max').padEnd(500, 'x') } });
    expect(result.isError).toBeFalsy();
  });
});

describe('reply', () => {
  it('replies as the agent', async () => {
    const { replyId } = jsonOf(
      await atlas.callTool({ name: 'reply', arguments: { postId: target, text: ' agreed ' } }),
    ) as { replyId: string };

    const { data } = await db().from('posts').select('user_id, content, post_type, related_post_id').eq('id', replyId).single();
    expect(data).toEqual({ user_id: A(), content: 'agreed', post_type: 'comment', related_post_id: target });
  });

  it('relays not-found as an error result', async () => {
    const result = await atlas.callTool({ name: 'reply', arguments: { postId: NOBODY, text: 'hi' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Not found: Post not found.');
  });
});

describe('desired-state tools', () => {
  it.each([
    ['like', 'liked'],
    ['repost', 'reposted'],
  ] as const)('%s sets the state, is safe to repeat, and can be undone', async (tool, flag) => {
    const rows = () => countRows('post_statuses', { post_id: target, user_id: A(), action: flag });

    await atlas.callTool({ name: tool, arguments: { postId: target } });
    await atlas.callTool({ name: tool, arguments: { postId: target } });
    expect(await rows()).toBe(1);

    const undo = await atlas.callTool({ name: tool, arguments: { postId: target, [flag]: false } });
    expect(jsonOf(undo)).toEqual({ [flag]: false });
    expect(await rows()).toBe(0);
  });

  it('three concurrent likes leave exactly one row', async () => {
    await Promise.all([1, 2, 3].map(() => atlas.callTool({ name: 'like', arguments: { postId: target } })));

    expect(await countRows('post_statuses', { post_id: target, user_id: A(), action: 'liked' })).toBe(1);
    const thread = jsonOf(await atlas.callTool({ name: 'read_thread', arguments: { postId: target } })) as AgentThread;
    expect(thread.post).toMatchObject({ likedByMe: true, likeCount: 1 });
  });

  it('follow sets the state, validates the id, and refuses to follow yourself', async () => {
    const rows = () => countRows('user_follows', { follower_id: A(), following_id: V() });

    await atlas.callTool({ name: 'follow', arguments: { agentId: V() } });
    await atlas.callTool({ name: 'follow', arguments: { agentId: V() } });
    expect(await rows()).toBe(1);
    await atlas.callTool({ name: 'follow', arguments: { agentId: V(), following: false } });
    expect(await rows()).toBe(0);

    await expectInvalidInput(atlas.callTool({ name: 'follow', arguments: { agentId: '@sable.watch' } }));
    const self = await atlas.callTool({ name: 'follow', arguments: { agentId: A() } });
    expect(textOf(self)).toBe('Zona rejected the request: An agent cannot follow itself.');
  });
});

describe('send_dm', () => {
  it('sends trimmed text to the recipient', async () => {
    const text = uniqueText('dm');

    const { messageId } = jsonOf(
      await atlas.callTool({ name: 'send_dm', arguments: { recipientId: V(), text: ` ${text} ` } }),
    ) as { messageId: string };

    const { data } = await db().from('messages').select('sender_id, recipient_id, content').eq('id', messageId).single();
    expect(data).toEqual({ sender_id: A(), recipient_id: V(), content: text });
  });

  it('allows 1000 characters and writes nothing for 1001', async () => {
    const rows = () => countRows('messages', { sender_id: A(), recipient_id: V() });
    const before = await rows();

    const accepted = await atlas.callTool({ name: 'send_dm', arguments: { recipientId: V(), text: 'x'.repeat(1000) } });
    await expectInvalidInput(atlas.callTool({ name: 'send_dm', arguments: { recipientId: V(), text: 'x'.repeat(1001) } }));

    expect(accepted.isError).toBeFalsy();
    expect(await rows()).toBe(before + 1);
  });

  it('refuses to message yourself or an unknown account', async () => {
    const self = await atlas.callTool({ name: 'send_dm', arguments: { recipientId: A(), text: 'hi' } });
    const nobody = await atlas.callTool({ name: 'send_dm', arguments: { recipientId: NOBODY, text: 'hi' } });

    expect(textOf(self)).toBe('Zona rejected the request: An agent cannot message itself.');
    expect(textOf(nobody)).toBe('Not found: Recipient not found.');
  });
});
