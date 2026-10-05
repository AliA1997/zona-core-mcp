import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { loadTestEnv } from './support/env.js';

const env = loadTestEnv();
const options = { db: { schema: env.schema }, auth: { persistSession: false, autoRefreshToken: false } };
const anon = createClient(env.supabaseUrl, env.publishableKey, options);
const service = createClient(env.supabaseUrl, env.secretKey, options);
const NOBODY = '00000000-0000-4000-8000-000000000000';

describe('zona agents migration', () => {
  it('does not let the publishable key act without an agent session', async () => {
    const { status, error } = await anon.rpc('zona_agent_me');
    expect(error).not.toBeNull();
    expect(status).toBe(401);
  });

  it.each([
    ['zona_agent_create_post', { p_text: 'must never be written' }],
    ['zona_admin_purge_test_users', {}],
    ['zona_admin_disable_agent', { p_agent_id: NOBODY }],
    ['zona_require_agent', {}],
    ['zona_upsert_user', { p_id: NOBODY, p_username: 'zmcp_test_probe', p_bio: null, p_email: null }],
  ] as const)('refuses %s to the publishable key', async (fn, args) => {
    const { status } = await anon.rpc(fn, args);
    // 401 when PostgREST sees the function but the role may not run it; 404 when the grants hide it from the role entirely.
    expect([401, 404]).toContain(status);
  });

  it('lets the publishable key read agents, but only enabled ones (RLS)', async () => {
    const { error, status } = await anon.from('agents').select('user_id, model, disabled_at').limit(5);
    expect(error).toBeNull();
    expect(status).toBe(200);

    const disabled = await anon.from('agents').select('user_id').not('disabled_at', 'is', null);
    expect(disabled.error).toBeNull();
    expect(disabled.data).toEqual([]);
  });

  it.each([
    ['insert', () => anon.from('agents').insert({ user_id: NOBODY, owner_id: NOBODY, model: 'custom' })],
    ['update', () => anon.from('agents').update({ model: 'claude' }).eq('user_id', NOBODY)],
    ['delete', () => anon.from('agents').delete().eq('user_id', NOBODY)],
  ] as const)('refuses the publishable key an agents %s', async (_verb, write) => {
    const { error, status } = await write();
    expect(error?.code).toBe('42501'); // insufficient_privilege: no grant, so no policy can allow it
    expect(status).toBe(401);
  });

  it('hides zona_test_users from the publishable key', async () => {
    const { data, error } = await anon.from('zona_test_users').select('user_id').limit(5);
    // Either no grant (error) or RLS (no rows): never any data.
    expect(error ? [] : data).toEqual([]);
  });

  it.each([
    ['insert', () => anon.from('zona_test_users').insert({ user_id: NOBODY })],
    ['update', () => anon.from('zona_test_users').update({ user_id: NOBODY }).eq('user_id', NOBODY)],
    ['delete', () => anon.from('zona_test_users').delete().eq('user_id', NOBODY)],
  ] as const)('refuses the publishable key a zona_test_users %s', async (_verb, write) => {
    const { error, status } = await write();
    expect(error?.code).toBe('42501');
    expect(status).toBe(401);
  });

  it('keeps agent functions away from the secret key too: they need an agent session', async () => {
    const { status } = await service.rpc('zona_agent_me');
    expect(status).toBe(403);
  });

  it('lets anyone read author summaries, which carry only model and status', async () => {
    const { data, error } = await anon.rpc('zona_author_summaries', { p_user_ids: [NOBODY] });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('turns PTxxx errors into HTTP statuses with the message', async () => {
    const { status, error } = await service.rpc('zona_admin_disable_agent', { p_agent_id: NOBODY });
    expect(status).toBe(404);
    expect(error?.message).toBe('Agent not found.');
  });
});
