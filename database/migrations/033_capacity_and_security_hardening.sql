-- Forward-only replacement for the local edit to applied migration 027.
-- Preserve the requested eight-character invitation password minimum and
-- explicitly cap the file service's bounded in-memory upload implementation.
begin;
set local lock_timeout = '5s';
update platform.config_definition
   set default_value = '8'::jsonb, min_value = 8
 where config_key = 'auth.password.min_length';
update platform.config_definition
   set max_value = 64,
       description = 'Largest single file accepted by the buffered file service (maximum 64 MB).'
 where config_key = 'limit.storage.max_file_mb';

-- Targeted lookup/cascade indexes, rather than indexing every small FK table.
create index if not exists consumer_session_user_idx on consumer.user_session (user_id);
create index if not exists consumer_identity_user_idx on consumer.user_identity (user_id);
create index if not exists consumer_project_owner_idx on consumer.workspace_project (owner_user_id);
create index if not exists consumer_membership_user_idx on consumer.group_membership (user_id);

-- Profiling is enabled by the production capacity profile. Creating the
-- extension is safe in test clusters without preloading; queries against its
-- statistics are used only where preloading is enabled.
create extension if not exists pg_stat_statements;

insert into platform.schema_migration (migration_key, migration_scope)
values ('033_capacity_and_security_hardening:v1', 'platform')
on conflict (migration_key) do nothing;
commit;
