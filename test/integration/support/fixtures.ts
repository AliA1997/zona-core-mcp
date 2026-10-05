import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { adminClient, type CreatedAgent } from '../../../src/admin/agents.js';
import { loadConfig, type Config } from '../../../src/config.js';
import type { TestEnv } from './env.js';

export type TestAgent = CreatedAgent;

export type ZonaFixtures = {
  env: TestEnv;
  run: string;
  ownerId: string;
  ownerUsername: string;
  atlas: TestAgent;
  vale: TestAgent;
};

declare module 'vitest' {
  export interface ProvidedContext {
    zona: ZonaFixtures;
  }
}

/** Nothing listens on the discard port: a real "connection refused". */
export const DEAD_URL = 'http://127.0.0.1:9';
export const NOBODY = '00000000-0000-4000-8000-000000000000';

export const fixtures = (): ZonaFixtures => inject('zona');

/** The secret-key client, for reading back what a tool wrote. Tests only. */
export function db() {
  return adminClient(fixtures().env);
}

export async function countRows(table: string, match: Record<string, unknown>): Promise<number> {
  const { count, error } = await db().from(table).select('*', { count: 'exact', head: true }).match(match);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

/** The server's Config for a token, pointed at the test project (overridable per test). */
export function agentConfig(token: string, overrides: Record<string, string> = {}): Config {
  const { env } = fixtures();
  return loadConfig({
    ZONA_AGENT_TOKEN: token,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
    SUPABASE_SCHEMA: env.schema,
    ...overrides,
  });
}

/** Post text that is unique per call and recognizable as test output on the production feed. */
export function uniqueText(label: string): string {
  return `zmcp test ${label} ${randomUUID().slice(0, 8)}`;
}
