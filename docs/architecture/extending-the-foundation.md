# Extending the foundation

This repository is a base layer. Product features ("application layers") are
added as **modules** that plug into the foundation without editing its
security code. This guide is the checklist for doing that, and describes the
control-plane pieces a module can rely on.

## What the foundation owns

| Concern | Where it lives | A module should |
| --- | --- | --- |
| Hostname → tenant resolution, per-tenant DB role, `search_path`, RLS context | `backend/tenant/src/tenant-context.ts`, `tenant-database.ts` | Use `kit.withTenant()` for every query. Never open connections. |
| Sessions, CSRF, permissions, audit | `backend/tenant/src/server.ts`, `audit.ts` | Call `kit.requireSession`, `kit.requirePermission`, `kit.requireCsrf`, `kit.audit`. |
| Features, limits, settings | `platform.config_definition` / `config_value` (migration 027) | Declare keys; read them through `kit.config()`. |
| Tenant schema and privileges | `database/migrations/tenant/versions/`, `access-manifest.json` | Add a numbered migration and declare every table in the manifest. |
| Files | `kit.files` (VDS disk or the tenant's own bucket) | Store and read files through `kit.files`; never write to disk or buckets directly. |
| Where data lives | VDS schema, or the tenant's own PostgreSQL (bring-your-own) | Nothing: `kit.withTenant()` connects to the right place. |
| Onboarding, invitations, operators, plans | Platform admin panel + migrations 026/027 | Nothing — this is shared infrastructure. |

## Configuration model

Everything an operator can switch or tune is a row in
`platform.config_definition`:

- **kind** — `feature` (boolean on/off), `limit` (integer quota), or `setting`
  (any typed value).
- **value_type** and bounds — `boolean`, `integer` (min/max), `string`
  (max length), `string_list`; optional `allowed_values`.
- **scopes** — where it may be overridden: `platform`, `plan`, `tenant`.
- **tenant_editable** — tenant administrators may change it from their own
  workspace (Settings page).
- **is_public** — the resolved value is included in the tenant's
  `/api/tenant/bootstrap` response so the browser can adapt its UI. Never mark
  secrets or internal limits public.

Values resolve lowest to highest precedence:

```text
definition default → platform → plan (tenant's current subscription)
  → tenant override (operator) → tenant-local (tenant_editable keys only)
```

The platform validates every override in the database
(`platform.validate_config_value`); the tenant BFF validates tenant-local values
with the same rules (`@skeleton/server-kit` `validateConfigValue`). The tenant
BFF caches a tenant's resolved configuration for `TENANT_CONFIG_CACHE_TTL_MS`
(default 10 s), so operator changes apply within that window.

## Adding a module — checklist

1. **Configuration keys.** Add a platform migration (next free number, append
   it to `database/migrations/manifest.json`) that inserts your keys:

   ```sql
   insert into platform.config_definition
     (config_key, kind, value_type, label, description, category, module_code,
      default_value, min_value, max_value, scopes, tenant_editable, is_public)
   values
     ('module.projects', 'feature', 'boolean', 'Projects',
      'Project workspaces for tenant teams.', 'modules', 'projects',
      'false', null, null, array['platform','plan','tenant'], false, true),
     ('limit.projects.max', 'limit', 'integer', 'Maximum projects',
      '0 means unlimited.', 'limits', 'projects',
      '0', 0, 100000, array['platform','plan','tenant'], false, false)
   on conflict (config_key) do nothing;
   ```

   Ship features **off** by default; operators enable them per platform, plan,
   or tenant from the admin panel.

2. **Tenant tables and permissions.** Add
   `database/migrations/tenant/versions/NNN_<name>.sql` (next contiguous
   number, SQL only, no `begin`/`commit`). Create tables and seed permissions:

   ```sql
   create table if not exists project (
     project_id uuid primary key default gen_random_uuid(),
     name text not null,
     created_by uuid references user_account(user_id) on delete set null,
     created_at timestamptz not null default now()
   );
   insert into permission (permission_code, description)
   values ('tenant.projects.read', 'Read projects'), ('tenant.projects.manage', 'Manage projects')
   on conflict (permission_code) do update set description = excluded.description;
   insert into role_permission (role_id, permission_id)
   select r.role_id, p.permission_id from role_definition r cross join permission p
    where r.role_code in ('tenant_owner', 'tenant_admin')
      and p.permission_code in ('tenant.projects.read', 'tenant.projects.manage')
   on conflict do nothing;
   ```

3. **Declare access.** Add every new table to
   `database/migrations/tenant/access-manifest.json`:

   ```json
   "project": { "rls": true, "runtime": ["select", "insert", "update", "delete"] }
   ```

   The provisioner and `npm run migrate:tenants` reset grants and RLS to
   exactly the manifest on every run and **fail** if a table in a tenant schema
   is not declared. You never write `GRANT` or `CREATE POLICY` by hand.

4. **Routes.** Create `backend/tenant/src/modules/<code>.ts` exporting a
   `TenantModule` (contract in `modules/types.ts`) and add it to
   `applicationModules` in `modules/index.ts`:

   ```ts
   export const projectsModule: TenantModule = {
     code: 'projects',
     featureKey: 'module.projects', // routes answer 404 where the feature is off
     register(app, kit) {
       app.get('/api/v1/projects', async (request, reply) => {
         const session = await kit.requireSession(request, reply)
         if (!session || !(await kit.requirePermission(request, reply, session, 'tenant.projects.read'))) return
         return kit.withTenant(request, async (client) => ({
           success: true,
           projects: (await client.query('select project_id, name from project order by created_at desc')).rows,
         }))
       })
       app.post('/api/v1/projects', async (request, reply) => {
         const session = await kit.requireSession(request, reply)
         if (!session) return
         if (!(await kit.requirePermission(request, reply, session, 'tenant.projects.manage')) || !kit.requireCsrf(request, reply, session)) return
         const limit = configInteger(await kit.config(request), 'limit.projects.max', 0)
         // ...enforce the limit, insert, then kit.audit(...)
       })
     },
   }
   ```

   Rules: every mutation calls `requireCsrf`; every query goes through
   `withTenant`; never accept schema, role, or tenant identifiers from the
   client; audit denials and state changes.

   Inside `withTenant`, `current_setting('app.tenant_id')` is the tenant and
   `current_setting('app.user_id', true)` the signed-in user (empty when signed
   out), for row-level security policies. While the provisioner copies a
   tenant's data to another database it sets `app.relocating = 'true'`; make
   triggers that write derived rows skip themselves in that case. To give a
   department or group access to something, reference `team(team_id)` from a
   module table; teams themselves are managed by the core teams module.

5. **Files.** Use `kit.files.save(request, { fileName, contentType, body, createdBy, moduleCode: 'projects' })`,
   `kit.files.open(request, id)` and `kit.files.remove(request, id)`. The
   file service enforces `limit.storage.max_file_mb` and `limit.storage.max_mb`,
   writes to the tenant's active backend, and records which backend holds
   each object.

6. **Frontend.** Read `config` from `/api/tenant/bootstrap` to show or hide the
   module's navigation (only `is_public` keys are present).

7. **Tests.** Follow `tests/integration/admin-controls.test.mjs`: provision a
   tenant through the real worker, enable the feature through
   `PUT /api/config/values`, and assert both the enabled and 404 paths.

The reference module is `backend/tenant/src/modules/delegations.ts`
(capability delegation), which ships disabled (`module.delegations`).

## Admin panel surface

The console (`frontend/platform`) has hash routes, so every page can be linked.
Sidebar groups and the role that can open each page are in `src/shell/nav.ts`.

| Console page | What operators control | API |
| --- | --- | --- |
| Dashboard | Needs attention (failed tenants, pending upgrades, resource pressure, denials), headline numbers, recent activity, job outcomes | the read endpoints below |
| Tenants | List with status filters; suspend, resume, remove (owner; type the subdomain), retry a failed removal | `GET /api/tenants`, `POST /api/tenants/:key/{suspend,resume,deprovision}`, `POST /api/tenant-provisioning/:job/retry` |
| Tenants › New tenant | Provision with branding, the first administrator (login now, emailed invitation, or later), modules, plan and connection tier; live step progress | `POST /api/tenants`, `GET /api/tenant-provisioning/:job` |
| Tenants › *tenant* | Tabs: overview and schema upgrade, profile and branding, plan and modules, administrator access (owner invitations), storage and data (bring your own), configuration overrides, jobs | `GET/PATCH /api/tenants/:key`, `PUT /api/tenants/:key/plan`, `PUT /api/config/values`, `POST/DELETE /api/tenants/:key/owner-invitations`, `/api/tenants/:key/integrations/*`, `POST /api/tenants/:key/migrate` |
| Individuals | B2C accounts: status, sessions, plan | `/api/consumers/*` |
| Plans | Plans, public pricing and entitlements (configuration at `plan` scope) | `GET/POST /api/plans`, `PATCH /api/plans/:code/presentation` |
| Domains | DNS records in the zone, tenant hostnames and how they are routed; add or delete platform-managed subdomains (owner) | `GET/POST/DELETE /api/cloudflare/subdomains` |
| Fleet & schema | Schema version drift and failures; upgrade every tenant that is behind | `GET /api/fleet/status`, `POST /api/fleet/migrate` |
| Server | Live CPU, memory, disk and listening services (needs a recent security-key check) | `GET /api/system/{hardware,services}` |
| Configuration | Platform-wide defaults for every key (owner edits) | `GET /api/config/definitions`, `PUT/DELETE /api/config/values` |
| Operators | Invite, role, enable/disable, reset access or keys, end sessions (owner) | `/api/platform/users/*` |
| Audit log | Filterable, paginated control-plane audit | `GET /api/audit/events` |
| Account menu › My security | Password change, security-key enrolment and step-up | `POST /api/auth/password`, `/api/auth/mfa/*` |

All mutations, and reads of live server telemetry, require the operator's CSRF
token (mutations) and a WebAuthn step-up within the last five minutes. The
console runs the step-up automatically for mutations and shows a *Verify with
security key* button on panels whose reads need it.
Writes go through `SECURITY DEFINER` functions that enforce invariants (for
example, at least one active `platform_owner` always remains) and write
`platform.platform_audit` in the same transaction.

## Invitations

- Tokens are 256-bit, single-use, stored only as SHA-256 hashes, and carry a
  type prefix (`own_` tenant owner, `inv_` tenant user, `opr_` operator).
- Links put the token in the URL fragment (`/accept-invite#token=…`), which
  browsers never send to servers, so tokens stay out of access logs.
- Delivery is pluggable. With `NOTIFICATION_WEBHOOK_URL` and
  `NOTIFICATION_WEBHOOK_SECRET` set, invitations are POSTed as JSON with an
  `X-Signature: sha256=<hmac>` header to a relay you operate (email, SMS, chat).
  Without them, the link is shown once to the issuing administrator.
- Lifetimes come from `invitations.ttl_hours`. Reissuing revokes the previous
  link.

## Bring-your-own storage and databases

Tenants keep files and data on the VDS by default. From **Tenants › *tenant* →
Storage & data** (operators) or **Settings → Storage & database** (tenant
owners, if the plan enables `integration.byo_storage` /
`integration.byo_database`), a tenant can connect:

- an **S3-compatible bucket** (AWS S3, MinIO, Cloudflare R2, Wasabi, Backblaze
  B2, Ceph…). The platform writes only under the chosen folder (prefix).
  Activation takes effect immediately for new files; "Move existing files"
  runs a background job.
- a **PostgreSQL database** (13+). The platform uses one dedicated schema,
  created if missing, as a user that must not bypass RLS. Activation runs a
  background job that moves the tenant's data there during a short
  maintenance window; "Move data back to VDS" reverses it.

Every integration must pass a **connection test** of its exact settings
before activation. The test writes and deletes a probe object, or runs a
rolled-back transaction that creates a table with forced RLS, and reports each
step. See [ADR-001](adr-001-tenancy-scaling-tiers.md) for the security model
(sealed credentials, endpoint policy, pinned addresses).

## Background operations

The provisioning worker also runs operations started from the admin panel or
by tenant owners: `migrate` (schema upgrade and access-rule reset),
`relocate_database`, and `relocate_storage`. They share the job and step tables
with provisioning, appear in the tenant's job history, can be retried, and are
limited to one open job per tenant. Step lists live in
`dependency/platform/ServerKit/src/operations.ts`.
