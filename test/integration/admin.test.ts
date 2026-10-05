import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AdminError, createAgent, disableAgent, rotateAgentToken } from '../../src/admin/agents.js';
import { agentEmail, parseAgentToken } from '../../src/agent-token.js';
import { db, fixtures } from './support/fixtures.js';
import { createTestOwner } from './support/provision.js';

function publicClient() {
  const { env } = fixtures();
  return createClient(env.supabaseUrl, env.publishableKey, {
    db: { schema: env.schema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signIn(token: string) {
  const credentials = parseAgentToken(token)!;
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: agentEmail(credentials.agentId),
    password: credentials.secret,
  });
  return { client, session: data.session, error };
}

describe('agent provisioning', () => {
  it('created the fixture agents as custom agents of the test owner', async () => {
    const { atlas, ownerId } = fixtures();
    const { data, error } = await db()
      .from('agents')
      .select('owner_id, model, disabled_at')
      .eq('user_id', atlas.agentId)
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({ owner_id: ownerId, model: 'custom', disabled_at: null });
    expect(parseAgentToken(atlas.token)?.agentId).toBe(atlas.agentId);
  });

  it('issues a token that signs in as exactly that agent', async () => {
    const { atlas } = fixtures();
    const { session, error } = await signIn(atlas.token);

    expect(error).toBeNull();
    expect(session?.user.id).toBe(atlas.agentId);
  });

  it('refuses a username that is taken, regardless of case', async () => {
    const { env, ownerId, atlas } = fixtures();
    await expect(createAgent(env, { ownerId, username: atlas.username.toUpperCase(), test: true }))
      .rejects.toThrow(/taken/);
  });

  it.each(['ab', 'has space', `zmcp_test_${'x'.repeat(30)}`, 'émile'])('refuses the username %j', async (username) => {
    const { env, ownerId } = fixtures();
    await expect(createAgent(env, { ownerId, username, test: true })).rejects.toThrow(AdminError);
  });

  it('rotation kills the old token and its live sessions immediately', async () => {
    const { env, ownerId, run } = fixtures();
    const agent = await createAgent(env, { ownerId, username: `zmcp_test_rot_${run}`, test: true });
    const before = await signIn(agent.token);
    expect(before.error).toBeNull();
    expect((await before.client.rpc('zona_agent_me')).status).toBe(200);

    const newToken = await rotateAgentToken(env, agent.agentId);

    expect((await before.client.rpc('zona_agent_me')).status).toBe(401);
    expect((await signIn(agent.token)).error?.code).toBe('invalid_credentials');
    const after = await signIn(newToken);
    expect(after.error).toBeNull();
    expect((await after.client.rpc('zona_agent_me')).data).toMatchObject({ userId: agent.agentId, isAgent: true });
  });

  it('a disabled agent can no longer sign in', async () => {
    const { env, ownerId, run } = fixtures();
    const agent = await createAgent(env, { ownerId, username: `zmcp_test_off_${run}`, test: true });

    await disableAgent(env, agent.agentId);

    expect((await signIn(agent.token)).error?.code).toBe('invalid_credentials');
    const { data } = await db().from('agents').select('disabled_at').eq('user_id', agent.agentId).single();
    expect(data?.disabled_at).not.toBeNull();
  });

  it('refuses to create a test owner outside the zmcp_test_ prefix', async () => {
    const { status, error } = await db().rpc('zona_admin_create_test_owner', {
      p_owner_id: '00000000-0000-4000-8000-000000000001',
      p_username: 'real_person',
      p_email: 'nobody@example.com',
    });
    expect(status).toBe(400);
    expect(error?.message).toMatch(/zmcp_test_/);
  });
});

describe('agents table RLS', () => {
  it('anon sees enabled agents only; a signed-in owner also sees their disabled ones', async () => {
    const { env, run } = fixtures();
    const owner = await createTestOwner(env, `zmcp_test_rls_${run}`);
    const live = await createAgent(env, { ownerId: owner.ownerId, username: `zmcp_test_rls_on_${run}`, test: true });
    const off = await createAgent(env, { ownerId: owner.ownerId, username: `zmcp_test_rls_off_${run}`, test: true });
    await disableAgent(env, off.agentId);
    const ids = [live.agentId, off.agentId];

    const anonRows = await publicClient().from('agents').select('user_id').in('user_id', ids);
    expect(anonRows.error).toBeNull();
    expect(anonRows.data).toEqual([{ user_id: live.agentId }]);

    const ownerClient = publicClient();
    const signedIn = await ownerClient.auth.signInWithPassword({ email: owner.email, password: owner.password });
    expect(signedIn.error).toBeNull();
    const ownerRows = await ownerClient.from('agents').select('user_id').in('user_id', ids);
    expect(ownerRows.data?.map((row) => row.user_id).sort()).toEqual([...ids].sort());
  });

  it("another signed-in account does not see someone else's disabled agent", async () => {
    const { env, ownerId, run, atlas } = fixtures();
    const off = await createAgent(env, { ownerId, username: `zmcp_test_rls_x_${run}`, test: true });
    await disableAgent(env, off.agentId);

    const { client, error } = await signIn(atlas.token); // atlas is an agent, not off's owner
    expect(error).toBeNull();
    const rows = await client.from('agents').select('user_id').eq('user_id', off.agentId);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([]);
  });

  it('a signed-in agent cannot write the agents table, not even its own row', async () => {
    const { atlas } = fixtures();
    const { client, error } = await signIn(atlas.token);
    expect(error).toBeNull();

    const update = await client.from('agents').update({ model: 'claude' }).eq('user_id', atlas.agentId);

    expect(update.error?.code).toBe('42501');
    expect(update.status).toBe(403);
    const { data } = await db().from('agents').select('model').eq('user_id', atlas.agentId).single();
    expect(data?.model).toBe('custom');
  });
});
