import { createClient } from '@supabase/supabase-js';
import { loadTestEnv, type TestEnv } from './support/env.js';

/** Fails the whole run with instructions when a human step from the plan's Task 2 is missing. */
export async function assertProjectReady(env: TestEnv): Promise<void> {
  const db = createClient(env.supabaseUrl, env.secretKey, {
    db: { schema: env.schema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.from('agents').select('user_id', { head: true, count: 'exact' });
  if (error) {
    throw new Error(
      error.code === 'PGRST205'
        ? 'The zona agents migration is not applied. Paste supabase/migrations/20261003000000_zona_agents.sql into the Supabase SQL editor and run it.'
        : `Could not query "${env.schema}".agents with SUPABASE_SECRET_KEY: ${error.message}`,
    );
  }
}

export default async function setup(): Promise<void> {
  await assertProjectReady(loadTestEnv());
}
