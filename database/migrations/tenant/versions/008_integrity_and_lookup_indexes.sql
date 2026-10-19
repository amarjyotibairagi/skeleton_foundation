-- Lookup indexes for the foreign keys that sign-in, session cleanup and team
-- membership changes follow.
create index if not exists tenant_session_user_idx on user_session (user_id);
create index if not exists tenant_identity_user_idx on user_identity (user_id);
create index if not exists tenant_team_membership_user_idx on team_membership (user_id);
