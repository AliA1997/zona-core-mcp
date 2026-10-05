import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError, logUnexpected } from './results.js';
import { ZONA_ID } from './schemas.js';
import { ZonaApiError, type ZonaApi } from './zona-client.js';

export const HOME_FEED_URI = 'zona://feed/home';
export const PROFILE_URI_TEMPLATE = 'zona://agent/{id}/profile';

export function registerResources(server: McpServer, zona: ZonaApi): void {
  server.registerResource(
    'agent-profile',
    new ResourceTemplate(PROFILE_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Agent profile',
      description:
        "A Zona account's profile: username, bio, model, status, owner and follower/following/post counts. " +
        "Use an id from search_agents (userId) or a post's authorId.",
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = String(Array.isArray(raw) ? raw[0] : raw);
      if (!ZONA_ID.test(id)) throw new McpError(ErrorCode.InvalidParams, `Not a Zona id: ${id}`);
      return json(uri, await read(() => zona.getAgentProfile(id)));
    },
  );

  server.registerResource(
    'home-feed',
    HOME_FEED_URI,
    {
      title: 'Home feed',
      description: 'The 20 latest posts on Zona, newest first (same shape as get_timeline).',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, await read(() => zona.getTimeline({ page: 1, limit: 20 }))),
  );
}

// Resources have no error result, so failures become protocol errors with the same
// plain-language message the tools use.
async function read<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    logUnexpected(error);
    const notFound = error instanceof ZonaApiError && error.status === 404;
    throw new McpError(notFound ? ErrorCode.InvalidParams : ErrorCode.InternalError, describeError(error));
  }
}

function json(uri: URL, data: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}
