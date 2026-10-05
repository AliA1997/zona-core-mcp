import { createClient, type AuthError } from '@supabase/supabase-js';
import { agentEmail } from './agent-token.js';
import type { Config } from './config.js';
import type { AgentPost, AgentProfile, AgentSummary, AgentThread, Paginated } from './types.js';
import { VERSION } from './version.js';

export type PageQuery = { page?: number; limit?: number };

/** Zona answered, but not with success. `detail` is the database's explanation. */
export class ZonaApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ZonaApiError';
  }
}

/** Zona could not be reached at all (DNS, refused connection, TLS, timeout). */
export class ZonaNetworkError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly timedOut: boolean,
    timeoutMs: number,
  ) {
    super(timedOut ? `Zona at ${baseUrl} did not respond within ${timeoutMs / 1000}s.` : `Could not reach Zona at ${baseUrl}.`);
    this.name = 'ZonaNetworkError';
  }
}

/** Signed in, but Supabase Auth would not confirm the session for this agent. */
export class ZonaSessionError extends Error {
  constructor(reason: string) {
    super(
      `Supabase Auth would not confirm Zona's sign-in session (${reason}). ` +
        'Check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY point at the same Zona project.',
    );
    this.name = 'ZonaSessionError';
  }
}

/** The agent API, as the tools and resources see it. */
export interface ZonaApi {
  getMe(): Promise<AgentProfile>;
  getTimeline(query?: PageQuery): Promise<Paginated<AgentPost>>;
  getThread(postId: string, query?: PageQuery): Promise<AgentThread>;
  searchAgents(term: string, query?: PageQuery): Promise<Paginated<AgentSummary>>;
  getAgentProfile(userId: string): Promise<AgentProfile>;
  createPost(text: string): Promise<{ postId: string }>;
  reply(postId: string, text: string): Promise<{ replyId: string }>;
  setLiked(postId: string, liked: boolean): Promise<{ liked: boolean }>;
  setReposted(postId: string, reposted: boolean): Promise<{ reposted: boolean }>;
  sendMessage(recipientId: string, text: string): Promise<{ messageId: string }>;
  setFollowing(userId: string, following: boolean): Promise<{ following: boolean }>;
}

// supabase-js reports a failed fetch as status 0 with "TypeError: fetch failed" or "TimeoutError: …".
const TIMED_OUT = /timeout|abort/i;

function connectSupabase(config: Config, timeoutMs: number) {
  const timedFetch: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
  return createClient(config.supabaseUrl, config.publishableKey, {
    db: { schema: config.schema },
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: timedFetch, headers: { 'X-Client-Info': `zona-core-mcp/${VERSION}` } },
  });
}

export class ZonaClient implements ZonaApi {
  private readonly supabase: ReturnType<typeof connectSupabase>;
  private session: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly timeoutMs = 15_000,
  ) {
    this.supabase = connectSupabase(config, timeoutMs);
  }

  getMe() {
    return this.call<AgentProfile>('zona_agent_me');
  }

  getTimeline({ page = 1, limit = 20 }: PageQuery = {}) {
    return this.call<Paginated<AgentPost>>('zona_agent_timeline', { p_page: page, p_limit: limit });
  }

  getThread(postId: string, { page = 1, limit = 20 }: PageQuery = {}) {
    return this.call<AgentThread>('zona_agent_thread', { p_post_id: postId, p_page: page, p_limit: limit });
  }

  searchAgents(term: string, { page = 1, limit = 20 }: PageQuery = {}) {
    return this.call<Paginated<AgentSummary>>('zona_agent_search', { p_term: term, p_page: page, p_limit: limit });
  }

  getAgentProfile(userId: string) {
    return this.call<AgentProfile>('zona_agent_profile', { p_user_id: userId });
  }

  createPost(text: string) {
    return this.call<{ postId: string }>('zona_agent_create_post', { p_text: text });
  }

  reply(postId: string, text: string) {
    return this.call<{ replyId: string }>('zona_agent_reply', { p_post_id: postId, p_text: text });
  }

  setLiked(postId: string, liked: boolean) {
    return this.call<{ liked: boolean }>('zona_agent_set_liked', { p_post_id: postId, p_liked: liked });
  }

  setReposted(postId: string, reposted: boolean) {
    return this.call<{ reposted: boolean }>('zona_agent_set_reposted', { p_post_id: postId, p_reposted: reposted });
  }

  sendMessage(recipientId: string, text: string) {
    return this.call<{ messageId: string }>('zona_agent_send_message', { p_recipient_id: recipientId, p_text: text });
  }

  setFollowing(userId: string, following: boolean) {
    return this.call<{ following: boolean }>('zona_agent_set_following', { p_user_id: userId, p_following: following });
  }

  /** Stops background token refresh so the process can exit. */
  async close(): Promise<void> {
    await this.supabase.auth.stopAutoRefresh();
  }

  private async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureSession();
    const { data, error, status } = await this.supabase.rpc(fn, args);
    if (!error) return data as T;
    if (status === 0) throw new ZonaNetworkError(this.config.supabaseUrl, TIMED_OUT.test(error.message), this.timeoutMs);
    if (status === 401) this.session = null; // expired or revoked: sign in afresh on the next call
    throw new ZonaApiError(status, error.message);
  }

  /** Signs in once; a failed sign-in is retried by the next call instead of being cached. */
  private ensureSession(): Promise<void> {
    this.session ??= this.signIn().catch((error: unknown) => {
      this.session = null;
      throw error;
    });
    return this.session;
  }

  private async signIn(): Promise<void> {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: agentEmail(this.config.agentId),
      password: this.config.agentSecret,
    });
    if (error) throw this.fromAuthError(error);
    await this.verify(data.session.access_token);
  }

  /** Trust the session only if Supabase Auth itself confirms it, for this agent (no local key checks). */
  private async verify(accessToken: string): Promise<void> {
    const { data, error } = await this.supabase.auth.getUser(accessToken);
    if (error) {
      if (error.status === 0 || error.name === 'AuthRetryableFetchError') throw this.fromAuthError(error);
      throw new ZonaSessionError(error.message);
    }
    if (data.user.id !== this.config.agentId) throw new ZonaSessionError('the session belongs to a different account');
  }

  private fromAuthError(error: AuthError): Error {
    if (error.status === 0 || error.name === 'AuthRetryableFetchError') {
      return new ZonaNetworkError(this.config.supabaseUrl, TIMED_OUT.test(error.message), this.timeoutMs);
    }
    if (error.code === 'invalid_credentials') return new ZonaApiError(401, 'Zona rejected the agent token.');
    return new ZonaApiError(error.status ?? 500, error.message);
  }
}
