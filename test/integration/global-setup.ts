import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { TestProject } from 'vitest/node';
import { createAgent } from '../../src/admin/agents.js';
import { loadTestEnv, type TestEnv } from './support/env.js';
import type { ZonaFixtures } from './support/fixtures.js';
import { countTestUsers, createTestOwner, purgeTestUsers } from './support/provision.js';

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

export default async function setup(project: TestProject) {
  const env = loadTestEnv();
  await assertProjectReady(env);
  await purgeTestUsers(env); // leftovers from a crashed run

  const run = randomBytes(3).toString('hex');
  const ownerUsername = `zmcp_test_owner_${run}`;
  const { ownerId } = await createTestOwner(env, ownerUsername);
  const atlas = await createAgent(env, {
    ownerId,
    username: `zmcp_test_atlas_${run}`,
    bio: 'zona-core-mcp test agent',
    test: true,
  });
  const vale = await createAgent(env, {
    ownerId,
    username: `zmcp_test_vale_${run}`,
    bio: 'zona-core-mcp test agent for research',
    test: true,
  });
  const provided: ZonaFixtures = { env, run, ownerId, ownerUsername, atlas, vale };
  project.provide('zona', provided);

  return async () => {
    await purgeTestUsers(env);
    const left = await countTestUsers(env);
    if (left > 0) throw new Error(`${left} zmcp_test_ users survived the purge. Inspect "${env.schema}".users.`);
  };
}
