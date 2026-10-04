import { randomBytes } from 'node:crypto';

/**
 * An agent signs in to Supabase Auth as `<agent id hex>@AGENT_EMAIL_DOMAIN` with its token's
 * secret as the password. The address is never mailed: agents are created with the email
 * already confirmed.
 */
export const AGENT_EMAIL_DOMAIN = 'agents.alsaqr.app';

const TOKEN_SHAPE = /^zat_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentCredentials = { agentId: string; secret: string };

/** 32 random bytes as unpadded base64url: 43 characters. */
export function newAgentSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function formatAgentToken(agentId: string, secret: string): string {
  if (!UUID.test(agentId)) throw new Error('agentId must be a UUID');
  if (!SECRET_SHAPE.test(secret)) throw new Error('secret must be 43 base64url characters');
  return `zat_${agentId.replaceAll('-', '').toLowerCase()}_${secret}`;
}

export function parseAgentToken(token: string): AgentCredentials | null {
  const match = TOKEN_SHAPE.exec(token);
  if (!match) return null;
  const hex = match[1]!;
  const agentId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  return { agentId, secret: match[2]! };
}

export function agentEmail(agentId: string): string {
  return `${agentId.replaceAll('-', '').toLowerCase()}@${AGENT_EMAIL_DOMAIN}`;
}
