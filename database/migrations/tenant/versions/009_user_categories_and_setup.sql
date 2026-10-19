-- User categories and guided workspace setup.
--
-- Categories are configured by tenant administrators (e.g. "Engineer",
-- "Supervisor") and classify users within the two primary kinds,
-- administrator and user. A user has at most one category; deleting a
-- category leaves its users uncategorised.
--
-- setup_completed_at records that an administrator finished or dismissed the
-- first-login setup. Workspaces that already have more than one account are
-- treated as set up, so only a fresh workspace's first administrator (and
-- administrators added later) see it.

create table user_category (
  category_id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 300),
  created_by uuid references user_account(user_id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index user_category_name_uidx on user_category (lower(name));
create index user_category_creator_idx on user_category (created_by);

-- A separate assignment table (not a column on user_account) keeps the
-- foreign-key graph acyclic, which tenant data relocation relies on.
create table user_category_member (
  user_id uuid primary key references user_account(user_id) on delete cascade,
  category_id uuid not null references user_category(category_id) on delete cascade,
  assigned_at timestamptz not null default now()
);
create index user_category_member_category_idx on user_category_member (category_id);

alter table user_account add column setup_completed_at timestamptz;

update user_account set setup_completed_at = now()
 where (select count(*) from user_account) > 1;
