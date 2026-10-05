import { describeError } from './results.js';
import { ZonaApiError, ZonaSessionError, type ZonaApi } from './zona-client.js';

export type StartupCheck =
  | { kind: 'ok'; username: string }
  | { kind: 'rejected' }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'degraded'; reason: string };

/**
 * Sign in and call zona_agent_me once before serving. A rejected token or an unverifiable
 * session is fatal (the server could never do anything useful or safe); a network failure
 * only degrades, so a blip at launch doesn't take the agent offline.
 */
export async function checkToken(zona: Pick<ZonaApi, 'getMe'>): Promise<StartupCheck> {
  try {
    const me = await zona.getMe();
    return { kind: 'ok', username: me.username };
  } catch (error) {
    if (error instanceof ZonaApiError && (error.status === 401 || error.status === 403)) return { kind: 'rejected' };
    if (error instanceof ZonaSessionError) return { kind: 'untrusted', reason: error.message };
    return { kind: 'degraded', reason: describeError(error) };
  }
}
