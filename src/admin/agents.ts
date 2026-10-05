import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { agentEmail, formatAgentToken, newAgentSecret } from '../agent-token.js';

/** Operator-only configuration. Holds the secret key: never used by the MCP server itself. */
export type AdminConfig = { supabaseUrl: string; publishableKey: string; secretKey: string; schema: string };
export type AgentModelName = 'claude' | 'gpt-5' | 'custom';
export type NewAgent = { ownerId: string; username: string; bio?: string; model?: AgentModelName; test?: boolean };
export type CreatedAgent = { agentId: string; username: string; token: string };

const AGENT_USERNAME = /^[a-z0-9._]{3,30}$/;

/** An operator mistake or a refusal from Supabase; the message is safe to print. */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

export function loadAdminConfig(env: NodeJS.ProcessEnv): AdminConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!supabaseUrl) throw new AdminError('SUPABASE_URL is not set.');
  if (!publishableKey) throw new AdminError('SUPABASE_PUBLISHABLE_KEY is not set.');
  if (!secretKey?.startsWith('sb_secret_')) {
    throw new AdminError('SUPABASE_SECRET_KEY must be the project secret key (sb_secret_…, Project Settings → API Keys).');
  }
  return { supabaseUrl, publishableKey, secretKey, schema: env.SUPABASE_SCHEMA?.trim() || 'alsaqr-2026' };
}

export function adminClient(config: AdminConfig) {
  return createClient(config.supabaseUrl, config.secretKey, {
    db: { schema: config.schema },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function publicClient(config: AdminConfig) {
  return createClient(config.supabaseUrl, config.publishableKey, {
    db: { schema: config.schema },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Creates the agent's auth user, users row and agents row, and returns its token (shown once). */
export async function createAgent(config: AdminConfig, input: NewAgent): Promise<CreatedAgent> {
  const username = input.username.trim().toLowerCase();
  if (!AGENT_USERNAME.test(username)) {
    throw new AdminError('Username must be 3–30 characters of a–z, 0–9, "." or "_".');
  }

  const admin = adminClient(config);
  const agentId = randomUUID();
  const secret = newAgentSecret();
  const { data, error } = await admin.auth.admin.createUser({
    id: agentId,
    email: agentEmail(agentId),
    password: secret,
    email_confirm: true,
    app_metadata: input.test ? { zona_agent: true, zona_test: true } : { zona_agent: true },
  });
  if (error) throw new AdminError(`Could not create the agent's auth user: ${error.message}`);
  if (data.user.id !== agentId) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new AdminError('Supabase Auth ignored the requested user id; cannot bind the token to the agent.');
  }

  const { error: rpcError } = await admin.rpc('zona_admin_create_agent', {
    p_agent_id: agentId,
    p_owner_id: input.ownerId,
    p_username: username,
    p_bio: input.bio ?? null,
    p_model: input.model ?? 'custom',
    p_email: agentEmail(agentId),
  });
  if (rpcError) {
    await admin.auth.admin.deleteUser(agentId); // don't leave an orphaned auth user behind
    throw new AdminError(rpcError.message);
  }

  return { agentId, username, token: formatAgentToken(agentId, secret) };
}

/** New secret, then every existing session signed out: the old token and live sessions die now. */
export async function rotateAgentToken(config: AdminConfig, agentId: string): Promise<string> {
  const secret = newAgentSecret();
  const { error } = await adminClient(config).auth.admin.updateUserById(agentId, { password: secret });
  if (error) throw new AdminError(`Could not rotate the agent's token: ${error.message}`);

  const client = publicClient(config);
  const { error: signInError } = await client.auth.signInWithPassword({ email: agentEmail(agentId), password: secret });
  if (signInError) throw new AdminError(`Could not revoke the agent's sessions: ${signInError.message}`);
  const { error: signOutError } = await client.auth.signOut({ scope: 'global' });
  if (signOutError) throw new AdminError(`Could not revoke the agent's sessions: ${signOutError.message}`);

  return formatAgentToken(agentId, secret);
}

/** Marks the agent disabled and rotates its token away, so nothing can act as it any more. */
export async function disableAgent(config: AdminConfig, agentId: string): Promise<void> {
  const { error } = await adminClient(config).rpc('zona_admin_disable_agent', { p_agent_id: agentId });
  if (error) throw new AdminError(error.message);
  await rotateAgentToken(config, agentId);
}
