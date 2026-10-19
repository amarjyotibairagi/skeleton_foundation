-- Migration 039: Removing a tenant releases its subdomain
--
-- tenant_domain kept unconditional unique indexes on hostname and subdomain,
-- so a removed tenant's subdomain stayed reserved forever and could never be
-- provisioned again (the registry's own indexes already exclude deleted
-- tenants). A domain row is now marked 'released' when its tenant's removal
-- finishes; released rows stay as history but no longer reserve the name.

begin;

alter table platform.tenant_domain drop constraint tenant_domain_status_check;
alter table platform.tenant_domain add constraint tenant_domain_status_check
  check (status in ('pending', 'active', 'disabled', 'failed', 'released'));

update platform.tenant_domain d
   set status = 'released'
  from platform.tenant_registry t
 where t.tenant_id = d.tenant_id and t.lifecycle_status = 'deleted' and d.status <> 'released';

drop index platform.tenant_domain_hostname_uidx;
drop index platform.tenant_domain_subdomain_uidx;
create unique index tenant_domain_hostname_uidx on platform.tenant_domain (lower(hostname)) where status <> 'released';
create unique index tenant_domain_subdomain_uidx on platform.tenant_domain (lower(subdomain)) where status <> 'released';

insert into platform.schema_migration (migration_key, migration_scope)
values ('039_release_removed_tenant_subdomains:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
