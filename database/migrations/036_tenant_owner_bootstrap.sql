-- Migration 036: Default tenant administrator at onboarding
--
-- An operator can give a new tenant its first administrator login (username +
-- initial password) while creating it, instead of only an emailed invitation.
--
-- The platform BFF hashes the password with argon2id before it reaches the
-- database; plaintext is never stored. The row is staged in the same
-- transaction as the tenant registry record, and the provisioning worker's
-- CREATE_TENANT_OWNER step creates the account inside the new tenant schema,
-- then clears the hash. Nothing else reads it.

begin;

create table if not exists platform.tenant_owner_bootstrap (
  tenant_id        uuid primary key references platform.tenant_registry(tenant_id) on delete cascade,
  username         text not null check (username ~ '^[a-z0-9._-]{3,64}$'),
  display_name     text not null check (length(btrim(display_name)) between 1 and 255),
  email_normalized text check (email_normalized is null or length(email_normalized) <= 320),
  password_hash    text check (password_hash is null or password_hash like '$argon2id$%'),
  requested_by     uuid references platform.platform_user(id) on delete set null,
  created_at       timestamptz not null default now(),
  applied_at       timestamptz,
  -- The hash exists exactly until the account has been created.
  constraint tenant_owner_bootstrap_hash_lifecycle check ((applied_at is null) = (password_hash is not null))
);

alter table platform.tenant_owner_bootstrap owner to platform_owner;
revoke all on platform.tenant_owner_bootstrap from public;
-- The BFF may show status but never reads the hash.
grant select (tenant_id, username, display_name, email_normalized, created_at, applied_at)
  on platform.tenant_owner_bootstrap to platform_bff_runtime;
grant select, update on platform.tenant_owner_bootstrap to tenant_provisioner;

create or replace function platform.stage_tenant_owner_bootstrap(
  p_tenant_key text,
  p_username text,
  p_display_name text,
  p_email text,
  p_password_hash text,
  p_actor_user_id uuid
) returns void
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
begin
  if p_password_hash is null or p_password_hash not like '$argon2id$%' then
    raise exception 'Initial password must be an argon2id hash.' using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id
    from tenant_registry
   where tenant_key = p_tenant_key and lifecycle_status = 'provisioning'
   for update;
  if not found then
    raise exception 'A default administrator can only be set while the tenant is provisioning.' using errcode = '55000';
  end if;

  insert into tenant_owner_bootstrap (tenant_id, username, display_name, email_normalized, password_hash, requested_by)
  values (v_tenant_id, lower(btrim(p_username)), btrim(p_display_name), nullif(lower(btrim(p_email)), ''), p_password_hash, p_actor_user_id);

  insert into platform_audit (
    user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
  ) values (
    p_actor_user_id, v_tenant_id, 'tenant_onboarding', 'owner_account_staged', 'SUCCESS',
    'tenant_owner_bootstrap', lower(btrim(p_username)), 'allow'
  );
end
$$;

alter function platform.stage_tenant_owner_bootstrap(text, text, text, text, text, uuid) owner to platform_owner;
revoke all on function platform.stage_tenant_owner_bootstrap(text, text, text, text, text, uuid) from public;
grant execute on function platform.stage_tenant_owner_bootstrap(text, text, text, text, text, uuid) to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('036_tenant_owner_bootstrap:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
