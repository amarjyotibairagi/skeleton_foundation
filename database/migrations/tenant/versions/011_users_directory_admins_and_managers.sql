-- The user directory is for administrators and managers. Regular users
-- (tenant_member) no longer read the list of all users; viewers never could.

delete from role_permission
 where role_id in (select role_id from role_definition where role_code in ('tenant_member', 'user'))
   and permission_id in (select permission_id from permission where permission_code = 'tenant.users.read');
