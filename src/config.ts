import { parseAgentToken } from './agent-token.js';

export const DEFAULT_SUPABASE_URL = 'https://iwybbgueyuxruebekmpy.supabase.co';
/** Publishable keys are public by design (every client app ships one); grants and RLS do the guarding. */
export const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_XJH40sowOERFRncfWa8keA_HiLzA9rb';
export const DEFAULT_SCHEMA = 'alsaqr-2026';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NEVER_SECRET =
  'Never give an agent server a secret key: it bypasses all row-level security. ' +
  "Use the project's publishable key (sb_publishable_…), or leave SUPABASE_PUBLISHABLE_KEY unset.";

export type Config = {
  agentId: string;
  agentSecret: string;
  supabaseUrl: string;
  publishableKey: string;
  jwksUrl: string;
  schema: string;
};

/** A configuration problem the person running the server must fix; the message says how. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The server's whole configuration. SUPABASE_SECRET_KEY is deliberately never read here. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.ZONA_AGENT_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      "ZONA_AGENT_TOKEN is not set. Ask the agent's owner for its Zona agent token and put it in this server's env.",
    );
  }
  const credentials = parseAgentToken(token);
  if (!credentials) {
    // Never echo the value: it may be some other real secret pasted by mistake.
    throw new ConfigError(
      'ZONA_AGENT_TOKEN is not a Zona agent token (expected "zat_", 32 hex characters, "_", then 43 characters).',
    );
  }

  const supabaseUrl = secureUrl('SUPABASE_URL', env.SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL);
  const jwksUrl = secureUrl(
    'SUPABASE_JWKS_URL',
    env.SUPABASE_JWKS_URL?.trim() || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
  );
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim() || DEFAULT_PUBLISHABLE_KEY;
  assertPublishable(publishableKey);

  return {
    agentId: credentials.agentId,
    agentSecret: credentials.secret,
    supabaseUrl,
    publishableKey,
    jwksUrl,
    schema: env.SUPABASE_SCHEMA?.trim() || DEFAULT_SCHEMA,
  };
}

function secureUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must be an https URL: ${raw}`);
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ConfigError(`${name} must use https (plain http would expose the agent's session): ${raw}`);
  }
  return raw.replace(/\/+$/, '');
}

function assertPublishable(key: string): void {
  // Never echo the key in any of these messages: it may be a real secret.
  if (key.startsWith('sb_secret_')) {
    throw new ConfigError(`SUPABASE_PUBLISHABLE_KEY holds a secret key. ${NEVER_SECRET}`);
  }
  if (key.startsWith('sb_publishable_')) return;
  const role = legacyRole(key);
  if (role === 'anon') return;
  if (role === 'service_role') {
    throw new ConfigError(`SUPABASE_PUBLISHABLE_KEY holds a service_role key. ${NEVER_SECRET}`);
  }
  throw new ConfigError('SUPABASE_PUBLISHABLE_KEY is not a Supabase publishable key (expected sb_publishable_…).');
}

/** The `role` claim of a legacy anon / service_role JWT key, or null if the key is not one. */
function legacyRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}
