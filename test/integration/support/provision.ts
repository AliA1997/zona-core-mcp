import { randomUUID } from 'node:crypto';
import { adminClient } from '../../../src/admin/agents.js';
import { newAgentSecret } from '../../../src/agent-token.js';
import type { TestEnv } from './env.js';

export type TestOwner = { ownerId: string; email: string; password: string };

/**
 * A human-like owner that can sign in (to exercise the owner RLS policy).
 * Only zmcp_test_ usernames are accepted, which SQL enforces.
 */
export async function createTestOwner(env: TestEnv, username: string): Promise<TestOwner> {
  const admin = adminClient(env);
  const id = randomUUID();
  const email = `${id.replaceAll('-', '')}@owners.zmcp-test.alsaqr.app`;
  const password = newAgentSecret();
  const { error } = await admin.auth.admin.createUser({
    id,
    email,
    password,
    email_confirm: true,
    app_metadata: { zona_test: true },
  });
  if (error) throw new Error(`create test owner (auth): ${error.message}`);
  const { error: rpcError } = await admin.rpc('zona_admin_create_test_owner', {
    p_owner_id: id,
    p_username: username,
    p_email: email,
  });
  if (rpcError) throw new Error(`create test owner (users): ${rpcError.message}`);
  return { ownerId: id, email, password };
}

type Admin = ReturnType<typeof adminClient>;

async function must<T>(what: string, result: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await result;
  if (error) throw new Error(`purge test rows (${what}): ${error.message}`);
  return data ?? [];
}

/**
 * Deletes the rows of test users, using the secret key and no database function. A user is
 * deleted only if it is in zona_test_users AND its username starts with zmcp_test_, so a real
 * account can never match. Returns the deleted user ids.
 */
async function purgeTestRows(admin: Admin): Promise<string[]> {
  const marked = await must<{ user_id: string }>('markers', admin.from('zona_test_users').select('user_id'));
  const candidates = marked.map((row) => row.user_id);
  if (candidates.length === 0) return [];
  const users = await must<{ id: string }>(
    'users',
    admin.from('users').select('id').in('id', candidates).like('username', 'zmcp\_test\_%'),
  );
  const ids = users.map((row) => row.id);
  if (ids.length === 0) return [];
  const list = `(${ids.join(',')})`;

  // Test posts, plus comments on them at any depth (anyone's); nothing else is ever collected.
  const posts = new Set((await must<{ id: string }>('posts', admin.from('posts').select('id').in('user_id', ids))).map((r) => r.id));
  let frontier = [...posts];
  while (frontier.length > 0) {
    const comments = await must<{ id: string }>(
      'comments',
      admin.from('posts').select('id').eq('post_type', 'comment').in('related_post_id', frontier),
    );
    frontier = comments.map((r) => r.id).filter((id) => !posts.has(id));
    for (const id of frontier) posts.add(id);
  }
  const postIds = [...posts];
  const postList = `(${postIds.join(',')})`;

  const items = [
    ...(await must<{ id: string }>('list items', admin.from('list_items').select('id').in('user_id', ids))),
    ...(postIds.length ? await must<{ id: string }>('list items', admin.from('list_items').select('id').in('post_id', postIds)) : []),
  ].map((r) => r.id);

  const del = async (what: string, query: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await query;
    if (error) throw new Error(`purge test rows (${what}): ${error.message}`);
  };
  const userOr = (...columns: string[]) => columns.map((c) => `${c}.in.${list}`).join(',');
  const postOr = (column: string) => (postIds.length ? `,${column}.in.${postList}` : '');

  await del('notifications', admin.from('notifications').delete().or(userOr('user_id', 'related_user_id') + postOr('post_id')));
  if (items.length) await del('notifications', admin.from('notifications').delete().in('list_item_id', items));
  await del('list items', admin.from('list_items').delete().or(userOr('user_id') + postOr('post_id')));
  await del('post statuses', admin.from('post_statuses').delete().or(userOr('user_id') + postOr('post_id')));
  if (postIds.length) {
    await del('comments', admin.from('posts').delete().in('id', postIds).eq('post_type', 'comment'));
    await del('posts', admin.from('posts').delete().in('id', postIds));
  }
  await del('messages', admin.from('messages').delete().or(userOr('sender_id', 'recipient_id')));
  await del('follows', admin.from('user_follows').delete().or(userOr('follower_id', 'following_id')));
  await del('agents', admin.from('agents').delete().or(userOr('user_id', 'owner_id')));
  await del('users', admin.from('users').delete().in('id', ids));
  return ids;
}

/** Deletes every zmcp_test_ row and every auth user tagged zona_test. Safe to run any time. */
export async function purgeTestUsers(env: TestEnv): Promise<number> {
  const admin = adminClient(env);
  const authIds = new Set<string>(await purgeTestRows(admin));
  for (let page = 1; ; page++) {
    const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (listError) throw new Error(`list auth users: ${listError.message}`);
    for (const user of listed.users) if (user.app_metadata?.zona_test === true) authIds.add(user.id);
    if (listed.users.length < 1000) break;
  }
  for (const id of authIds) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(id);
    if (deleteError && deleteError.status !== 404) throw new Error(`delete auth user: ${deleteError.message}`);
  }
  return authIds.size;
}

export async function countTestUsers(env: TestEnv): Promise<number> {
  const { count, error } = await adminClient(env)
    .from('users')
    .select('id', { count: 'exact', head: true })
    .like('username', 'zmcp\_test\_%');
  if (error) throw new Error(`count test users: ${error.message}`);
  return count ?? 0;
}
