-- Departments and groups (core teams module, /api/v1/teams).
--
-- A team is either a department (organisational unit) or a group (working
-- group). Administrators manage every team; managers manage the teams they
-- created, with users and viewers as members, which needs tenant.users.roles.
-- Modules grant access to teams (for example "members of this group may open
-- this project") with their own tables referencing team(team_id).

alter table team add column if not exists group_kind text not null default 'group'
  check (group_kind in ('group', 'department'));

insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
  from role_definition r cross join permission p
 where r.role_code = 'tenant_manager' and p.permission_code = 'tenant.users.roles'
on conflict do nothing;
