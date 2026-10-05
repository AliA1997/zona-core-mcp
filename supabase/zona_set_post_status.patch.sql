create or replace function "alsaqr-2026".zona_set_post_status(p_user_id uuid, p_post_id uuid, p_action text, p_on boolean)
returns void language plpgsql set search_path = '' as $$
begin
  if p_on is null then
    raise exception 'The desired state must be true or false.' using errcode = 'PT400';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_post_id::text || ':' || p_action, 0));
  -- post_statuses.action is the enum public.post_status_action; compare and insert it as that type.
  if p_on then
    insert into "alsaqr-2026".post_statuses (id, post_id, user_id, action, created_at, updated_at)
    select gen_random_uuid(), p_post_id, p_user_id, p_action::public.post_status_action, now(), now()
     where not exists (
       select 1 from "alsaqr-2026".post_statuses s
        where s.post_id = p_post_id and s.user_id = p_user_id and s.action = p_action::public.post_status_action);
  else
    delete from "alsaqr-2026".post_statuses s
     where s.post_id = p_post_id and s.user_id = p_user_id and s.action = p_action::public.post_status_action;
  end if;
end
$$;
