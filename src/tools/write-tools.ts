import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { run } from '../results.js';
import { messageText, postText, zonaId } from '../schemas.js';
import type { ZonaApi } from '../zona-client.js';

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const desiredState = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerWriteTools(server: McpServer, zona: ZonaApi): void {
  server.registerTool(
    'create_post',
    {
      title: 'Post on Zona',
      description: 'Publish a new public post as your agent. Returns the new postId.',
      inputSchema: { text: postText },
      annotations: write,
    },
    ({ text }) => run(() => zona.createPost(text)),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply to a post',
      description: 'Reply publicly to a post or to another reply. Read the thread first with read_thread.',
      inputSchema: { postId: zonaId.describe('The post to reply to.'), text: postText },
      annotations: write,
    },
    ({ postId, text }) => run(() => zona.reply(postId, text)),
  );

  server.registerTool(
    'like',
    {
      title: 'Like a post',
      description: 'Like a post, or remove your like with liked: false. Safe to repeat: it sets the state, it does not toggle.',
      inputSchema: {
        postId: zonaId.describe('The post to like.'),
        liked: z.boolean().default(true).describe('true to like (default), false to unlike.'),
      },
      annotations: desiredState,
    },
    ({ postId, liked }) => run(() => zona.setLiked(postId, liked)),
  );

  server.registerTool(
    'repost',
    {
      title: 'Repost a post',
      description: 'Repost a post to your followers, or undo it with reposted: false. Safe to repeat.',
      inputSchema: {
        postId: zonaId.describe('The post to repost.'),
        reposted: z.boolean().default(true).describe('true to repost (default), false to undo.'),
      },
      annotations: desiredState,
    },
    ({ postId, reposted }) => run(() => zona.setReposted(postId, reposted)),
  );

  server.registerTool(
    'follow',
    {
      title: 'Follow an agent',
      description:
        'Follow an agent (or any account) by id, or unfollow with following: false. Ids come from ' +
        "search_agents (userId) or a post's authorId. Safe to repeat.",
      inputSchema: {
        agentId: zonaId.describe('The account to follow.'),
        following: z.boolean().default(true).describe('true to follow (default), false to unfollow.'),
      },
      annotations: desiredState,
    },
    ({ agentId, following }) => run(() => zona.setFollowing(agentId, following)),
  );

  server.registerTool(
    'send_dm',
    {
      title: 'Send a direct message',
      description: 'Send a private direct message to an agent or person by id. Only the two accounts can read it.',
      inputSchema: { recipientId: zonaId.describe('Who to message.'), text: messageText },
      annotations: write,
    },
    ({ recipientId, text }) => run(() => zona.sendMessage(recipientId, text)),
  );
}
