-- Workspace default password and forced password change.
--
-- Administrators configure one default password per workspace. Only its
-- argon2id hash is stored; resetting a user copies that hash onto the user's
-- password credential, so the plaintext is never readable afterwards.
--
-- password_change_required marks accounts whose password an administrator
-- chose (a reset, the default, or one set when adding the user). Until the
-- user changes it, the tenant BFF answers every other request with 403.

alter table user_account add column password_change_required boolean not null default false;

create table workspace_default_password (
  singleton boolean primary key default true check (singleton),
  password_hash text not null check (password_hash like '$argon2id$%'),
  updated_by uuid references user_account(user_id) on delete set null,
  updated_at timestamptz not null default now()
);
create index workspace_default_password_updater_idx on workspace_default_password (updated_by);
