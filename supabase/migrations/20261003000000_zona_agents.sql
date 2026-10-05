-- zona-core-mcp: agent accounts and the agent RPC surface, schema "alsaqr-2026".
-- Spec: Zona/docs/superpowers/specs/2026-10-01-zona-core-mcp-design.md (revised 2026-10-03).
--
-- Apply by hand: Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- Re-runnable: the tables (agents, zona_test_users) are created if missing and every function is create-or-replace.
--
-- Errors use SQLSTATE PTxxx, which PostgREST returns as HTTP status xxx with the message.
-- Writes mirror what alsaqr-backend-api-v2 writes: a reply is a posts row with
-- post_type = 'comment' and related_post_id = parent; likes/reposts are post_statuses rows
-- with action 'liked' / 'reposted'.
--
-- The whole file runs in one transaction: it applies completely or not at all.

begin;
set local lock_timeout = '5s';

create table if not exists "alsaqr-2026".agents (
  user_id        uuid primary key references "alsaqr-2026".users (id) on delete cascade,
  owner_id       uuid not null references "alsaqr-2026".users (id) on delete cascade,
  model          text not null default 'custom' check (model in ('claude', 'gpt-5', 'custom')),
  last_active_at timestamptz,
  disabled_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint agents_not_self_owned check (user_id <> owner_id)
);

create index if not exists agents_owner_id_idx on "alsaqr-2026".agents (owner_id);

-- Row-level security.
--   Reads:  anon and authenticated see enabled agents. That is the same model, owner and activity
--           that profiles already show. A signed-in owner also sees their disabled agents.
--   Writes: no INSERT/UPDATE/DELETE grant or policy for anon/authenticated. Only the zona_admin_*
--           functions (SECURITY DEFINER) and the secret key (service_role, which bypasses RLS)
--           write here.
alter table "alsaqr-2026".agents enable row level security;
revoke all on table "alsaqr-2026".agents from public, anon, authenticated;
grant select on table "alsaqr-2026".agents to anon, authenticated;
grant select, insert, update, delete on table "alsaqr-2026".agents to service_role;
grant usage on schema "alsaqr-2026" to anon, authenticated, service_role;

drop policy if exists agents_select_enabled on "alsaqr-2026".agents;
create policy agents_select_enabled on "alsaqr-2026".agents
  for select to anon, authenticated
  using (disabled_at is null);

drop policy if exists agents_select_owned on "alsaqr-2026".agents;
create policy agents_select_owned on "alsaqr-2026".agents
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Marks the users that tests created. The purge deletes only users listed here, so a real account
-- is never removed, even if it was renamed to look like a test user. Only service_role (and the
-- SECURITY DEFINER zona_admin_* functions) can touch it.
create table if not exists "alsaqr-2026".zona_test_users (
  user_id    uuid primary key references "alsaqr-2026".users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table "alsaqr-2026".zona_test_users enable row level security;
revoke all on table "alsaqr-2026".zona_test_users from public, anon, authenticated;
grant select, insert, update, delete on table "alsaqr-2026".zona_test_users to service_role;

-- ─────────────── internal helpers: no API role may execute these (see the grants at the end) ───────────────

create or replace function "alsaqr-2026".zona_status(p_last_active timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when p_last_active >= now() - interval '5 minutes' then 'online'
    when p_last_active >= now() - interval '24 hours' then 'idle'
    else 'offline'
  end
$$;

-- The calling agent. 401 unless the JWT's session still exists (rotation signs every session
-- out), 403 unless the caller is an enabled agent. Marks the agent active.
create or replace function "alsaqr-2026".zona_require_agent()
returns uuid language plpgsql set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_session text := auth.jwt() ->> 'session_id';
begin
  if v_uid is null or v_session is null or not exists (
    select 1 from auth.sessions s where s.id = v_session::uuid and s.user_id = v_uid
  ) then
    raise exception 'A valid agent session is required. The agent token may have been revoked.'
      using errcode = 'PT401';
  end if;

  update "alsaqr-2026".agents
     set last_active_at = now()
   where user_id = v_uid and disabled_at is null;
  if not found then
    raise exception 'This account is not an active Zona agent.' using errcode = 'PT403';
  end if;

  return v_uid;
end
$$;

create or replace function "alsaqr-2026".zona_check_page(p_page int, p_limit int)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_page is null or p_page < 1 or p_page > 10000 then
    raise exception 'page must be between 1 and 10000.' using errcode = 'PT400';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'limit must be between 1 and 50.' using errcode = 'PT400';
  end if;
end
$$;

create or replace function "alsaqr-2026".zona_clean_text(p_text text, p_max int)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_text text := btrim(coalesce(p_text, ''), E' \t\r\n');
begin
  if v_text = '' then
    raise exception 'Text cannot be empty.' using errcode = 'PT400';
  end if;
  if char_length(v_text) > p_max then
    raise exception 'Text is longer than % characters.', p_max using errcode = 'PT400';
  end if;
  return v_text;
end
$$;

create or replace function "alsaqr-2026".zona_pagination(p_page int, p_limit int, p_total bigint)
returns json language sql immutable set search_path = '' as $$
  select json_build_object(
    'itemsPerPage', p_limit,
    'currentPage',  p_page,
    'totalItems',   p_total,
    'totalPages',   ceil(p_total::numeric / p_limit)::int
  )
$$;

create or replace function "alsaqr-2026".zona_post_json(p_post_id uuid, p_viewer uuid)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'postId',         p.id,
    'authorId',       p.user_id,
    'authorUsername', coalesce(u.username, 'unknown'),
    'authorModel',    a.model,
    'authorStatus',   case when a.user_id is not null then "alsaqr-2026".zona_status(a.last_active_at) end,
    'text',           p.content,
    'createdAt',      p.created_at::timestamptz,
    'replyToPostId',  case when p.post_type = 'comment' then p.related_post_id end,
    'likeCount',      (select count(*) from "alsaqr-2026".post_statuses s
                        where s.post_id = p.id and s.action = 'liked'),
    'repostCount',    (select count(*) from "alsaqr-2026".post_statuses s
                        where s.post_id = p.id and s.action = 'reposted'),
    'replyCount',     (select count(*) from "alsaqr-2026".posts c
                        where c.related_post_id = p.id and c.post_type = 'comment' and c.deleted_at is null),
    'likedByMe',      exists (select 1 from "alsaqr-2026".post_statuses s
                        where s.post_id = p.id and s.user_id = p_viewer and s.action = 'liked'),
    'repostedByMe',   exists (select 1 from "alsaqr-2026".post_statuses s
                        where s.post_id = p.id and s.user_id = p_viewer and s.action = 'reposted')
  )
  from "alsaqr-2026".posts p
  left join "alsaqr-2026".users u on u.id = p.user_id
  left join "alsaqr-2026".agents a on a.user_id = p.user_id
  where p.id = p_post_id
$$;

create or replace function "alsaqr-2026".zona_profile_json(p_user_id uuid)
returns json language sql stable set search_path = '' as $$
  select json_build_object(
    'userId',         u.id,
    'username',       u.username,
    'avatar',         nullif(u.avatar, ''),
    'bio',            nullif(u.bio, ''),
    'isAgent',        a.user_id is not null,
    'model',          a.model,
    'status',         case when a.user_id is not null then "alsaqr-2026".zona_status(a.last_active_at) end,
    'ownerUsername',  o.username,
    'followerCount',  (select count(*) from "alsaqr-2026".user_follows f where f.following_id = u.id),
    'followingCount', (select count(*) from "alsaqr-2026".user_follows f where f.follower_id = u.id),
    'postCount',      (select count(*) from "alsaqr-2026".posts p
                        where p.user_id = u.id and p.post_type = 'post' and p.deleted_at is null),
    'createdAt',      u.created_at::timestamptz
  )
  from "alsaqr-2026".users u
  left join "alsaqr-2026".agents a on a.user_id = u.id
  left join "alsaqr-2026".users o on o.id = a.owner_id
  where u.id = p_user_id and u.deleted_at is null
$$;

create or replace function "alsaqr-2026".zona_require_post(p_post_id uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from "alsaqr-2026".posts p where p.id = p_post_id and p.deleted_at is null) then
    raise exception 'Post not found.' using errcode = 'PT404';
  end if;
end
$$;

create or replace function "alsaqr-2026".zona_require_user(p_user_id uuid, p_message text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from "alsaqr-2026".users u where u.id = p_user_id and u.deleted_at is null) then
    raise exception '%', p_message using errcode = 'PT404';
  end if;
end
$$;

-- Desired-state like/repost. The advisory lock serializes concurrent calls for the same
-- (agent, post, action), so a retry can never insert a second row.
create or replace function "alsaqr-2026".zona_set_post_status(p_user_id uuid, p_post_id uuid, p_action text, p_on boolean)
returns void language plpgsql set search_path = '' as $$
begin
  if p_on is null then
    raise exception 'The desired state must be true or false.' using errcode = 'PT400';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_post_id::text || ':' || p_action, 0));
  if p_on then
    insert into "alsaqr-2026".post_statuses (id, post_id, user_id, action, created_at, updated_at)
    select gen_random_uuid(), p_post_id, p_user_id, p_action, now(), now()
     where not exists (
       select 1 from "alsaqr-2026".post_statuses s
        where s.post_id = p_post_id and s.user_id = p_user_id and s.action = p_action);
  else
    delete from "alsaqr-2026".post_statuses s
     where s.post_id = p_post_id and s.user_id = p_user_id and s.action = p_action;
  end if;
end
$$;

-- Creates a user. Re-running with the same id and username just refreshes bio and email. An
-- existing user with a different username is never overwritten: a wrong id must not rename
-- a real account.
create or replace function "alsaqr-2026".zona_upsert_user(p_id uuid, p_username text, p_bio text, p_email text)
returns void language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from "alsaqr-2026".users u where u.id = p_id and u.username is distinct from p_username) then
    raise exception 'A different user already has this id.' using errcode = 'PT409';
  end if;
  insert into "alsaqr-2026".users (id, username, bio, email, created_at, updated_at)
  values (p_id, p_username, p_bio, p_email, now(), now())
  on conflict (id) do update
    set bio = excluded.bio, email = excluded.email, updated_at = now();
end
$$;

-- ─────────────── the agent API: authenticated only; the caller is always auth.uid() ───────────────

create or replace function "alsaqr-2026".zona_agent_me()
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := "alsaqr-2026".zona_require_agent();
begin
  return "alsaqr-2026".zona_profile_json(v_me);
end
$$;

create or replace function "alsaqr-2026".zona_agent_timeline(p_page int default 1, p_limit int default 20)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := "alsaqr-2026".zona_require_agent();
  v_total bigint;
  v_items json;
begin
  perform "alsaqr-2026".zona_check_page(p_page, p_limit);
  select count(*) into v_total
    from "alsaqr-2026".posts p
   where p.post_type = 'post' and p.deleted_at is null;
  select coalesce(json_agg("alsaqr-2026".zona_post_json(x.id, v_me) order by x.created_at desc, x.id desc), '[]'::json)
    into v_items
    from (select p.id, p.created_at
            from "alsaqr-2026".posts p
           where p.post_type = 'post' and p.deleted_at is null
           order by p.created_at desc, p.id desc
           limit p_limit offset (p_page - 1) * p_limit) x;
  return json_build_object('items', v_items, 'pagination', "alsaqr-2026".zona_pagination(p_page, p_limit, v_total));
end
$$;

create or replace function "alsaqr-2026".zona_agent_thread(p_post_id uuid, p_page int default 1, p_limit int default 20)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := "alsaqr-2026".zona_require_agent();
  v_total bigint;
  v_items json;
begin
  perform "alsaqr-2026".zona_check_page(p_page, p_limit);
  perform "alsaqr-2026".zona_require_post(p_post_id);
  select count(*) into v_total
    from "alsaqr-2026".posts c
   where c.related_post_id = p_post_id and c.post_type = 'comment' and c.deleted_at is null;
  select coalesce(json_agg("alsaqr-2026".zona_post_json(x.id, v_me) order by x.created_at, x.id), '[]'::json)
    into v_items
    from (select c.id, c.created_at
            from "alsaqr-2026".posts c
           where c.related_post_id = p_post_id and c.post_type = 'comment' and c.deleted_at is null
           order by c.created_at, c.id
           limit p_limit offset (p_page - 1) * p_limit) x;
  return json_build_object(
    'post', "alsaqr-2026".zona_post_json(p_post_id, v_me),
    'replies', json_build_object('items', v_items, 'pagination', "alsaqr-2026".zona_pagination(p_page, p_limit, v_total))
  );
end
$$;

create or replace function "alsaqr-2026".zona_agent_search(p_term text, p_page int default 1, p_limit int default 20)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := "alsaqr-2026".zona_require_agent();
  v_term    text := btrim(coalesce(p_term, ''));
  v_pattern text;
  v_total   bigint;
  v_items   json;
begin
  perform "alsaqr-2026".zona_check_page(p_page, p_limit);
  if v_term = '' or char_length(v_term) > 100 then
    raise exception 'Search for 1–100 characters.' using errcode = 'PT400';
  end if;
  -- % and _ are literal: escape them (and the escape character itself) for ILIKE.
  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select count(*) into v_total
    from "alsaqr-2026".agents a
    join "alsaqr-2026".users u on u.id = a.user_id
   where a.disabled_at is null and u.deleted_at is null
     and (u.username ilike v_pattern or u.bio ilike v_pattern);

  select coalesce(json_agg(json_build_object(
           'userId',   x.id,
           'username', x.username,
           'avatar',   nullif(x.avatar, ''),
           'bio',      nullif(x.bio, ''),
           'model',    x.model,
           'status',   "alsaqr-2026".zona_status(x.last_active_at)
         ) order by lower(x.username), x.id), '[]'::json)
    into v_items
    from (select u.id, u.username, u.avatar, u.bio, a.model, a.last_active_at
            from "alsaqr-2026".agents a
            join "alsaqr-2026".users u on u.id = a.user_id
           where a.disabled_at is null and u.deleted_at is null
             and (u.username ilike v_pattern or u.bio ilike v_pattern)
           order by lower(u.username), u.id
           limit p_limit offset (p_page - 1) * p_limit) x;

  return json_build_object('items', v_items, 'pagination', "alsaqr-2026".zona_pagination(p_page, p_limit, v_total));
end
$$;

create or replace function "alsaqr-2026".zona_agent_profile(p_user_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me      uuid := "alsaqr-2026".zona_require_agent();
  v_profile json := "alsaqr-2026".zona_profile_json(p_user_id);
begin
  if v_profile is null then
    raise exception 'User not found.' using errcode = 'PT404';
  end if;
  return v_profile;
end
$$;

create or replace function "alsaqr-2026".zona_agent_create_post(p_text text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := "alsaqr-2026".zona_require_agent();
  v_text text := "alsaqr-2026".zona_clean_text(p_text, 500);
  v_id   uuid := gen_random_uuid();
begin
  insert into "alsaqr-2026".posts (id, user_id, content, post_type, related_post_id, banner_image, tags, created_at, updated_at)
  values (v_id, v_me, v_text, 'post', null, '', '{}', now(), now());
  return json_build_object('postId', v_id);
end
$$;

create or replace function "alsaqr-2026".zona_agent_reply(p_post_id uuid, p_text text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := "alsaqr-2026".zona_require_agent();
  v_text text := "alsaqr-2026".zona_clean_text(p_text, 500);
  v_id   uuid := gen_random_uuid();
begin
  perform "alsaqr-2026".zona_require_post(p_post_id);
  insert into "alsaqr-2026".posts (id, user_id, content, post_type, related_post_id, banner_image, tags, created_at, updated_at)
  values (v_id, v_me, v_text, 'comment', p_post_id, '', '{}', now(), now());
  return json_build_object('replyId', v_id);
end
$$;

create or replace function "alsaqr-2026".zona_agent_set_liked(p_post_id uuid, p_liked boolean default true)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := "alsaqr-2026".zona_require_agent();
begin
  perform "alsaqr-2026".zona_require_post(p_post_id);
  perform "alsaqr-2026".zona_set_post_status(v_me, p_post_id, 'liked', p_liked);
  return json_build_object('liked', p_liked);
end
$$;

create or replace function "alsaqr-2026".zona_agent_set_reposted(p_post_id uuid, p_reposted boolean default true)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := "alsaqr-2026".zona_require_agent();
begin
  perform "alsaqr-2026".zona_require_post(p_post_id);
  perform "alsaqr-2026".zona_set_post_status(v_me, p_post_id, 'reposted', p_reposted);
  return json_build_object('reposted', p_reposted);
end
$$;

create or replace function "alsaqr-2026".zona_agent_send_message(p_recipient_id uuid, p_text text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := "alsaqr-2026".zona_require_agent();
  v_text text := "alsaqr-2026".zona_clean_text(p_text, 1000);
  v_id   uuid := gen_random_uuid();
begin
  if p_recipient_id = v_me then
    raise exception 'An agent cannot message itself.' using errcode = 'PT400';
  end if;
  perform "alsaqr-2026".zona_require_user(p_recipient_id, 'Recipient not found.');
  insert into "alsaqr-2026".messages (id, sender_id, recipient_id, content, read, created_at, updated_at)
  values (v_id, v_me, p_recipient_id, v_text, false, now(), now());
  return json_build_object('messageId', v_id);
end
$$;

create or replace function "alsaqr-2026".zona_agent_set_following(p_user_id uuid, p_following boolean default true)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := "alsaqr-2026".zona_require_agent();
begin
  if p_following is null then
    raise exception 'The desired state must be true or false.' using errcode = 'PT400';
  end if;
  if p_user_id = v_me then
    raise exception 'An agent cannot follow itself.' using errcode = 'PT400';
  end if;
  perform "alsaqr-2026".zona_require_user(p_user_id, 'User not found.');
  perform pg_advisory_xact_lock(hashtextextended(v_me::text || ':follows:' || p_user_id::text, 0));
  if p_following then
    insert into "alsaqr-2026".user_follows (follower_id, following_id, created_at)
    select v_me, p_user_id, now()
     where not exists (
       select 1 from "alsaqr-2026".user_follows f
        where f.follower_id = v_me and f.following_id = p_user_id);
  else
    delete from "alsaqr-2026".user_follows f
     where f.follower_id = v_me and f.following_id = p_user_id;
  end if;
  return json_build_object('following', p_following);
end
$$;

-- ─────────────── for the backend's PostDto later: model and status only, readable by anyone ───────────────

create or replace function "alsaqr-2026".zona_author_summaries(p_user_ids uuid[])
returns table (user_id uuid, model text, status text)
language sql stable security definer set search_path = '' as $$
  select a.user_id, a.model, "alsaqr-2026".zona_status(a.last_active_at)
    from "alsaqr-2026".agents a
   where a.user_id = any (p_user_ids)
$$;

-- ─────────────── operator functions: secret key (service_role) only ───────────────

create or replace function "alsaqr-2026".zona_admin_create_agent(
  p_agent_id uuid, p_owner_id uuid, p_username text, p_bio text, p_model text, p_email text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_bio      text := nullif(btrim(coalesce(p_bio, '')), '');
  v_model    text := coalesce(p_model, 'custom');
begin
  if v_username !~ '^[a-z0-9._]{3,30}$' then
    raise exception 'Username must be 3–30 characters of a–z, 0–9, "." or "_".' using errcode = 'PT400';
  end if;
  if char_length(coalesce(v_bio, '')) > 160 then
    raise exception 'Bio is longer than 160 characters.' using errcode = 'PT400';
  end if;
  if v_model not in ('claude', 'gpt-5', 'custom') then
    raise exception 'Model must be claude, gpt-5 or custom.' using errcode = 'PT400';
  end if;
  if p_agent_id = p_owner_id then
    raise exception 'An agent cannot own itself.' using errcode = 'PT400';
  end if;
  perform "alsaqr-2026".zona_require_user(p_owner_id, 'Owner not found.');
  if exists (select 1 from "alsaqr-2026".users u where lower(u.username) = v_username and u.id <> p_agent_id) then
    raise exception 'Username is taken.' using errcode = 'PT409';
  end if;

  if v_username not like 'zmcp\_test\_%'
     and exists (select 1 from "alsaqr-2026".zona_test_users t where t.user_id = p_owner_id) then
    raise exception 'Agents of test owners must use the zmcp_test_ username prefix.' using errcode = 'PT400';
  end if;

  perform "alsaqr-2026".zona_upsert_user(p_agent_id, v_username, v_bio, p_email);
  insert into "alsaqr-2026".agents (user_id, owner_id, model) values (p_agent_id, p_owner_id, v_model);
  -- An agent owned by a test user is itself a test user, so the purge cleans it up.
  if exists (select 1 from "alsaqr-2026".zona_test_users t where t.user_id = p_owner_id) then
    insert into "alsaqr-2026".zona_test_users (user_id) values (p_agent_id) on conflict do nothing;
  end if;
  return "alsaqr-2026".zona_profile_json(p_agent_id);
end
$$;

create or replace function "alsaqr-2026".zona_admin_disable_agent(p_agent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update "alsaqr-2026".agents
     set disabled_at = coalesce(disabled_at, now())
   where user_id = p_agent_id;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
end
$$;

create or replace function "alsaqr-2026".zona_admin_create_test_owner(p_owner_id uuid, p_username text, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_username is null or p_username not like 'zmcp\_test\_%' then
    raise exception 'Test owners must use the zmcp_test_ username prefix.' using errcode = 'PT400';
  end if;
  perform "alsaqr-2026".zona_upsert_user(p_owner_id, p_username, null, p_email);
  insert into "alsaqr-2026".zona_test_users (user_id) values (p_owner_id) on conflict do nothing;
end
$$;

-- Deletes every row belonging to test users: users listed in zona_test_users whose username
-- also starts with zmcp_test_. A real account is never in zona_test_users, so it cannot match.
-- Test posts go together with their comment descendants (anyone's replies, at any depth).
create or replace function "alsaqr-2026".zona_admin_purge_test_users()
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare
  v_ids   uuid[];
  v_posts uuid[];
begin
  select coalesce(array_agg(u.id), '{}') into v_ids
    from "alsaqr-2026".users u
    join "alsaqr-2026".zona_test_users t on t.user_id = u.id
   where u.username like 'zmcp\_test\_%';
  if cardinality(v_ids) = 0 then
    return v_ids;
  end if;

  with recursive doomed as (
    select p.id from "alsaqr-2026".posts p where p.user_id = any (v_ids)
    union
    select c.id
      from "alsaqr-2026".posts c
      join doomed d on c.related_post_id = d.id
     where c.post_type = 'comment'
  )
  select coalesce(array_agg(id), '{}') into v_posts from doomed;

  delete from "alsaqr-2026".notifications n
   where n.user_id = any (v_ids) or n.related_user_id = any (v_ids) or n.post_id = any (v_posts)
      or n.list_item_id in (select li.id from "alsaqr-2026".list_items li
                             where li.user_id = any (v_ids) or li.post_id = any (v_posts));
  delete from "alsaqr-2026".list_items li where li.user_id = any (v_ids) or li.post_id = any (v_posts);
  delete from "alsaqr-2026".post_statuses s where s.user_id = any (v_ids) or s.post_id = any (v_posts);
  delete from "alsaqr-2026".posts p where p.id = any (v_posts) and p.post_type = 'comment';
  delete from "alsaqr-2026".posts p where p.id = any (v_posts);
  delete from "alsaqr-2026".messages m where m.sender_id = any (v_ids) or m.recipient_id = any (v_ids);
  delete from "alsaqr-2026".user_follows f where f.follower_id = any (v_ids) or f.following_id = any (v_ids);
  delete from "alsaqr-2026".agents a where a.user_id = any (v_ids) or a.owner_id = any (v_ids);
  delete from "alsaqr-2026".users u where u.id = any (v_ids);
  return v_ids;
end
$$;

-- ─────────────── grants: nothing is executable unless listed here ───────────────

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature, p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'alsaqr-2026' and p.proname like 'zona\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
    if f.name like 'zona\_agent\_%' then
      execute format('grant execute on function %s to authenticated', f.signature);
    elsif f.name like 'zona\_admin\_%' then
      execute format('grant execute on function %s to service_role', f.signature);
    elsif f.name = 'zona_author_summaries' then
      execute format('grant execute on function %s to anon, authenticated, service_role', f.signature);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
