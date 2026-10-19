-- Migration 037: Operators change their own password
--
-- The platform BFF verifies the current password and hashes the new one with
-- argon2id in Node; only hashes reach the database. The update is a
-- compare-and-swap on the hash the BFF verified, so a concurrent change
-- cannot be overwritten. Every other session of the operator is ended; the
-- session that made the change stays signed in.

begin;

create or replace function platform.change_platform_operator_password(
  p_user_id uuid,
  p_session_id uuid,
  p_verified_hash text,
  p_new_hash text
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_revoked integer;
begin
  if p_new_hash is null or p_new_hash !~ '^\$argon2id\$' then
    raise exception 'Password hash must be argon2id.' using errcode = '22023';
  end if;

  update platform_user
     set password_hash = p_new_hash, updated_at = now()
   where id = p_user_id and is_active and password_hash = p_verified_hash;
  if not found then return false; end if;

  delete from platform_session where user_id = p_user_id and id <> p_session_id;
  get diagnostics v_revoked = row_count;

  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_user_id, 'platform_operators', 'operator_password_changed', 'SUCCESS', 'platform_user', p_user_id::text, 'allow');
  return true;
end
$$;

alter function platform.change_platform_operator_password(uuid, uuid, text, text) owner to platform_owner;
revoke all on function platform.change_platform_operator_password(uuid, uuid, text, text) from public;
grant execute on function platform.change_platform_operator_password(uuid, uuid, text, text) to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('037_platform_operator_password_change:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
