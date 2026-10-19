# Guide for coding agents

Read this before you change anything. It is the map of the repository, the
rules that keep it safe, and step-by-step recipes for the usual changes.
Humans are welcome too.

- What the platform is and how to run it: [`README.md`](README.md)
- What every technology is for: [`stacks.md`](stacks.md)
- The module contract in depth: [`docs/architecture/extending-the-foundation.md`](docs/architecture/extending-the-foundation.md)
- Isolation tiers and data placement: [`docs/architecture/adr-001-tenancy-scaling-tiers.md`](docs/architecture/adr-001-tenancy-scaling-tiers.md)
- Operating an installation: [`docs/operations/robustness-runbook.md`](docs/operations/robustness-runbook.md)

---

## 1. What you are working on

A multi-tenant SaaS **foundation**. It has no product features of its own.
Products are added as **modules** (section 6). There are four web surfaces,
each a React app served by its own Fastify backend (BFF):

```text
Browser ──HTTPS──> edge (Cloudflare Tunnel or your reverse proxy)
  ROOT_DOMAIN, www      -> landing        :3651  frontend/landing (static) via scripts/serve-landing.mjs
  platform.ROOT_DOMAIN  -> platform BFF   :3656  backend/          + frontend/platform  operator console
  user.ROOT_DOMAIN      -> public BFF     :3657  backend/public    + frontend/public    individual users (B2C)
  <tenant>.ROOT_DOMAIN  -> tenant BFF     :6355  backend/tenant    + frontend/tenant    one workspace per tenant
  app.ROOT_DOMAIN       -> tenant BFF     :6355  shared sign-in: company + username + password
                           provisioner           backend/provisioner  job worker (no port)

BFFs ──> PgBouncer (platform :3658, public :3659, tenant :6360) ──> PostgreSQL :5433, database platform_db
```

- A browser talks only to its own BFF, on the same origin, under `/api/*`.
- The tenant BFF finds the tenant from the `Host` header (`TenantResolver` in
  `backend/tenant/src/tenant-context.ts`). Only an exact, active hostname in
  `platform.tenant_domain` is served.
- On `app.ROOT_DOMAIN` the user names the company at sign-in. The answer
  never reveals whether a company or user exists, and the company is kept in
  a signed cookie until sign-out. `app` is a reserved subdomain.
- The provisioner runs tenant jobs (create, migrate, relocate data, move
  files, deprovision) as numbered, retryable steps from
  `platform.tenant_provisioning_job`.

## 2. Ground rules (do not break these)

1. **Every tenant query goes through `kit.withTenant()`.** It runs one
   transaction with `SET LOCAL ROLE <tenant role>`,
   `search_path = <tenant schema>, pg_catalog`, and `app.tenant_id` set, under
   forced row-level security. Never open connections or switch schemas
   yourself, and never take a schema, role or tenant identifier from the
   client.
2. **Tenant privileges are declared, not written.** Every tenant table is
   listed in `database/migrations/tenant/access-manifest.json`. Migrations
   reset grants and RLS to exactly that file and fail when a table is missing
   from it. Never write `GRANT` or `CREATE POLICY` by hand.
3. **Migrations are append-only.** Platform and tenant migrations are
   checksummed in a ledger; editing an applied file fails
   `npm run verify:migrations`. Write a new migration instead.
4. **Tenant migration numbers are contiguous.** The runner refuses gaps in
   `database/migrations/tenant/versions/NNN_*.sql`; take the next number.
5. **Mutations are protected.** Every tenant mutation calls
   `kit.requireCsrf()` and `kit.requirePermission()`. Every platform mutation
   needs the CSRF token and a WebAuthn step-up from the last five minutes
   (`backend/src/mfa.ts`); the console runs the step-up for you through
   `api.send`.
6. **Features ship off.** A module is a `module.<code>` feature key whose
   default is `false`. Operators switch it on per platform, plan or tenant.
7. **No constants per deployment.** The product name, domains and branding
   come from configuration (`/api/public-config`, tenant branding,
   `.env/setup.env`). Anything an operator might change is a configuration
   key.
8. **No secrets or customer data in git.** `.env/secrets.env` ships blank;
   installed secrets live in `./runtime` (ignored). `npm run scan:secrets`
   checks the built bundles.

## 3. Where things are

| Path | What |
|---|---|
| `backend/src/server.ts` | Platform BFF: sign-in, sessions, operator MFA, Cloudflare DNS, server telemetry, tenant create/suspend/resume/remove |
| `backend/src/admin-routes.ts` | Platform admin API: tenant detail and profile, plans, configuration values, operators, audit, fleet, individuals, integrations |
| `backend/src/tenant-provisioning.ts` | Validation and creation of provisioning jobs (subdomain rules, reserved names, owner bootstrap, modules, plan) |
| `backend/src/mfa.ts` | WebAuthn registration, assertion and the 5-minute step-up check |
| `backend/provisioner/src/worker.ts` | Job worker; `tenant-migrations.ts` applies tenant versions; `tenant-operations.ts` upgrades and data moves |
| `backend/tenant/src/server.ts` | Tenant BFF: host resolution, shared app host, sign-in, sessions, users, roles, categories, default password, CSV import, audit, module mounting, static files |
| `backend/tenant/src/modules/types.ts` | **The module contract** (`TenantModule`, `TenantRequestKit`) |
| `backend/tenant/src/modules/` | Core modules: `invitations`, `settings`, `teams` (departments and groups), `files`, `integrations`. Application modules: `delegations` (the reference module, off by default), listed in `modules/index.ts` |
| `backend/tenant/src/tenant-context.ts` | Tenant resolution and `MIN_SUPPORTED_SCHEMA_VERSION` |
| `backend/public/src/server.ts` | Public (B2C) BFF |
| `dependency/platform/ServerKit/src` | Shared server code: configuration, storage (local and S3), integrations, network policy, shared state, Turnstile, invitations |
| `dependency/ui/src` | `useTurnstile`, `TurnstileSlot`, `MetricCard` |
| `frontend/platform/src` | Operator console. `App.tsx` is the shell and hash router; `shell/nav.ts` holds the menu and per-role access; `pages/*` and `admin/*` are the pages; `admin/ui.tsx` is the component kit; `theme.css` holds the design tokens |
| `frontend/tenant/src` | Tenant workspace. `App.tsx` holds sign-in, forced password change, setup wizard, navigation and pages; `workspace/` holds users and teams |
| `database/migrations/NNN_*.sql` + `manifest.json` | Platform migrations, applied in manifest order |
| `database/migrations/tenant/versions/NNN_*.sql` | Tenant schema versions, applied to every tenant schema |
| `database/migrations/tenant/access-manifest.json` | Grants and RLS for every tenant table |
| `setup.sh`, `.env/`, `deploy/templates/`, `scripts/foundation/` | Installer, its settings, rendered unit and config templates, Cloudflare and demo helpers |
| `scripts/` | Migrations, tenant reconciliation, operator CLI (`platform-operator.mjs`, `tenant-operator.mjs`), backup and restore drill, secret scan, test cluster |
| `tests/unit`, `tests/integration`, `tests/fixtures`, `tests/helpers` | Test suites, fixture tenants `alpha` and `beta`, helpers |

**Data model.** The single database `platform_db` holds three kinds of
schema:

| Schema | Holds | Reached by |
|---|---|---|
| `platform` | Operators, sessions, audit, tenant registry and domains, jobs, plans, configuration registry, integrations | Platform BFF (mostly through `SECURITY DEFINER` functions); provisioner |
| `consumer` | Individual (B2C) users, subscriptions, groups | Public BFF, under RLS |
| `tenant_<key>` | A tenant's users, roles, sessions, teams, settings, file metadata, audit, module tables | Only that tenant's role, under forced RLS on `app.tenant_id` |

**Roles and permissions.**

- **Operators:** `platform_owner`, `platform_admin`, `platform_viewer`. The
  menu shows each role only the pages its server routes allow
  (`frontend/platform/src/shell/nav.ts`).
- **Tenant users:** canonical roles `tenant_owner`, `tenant_admin`,
  `tenant_manager`, `tenant_member` and `tenant_viewer`, mapped to permission
  codes (`tenant.users.read`, `tenant.users.roles`,
  `tenant.settings.manage`, …).
- **Forced password change:** a user whose password an administrator set or
  reset must change it first. A server `preHandler` answers every other API
  call with 403 `PASSWORD_CHANGE_REQUIRED`.

## 4. Build, run and verify

You need Node.js 22+ (CI uses 24) and the PostgreSQL 16 server binaries
(`/usr/lib/postgresql/16/bin`, or set `PG_BIN`).

```bash
npm ci                                   # one lockfile for all workspaces
npx playwright install --with-deps chromium   # once: browser for the UI and WebAuthn tests
npm run build                            # every workspace (backends to dist/, frontends to dist/)
npm run typecheck                        # backends and shared packages
npx tsc -b frontend/<app>                # one frontend

./setup.sh test                          # everything, on a throwaway cluster (builds what is missing)
bash scripts/with-test-cluster.sh npm run test:unit
bash scripts/with-test-cluster.sh                                        # integration suite
bash scripts/with-test-cluster.sh node --test tests/integration/<file>.test.mjs
```

`with-test-cluster.sh` creates a temporary PostgreSQL cluster, applies every
migration, provisions the fixture tenants `alpha.sandbox.test` and
`beta.sandbox.test` through the real worker, runs your command with a
complete environment, and deletes everything afterwards. It never touches an
installed system.

- **Testing a BFF:** import the built server (`backend/*/dist/server.js`),
  call `createServer()`, and drive it with `app.inject()`. Copy the shape of
  `tests/integration/admin-controls.test.mjs` or
  `tests/integration/tenant-onboarding.test.mjs`. They provision a tenant,
  switch a feature on and assert the allowed and the denied paths.
- **Testing a UI:** `tests/integration/platform-console.test.mjs` serves the
  built console through the platform BFF and routes a Playwright browser's
  requests to `app.inject()`. It needs no DNS, TLS or Turnstile, and a seeded
  session row replaces sign-in. Build first: the test skips without
  `frontend/platform/dist`.
- **Running a server by hand:**
  `bash scripts/with-test-cluster.sh npm run start:tenant:bff` runs it against
  the throwaway database. Real browser sign-in needs HTTPS on real hostnames
  (`__Host-` cookies, WebAuthn). For that, install on a VM; `EDGE_MODE=none`
  with a local proxy and `LOGIN_CHALLENGE=none` makes a sandbox.

**Definition of done** (CI enforces most of it):

- [ ] `npm run build` and `npm run typecheck` pass.
- [ ] `./setup.sh test` passes with **no skipped tests** (CI fails on skips).
- [ ] New routes have integration tests for the allowed **and** the denied
      paths.
- [ ] New tenant tables are in `access-manifest.json`; new platform migrations
      are appended to `manifest.json`.
- [ ] No applied migration was edited.
- [ ] `npm run scan:secrets` passes; no credentials or customer data are
      committed.
- [ ] `README.md`, this file or `stacks.md` are updated if you changed
      something they describe.

## 5. Recipes

### Add a platform configuration key

1. Create `database/migrations/NNN_<name>.sql`, using the next free number,
   and append it to `database/migrations/manifest.json`.
2. In it, insert the key into `platform.config_definition`. Set `kind`
   (`feature`, `limit` or `setting`), its type and bounds, its `scopes`
   (`platform`, `plan`, `tenant`), and `tenant_editable` and `is_public`.
   Finish by recording the migration in `platform.schema_migration`; copy the
   form of an existing migration such as `036_tenant_owner_bootstrap.sql`.
3. Read the key in the tenant BFF with `kit.config(request)`. The console's
   *Configuration* page and each tenant's *Configuration* tab show it
   automatically.

### Add a tenant table

1. Create `database/migrations/tenant/versions/NNN_<name>.sql` with the **next
   contiguous** number. Use plain SQL with no `begin`/`commit`;
   `search_path` is already the tenant schema.
2. Add the table to `database/migrations/tenant/access-manifest.json`, for
   example:
   `"project": {"rls": true, "runtime": ["select", "insert", "update", "delete"]}`.
3. If the tenant BFF itself now depends on the table, raise
   `MIN_SUPPORTED_SCHEMA_VERSION` in `backend/tenant/src/tenant-context.ts`.
   Tenants below it answer 503 until they are upgraded (*Console › Fleet &
   schema*).

### Add a module

The full checklist with code is in
[`docs/architecture/extending-the-foundation.md`](docs/architecture/extending-the-foundation.md).
In short:

1. **Feature key:** add `module.<code>`, off by default (recipe above). The
   *New tenant* form and each tenant's *Plan & modules* tab list it
   automatically.
2. **Tables and permissions:** add tenant tables (recipe above) and seed the
   module's permission codes into `permission` and `role_permission`. To
   give a department or group access to something, reference
   `team(team_id)`.
3. **Routes:** create `backend/tenant/src/modules/<code>.ts` exporting a
   `TenantModule` with `featureKey: 'module.<code>'`, and add it to
   `applicationModules` in `modules/index.ts`. Its routes answer 404
   wherever the feature is off. Use:
   - `kit.requireSession` and `kit.requirePermission` on every route;
   - `kit.requireCsrf` on mutations;
   - `kit.withTenant` for every query and `kit.config` for settings;
   - `kit.files` for files and `kit.audit` for state changes.
4. **UI:** read `config['module.<code>']` from `/api/tenant/bootstrap` (keys
   marked `is_public` only), then add a navigation item and page in
   `frontend/tenant/src/App.tsx` (the `NavId` type and the `nav` list).
5. **Row-level security for module tables:** inside `withTenant`,
   `current_setting('app.user_id', true)` is the signed-in user. During a
   data move the provisioner sets `app.relocating = 'true'`; triggers that
   write derived rows should skip themselves then.
6. **Tests:** provision a tenant, enable the feature through
   `PUT /api/config/values`, and assert both the working path and the 404.

The reference module is `backend/tenant/src/modules/delegations.ts`.

### Add a page to the operator console

1. Add the page id to `PageId`, `NAV` (its group, icon and allowed roles) and
   `PAGE_LABELS` in `frontend/platform/src/shell/nav.ts`. Match the roles to
   the server routes it calls.
2. Render it from `PageView` in `frontend/platform/src/App.tsx`.
3. Build it from `frontend/platform/src/admin/ui.tsx`:
   - layout: `PageHeader`, `Card`, `Table`, `Tabs`;
   - data: `useResource` (it handles 403 and step-up);
   - confirmations: `useConfirm`, never `window.confirm`.

   Style with the tokens in `theme.css` and no inline colours, so the dark
   theme works.
4. Read data with `api.get` and change it with `api.send`; `api.send` runs
   the security-key step-up when the server asks for it.

## 6. Pitfalls that have bitten before

- **Shared rate limits in tests.** Rate limits are per client address. In
  tests that make many requests, give each simulated client its own
  `remoteAddress` in `app.inject()`, or slow CI runners will get 429s.
- **PgBouncer transaction pooling.** Session state does not survive between
  transactions. Keep tenant work inside one `withTenant` call; never rely on
  a session-level `SET`.
- **CI differs from local runs.** CI connects tenants through a real
  PgBouncer; `with-test-cluster.sh` connects directly. When CI fails and
  local tests pass, look at connection handling first.
- **Optional inputs passed straight to a function.** Code reached without Zod
  parsing (scripts, fixtures) can see missing optional fields; default them
  (`input.modules ?? []`).
- **Telemetry reads need a step-up.** `/api/system/hardware` and
  `/api/system/services` answer 403 `MFA_STEP_UP_REQUIRED` without a recent
  security-key check; the console shows a *Verify* button for this.
- **Stale browser tabs after a deploy.** The tenant build keeps the previous
  week's hashed assets (`keepRecentAssets` in `frontend/tenant/vite.config.ts`),
  and `main.tsx` reloads once on a failed lazy import. Keep both.
- **Turnstile in sandboxes.** Use `LOGIN_CHALLENGE=none` on the servers
  together with `VITE_LOGIN_CHALLENGE=none` at build time. `TurnstileSlot`
  then renders nothing.

## 7. Known gaps

- **Backup consistency during uploads.** File writes take the shared side of
  the `skeleton-local-storage-backup` advisory lock, but
  `scripts/backup-platform-db.sh` does not yet hold the exclusive side while
  it collects. A backup taken during an upload can contain a file without its
  row, or the reverse.
