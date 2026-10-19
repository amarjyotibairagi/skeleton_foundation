# Platform Foundation

A self-installing multi-tenant platform. Unzip this folder anywhere on an
Ubuntu or Debian server, fill in `.env/`, and run `setup.sh`. The script
builds a complete installation **inside this folder** and controls it from
then on (status, backups, upgrades, uninstall). The admin panel then controls
the platform itself.

| Component | What it is |
|---|---|
| **Landing site** | A generic public home page on `ROOT_DOMAIN` |
| **Platform console** | The operator admin panel on `platform.ROOT_DOMAIN`, for tenants, plans, configuration, operators, DNS, integrations and schema upgrades |
| **Individual-user app** | The B2C app on `user.ROOT_DOMAIN` |
| **Tenant workspaces** | One per organization, on `<name>.ROOT_DOMAIN`. Each has its own PostgreSQL schema with forced row-level security, its own database login (or a shared pool) and its own file storage. A tenant may optionally bring its own S3-compatible storage or PostgreSQL database |
| **Provisioning worker** | Creates, migrates, relocates and removes tenants |
| **PostgreSQL** | A dedicated cluster, plus three PgBouncer pools |
| **Operations** | Encrypted daily backups, a health check every few minutes and an optional Cloudflare Tunnel |

As shipped, the folder contains no secrets and no database. Every password and
key is generated on the server during installation, and the database is
created empty and then migrated.

This repository is the **foundation only**. It contains no product modules
and no customer data. Products are built on it as modules (section 0.6).

**Contents**

- [0. Orientation for developers and coding agents](#0-orientation-for-developers-and-coding-agents): how the code fits together, how to run it, and how to extend it
- Sections 1–10: installing and operating a server with `setup.sh`

---

## 0. Orientation for developers and coding agents

Read this section before changing code. It gives you the map. The deeper
references are [`docs/architecture/extending-the-foundation.md`](docs/architecture/extending-the-foundation.md)
(the module contract and admin surface),
[`docs/architecture/adr-001-tenancy-scaling-tiers.md`](docs/architecture/adr-001-tenancy-scaling-tiers.md)
(isolation tiers and data placement), and
[`docs/operations/robustness-runbook.md`](docs/operations/robustness-runbook.md).

### 0.1 Five processes, four hostnames, one database

```text
Browser ──HTTPS──> edge (Cloudflare Tunnel or your proxy)
   ROOT_DOMAIN, www      -> landing        :3651  static site (frontend/landing)
   platform.ROOT_DOMAIN  -> platform BFF   :3656  backend/        + frontend/platform (operator console)
   user.ROOT_DOMAIN      -> public BFF     :3657  backend/public  + frontend/public   (individual users, B2C)
   *.ROOT_DOMAIN         -> tenant BFF     :6355  backend/tenant  + frontend/tenant   (one workspace per tenant)
   app.ROOT_DOMAIN       -> tenant BFF     :6355  shared sign-in: company + username + password
                            provisioner    (no port)  backend/provisioner: job worker for tenant lifecycle

All BFFs ──> PgBouncer pools (platform :3658, public :3659, tenant :6360) ──> PostgreSQL :5433, database platform_db
```

- Every BFF serves its own frontend's built `dist/` and answers same-origin `/api/*`.
  Browsers never talk to the database or to another service.
- The **tenant BFF** resolves the tenant from the `Host` header
  (`backend/tenant/src/tenant-context.ts`, `TenantResolver`). Only an exact
  hostname registered as active in `platform.tenant_domain` is served.
  `app.ROOT_DOMAIN` (`TENANT_APP_HOST`) is a shared host where the user names
  the company at sign-in. The answer does not reveal whether a company or user
  exists, and the company is then remembered in a signed cookie until sign-out.
- The **provisioner** polls `platform.tenant_provisioning_job` and runs each job
  as numbered, retryable steps. The job types are: create (about 20 steps,
  ending in `CREATE_TENANT_OWNER` and `ACTIVATE_TENANT`), migrate (schema
  upgrade), relocate data (`RELOC_*`), move files (`STORAGE_*`) and deprovision
  (`DEPROV_*`). A failed job can be retried from the step that failed.

### 0.2 Data model and isolation

| Schema | Holds | Who reaches it |
|---|---|---|
| `platform` | Operators, sessions, audit, tenant registry and domains, provisioning jobs, plans, the configuration registry, integrations | Platform BFF through `SECURITY DEFINER` functions; the provisioner role |
| `consumer` | B2C individuals, their subscriptions and groups | Public BFF (`consumer_bff_login`), with RLS |
| `tenant_<key>` (one per tenant) | That tenant's users, roles, sessions, teams, settings, files metadata, audit, module tables | Only that tenant's database role, under **forced RLS** keyed on `app.tenant_id` |

- Tenant requests run in one transaction with `SET LOCAL ROLE <tenant role>`,
  `search_path = <schema>, pg_catalog` and `app.tenant_id` set
  (`backend/tenant/src/tenant-database.ts`). Modules get this from
  `kit.withTenant()` and must never open connections themselves.
  `app.user_id` carries the signed-in user, for module RLS policies.
- The tenant schema's privileges and RLS are **declared**, never hand-written:
  every table is listed in `database/migrations/tenant/access-manifest.json`.
  Migrations reset grants to exactly the manifest, and they fail if a table is
  missing from it.
- Tenants can use a pooled login (many small tenants, one PgBouncer user) or a
  dedicated one. Their data can live on this server (the default), or in their
  own PostgreSQL database or S3-compatible bucket ("bring your own", tested
  before activation). See ADR-001.

### 0.3 Security model (the parts you must not break)

- **Sessions:** server-side sessions. Only a SHA-256 of the token is stored.
  `__Host-` cookies, CSRF token on every mutation, and an `Origin` check.
  Passwords are hashed with argon2id.
- **Platform operators:** roles `platform_owner`, `platform_admin` and
  `platform_viewer`.
  - Every mutation, and reading live server telemetry, requires a WebAuthn
    security-key check from the last 5 minutes (`backend/src/mfa.ts`). The
    console runs the check on demand: `api.send` steps up automatically, and
    read-only panels show a *Verify with security key* button.
  - Writes go through database functions that keep invariants. For example,
    at least one active owner always remains.
- **Tenant users:** canonical roles `tenant_owner`, `tenant_admin`,
  `tenant_manager`, `tenant_member` and `tenant_viewer`, mapped to permission
  codes (`tenant.users.read`, `tenant.users.roles`, `tenant.settings.manage`,
  …).
  - Permissions are checked server-side with `kit.requirePermission`.
  - A user whose password an administrator set or reset must change it first.
    A server `preHandler` answers every other API call with 403
    `PASSWORD_CHANGE_REQUIRED`.
- **Sign-in:** Cloudflare Turnstile (`action: "login"`) on every sign-in page,
  plus login throttling. `LOGIN_CHALLENGE=none` (servers) together with
  `VITE_LOGIN_CHALLENGE=none` (build) disables Turnstile, for private
  sandboxes only.
- **Invitations:** 256-bit single-use tokens, stored hashed, carried in the
  URL fragment.

### 0.4 Repository map (where to look)

| Path | What |
|---|---|
| `backend/src/server.ts` | Platform BFF: auth, sessions, operator MFA, Cloudflare DNS, system telemetry, tenant create/suspend/resume/remove |
| `backend/src/admin-routes.ts` | Platform admin API: tenant detail and profile, plans, configuration values, operators, audit, fleet, consumers, integrations |
| `backend/src/tenant-provisioning.ts` | Validation and creation of provisioning jobs (subdomain rules, owner bootstrap, modules, plan) |
| `backend/provisioner/src/worker.ts` | The job worker; `tenant-migrations.ts` applies tenant schema versions; `tenant-operations.ts` relocation and upgrade helpers |
| `backend/tenant/src/server.ts` | Tenant BFF: host resolution, app host, sign-in, sessions, users/roles/categories/default password/import, audit, module mounting, static serving |
| `backend/tenant/src/modules/` | Tenant modules. **Core:** `invitations`, `settings`, `teams` (departments and groups), `files`, `integrations`. **Application:** `delegations` (the reference module, off by default). `types.ts` is the module contract |
| `backend/public/src/server.ts` | Public (B2C) BFF |
| `dependency/platform/ServerKit` | Shared server code: configuration resolution and validation, storage (local and S3), integrations, network policy, invitations, Turnstile, shared state |
| `dependency/ui` | Shared React pieces: `useTurnstile` and `TurnstileSlot` (fixed-size sign-in widget), `MetricCard`, base styles |
| `frontend/platform` | Operator console (React and Vite). `src/App.tsx` is the shell and hash router; `src/shell/nav.ts` holds the navigation and per-role access; `src/pages/*` are the dashboard, tenants, new tenant, tenant detail tabs, domains and server; `src/admin/*` are plans, configuration, operators, audit, fleet, individuals and security; `src/admin/ui.tsx` is the component kit |
| `frontend/tenant` | Tenant workspace: sign-in (with company on the app host), forced password change, first-login setup wizard, welcome page, users (add, invite, CSV import, categories, default password, reset), departments and groups, files, audit, settings |
| `frontend/public`, `frontend/landing` | B2C app; generic landing page |
| `database/migrations/NNN_*.sql` + `manifest.json` | Platform migrations, applied in manifest order with checksums (`scripts/platform-migrate.mjs`) |
| `database/migrations/tenant/versions/NNN_*.sql` | Tenant schema versions, applied to every tenant schema (`npm run migrate:tenants`; the provisioner applies them to new tenants) |
| `setup.sh`, `deploy/templates/`, `scripts/foundation/` | Installer, rendered unit and config templates, Cloudflare and demo helpers |
| `scripts/` | Migrations, tenant reconciliation, operator CLI (`platform-operator.mjs`), backup and restore drill, secret scan, test cluster |
| `tests/unit`, `tests/integration`, `tests/fixtures`, `tests/helpers` | Test suites and the fixture tenants `alpha` and `beta` |

### 0.5 Working on the code

Requirements: Node.js 22+ (CI uses 24), and the PostgreSQL 16 server
binaries (`/usr/lib/postgresql/16/bin`, or set `PG_BIN`) for tests.

```bash
npm ci                     # one lockfile for all workspaces
npm run build              # every workspace: backends to dist/, frontends to dist/
npm run typecheck          # backends and shared packages
npx tsc -b frontend/<app>  # one frontend (each has its own tsconfig)

# The development loop: a throwaway PostgreSQL cluster with every migration
# applied and two fixture tenants (alpha.sandbox.test, beta.sandbox.test)
# provisioned through the real pipeline. Removed when the command exits.
bash scripts/with-test-cluster.sh npm run test:unit
bash scripts/with-test-cluster.sh                      # integration suite
bash scripts/with-test-cluster.sh node --test tests/integration/<file>.test.mjs
```

- **Testing the BFFs.** Integration tests import the built servers
  (`backend/*/dist/server.js`), call `createServer()` and drive them with
  `app.inject()` against the real database. A new feature's test should
  follow `tests/integration/admin-controls.test.mjs` or
  `tests/integration/tenant-onboarding.test.mjs`. Both provision a tenant,
  enable a feature, then assert the allowed and the denied paths.
- **Testing the UIs in a browser.**
  `tests/integration/platform-console.test.mjs` serves the built console
  through the platform BFF and routes a Playwright browser's requests to
  `app.inject()`. It needs no DNS, TLS or Turnstile. A seeded session row
  stands in for sign-in. Reuse this pattern for UI work. Run `npm run build`
  first: the test is skipped without `frontend/platform/dist`.
- **Running the servers by hand.** The BFFs read their configuration from
  environment variables. `with-test-cluster.sh` exports a complete test set,
  so `bash scripts/with-test-cluster.sh npm run start:tenant:bff` runs a
  server against the throwaway database. Real browser sign-in needs HTTPS on
  real hostnames (`__Host-` cookies, WebAuthn). For that, install on a VM with
  `setup.sh`; `EDGE_MODE=none` with a local reverse proxy and
  `LOGIN_CHALLENGE=none` works for a sandbox.
- **CI** (`.github/workflows/ci.yml`) runs on PostgreSQL 16 and PgBouncer. It
  runs the build, typecheck, unit and integration tests, the migration ledger
  and tenant registry checks, the secret scan and a restore drill. Tests that
  are skipped fail the job.

### 0.6 Building on the foundation (modules)

A product feature is a **module**: tenant tables, routes, configuration keys
and UI. It plugs in without touching the security code. The full checklist,
with code, is in `docs/architecture/extending-the-foundation.md`. In short:

1. **Configuration keys.** Add a platform migration (the next free number, appended to
   `database/migrations/manifest.json`) that inserts `module.<code>` (a
   feature, **off by default**) and any limits or settings into
   `platform.config_definition`. Operators switch it on per platform, plan or
   tenant. The *New tenant* form and the tenant's *Plan & modules* tab list
   every `module.*` key automatically.
2. **Tenant tables.** Add `database/migrations/tenant/versions/NNN_<name>.sql`.
   - Use the **next contiguous** number: the runner refuses gaps. Plain SQL, no
     `begin`/`commit`, `search_path` is the tenant schema.
   - Seed the module's permissions into `permission` and `role_permission`.
   - Declare every new table in `access-manifest.json`.
   - To grant access to a department or group, reference `team(team_id)`.
3. **Routes.** Export a `TenantModule` with a `featureKey` from
   `backend/tenant/src/modules/<code>.ts` and add it to `applicationModules`
   in `modules/index.ts`.
   - Where the feature is off, every route answers 404.
   - Use `kit.requireSession`, `kit.requirePermission`, `kit.requireCsrf` on
     mutations, `kit.withTenant` for every query, `kit.config` for settings,
     `kit.files` for files and `kit.audit` for state changes.
   - Never take a schema, role or tenant identifier from the client.
4. **UI.** Read `config['module.<code>']` from `/api/tenant/bootstrap` (only
   keys marked `is_public` are present) to show the module in the tenant
   workspace's navigation (`frontend/tenant/src/App.tsx`, the `nav` list).
5. **Data moves.** When a tenant's data moves to another database, rows are
   copied verbatim with `app.relocating = 'true'`, so module triggers should
   skip derived writes while `current_setting('app.relocating', true) = 'true'`.
6. **Minimum schema.** If the tenant BFF starts to depend on a new tenant
   migration, raise `MIN_SUPPORTED_SCHEMA_VERSION` in
   `backend/tenant/src/tenant-context.ts`. Older tenants then answer 503 until
   they are upgraded (Console › Fleet & schema).

The reference module is `backend/tenant/src/modules/delegations.ts`.

### 0.7 Conventions

- **Applied migrations:** never edit one. Platform and tenant migrations are
  checksummed. Write a new one instead (`npm run verify:migrations` catches
  drift).
- **Admin control:** everything an operator should control is a configuration
  key or an admin API, never a constant per deployment. Branding, the product
  name and domains come from configuration (`/api/public-config`, tenant
  branding), not from code.
- **Tests:** every new route gets an integration test covering the allowed and
  the denied paths. The suite must pass with nothing skipped.
- **Secrets:** never commit secrets or customer data. `.env/secrets.env` ships
  blank; real values live in `runtime/` (ignored), and
  `npm run scan:secrets` checks the built bundles.

### 0.8 What changed in the last sync (2026-10-19)

The foundation picked up these changes from the production system they were
developed on:

- **Operator console redesign.**
  - A grouped sidebar with per-role access, hash routes (back, refresh and
    links work), light and dark themes, and phone layout.
  - A dashboard built around *Needs attention*: failed tenants, pending
    upgrades, resource pressure and recent denials.
  - Per-tenant pages with tabs (overview, profile, plan and modules,
    administrator access, storage and data, configuration, jobs).
  - In-app confirmations, including typing the subdomain to remove a tenant.
- **Tenant onboarding.**
  - The first administrator's login can be set during provisioning (platform
    migration 036, step `CREATE_TENANT_OWNER`); an emailed invitation remains
    an option.
  - Modules are chosen at creation.
  - A removed tenant releases its subdomain for reuse (039).
- **Tenant workspace.**
  - A welcome page and a first-login setup wizard.
  - Users with administrator and user kinds, user categories, CSV import, and
    a workspace default password with administrator reset and a forced change
    (tenant migrations 009–011).
  - Departments and groups as a core module (012).
  - The shared `app.` host with company sign-in.
- **Operator self-service.** Operators change their own password (037);
  telemetry reads require a security-key check.
- **Hardening.**
  - Lookup indexes (tenant migration 008) and capacity and security
    hardening (033).
  - Provisioning retry and audit fixes (035).
  - Fastify client errors keep their 4xx status.
  - Stricter static-file caching, and stale-chunk protection in the tenant
    build.

Known follow-up: file writes already take the shared side of the
`skeleton-local-storage-backup` advisory lock, but
`scripts/backup-platform-db.sh` does not yet hold the exclusive side while
collecting. Backups taken during uploads can therefore include a file without
its row, or the reverse.

---

## 1. Requirements

- A server running **Ubuntu 22.04/24.04 or Debian 12** with systemd, root access, 2 or more vCPUs, 4 GB or more RAM and 20 GB or more of disk.
- A domain name. With the recommended Cloudflare mode, its DNS must be on Cloudflare.
- Outbound internet access during installation (packages, npm, Cloudflare API).

The installer can fetch PostgreSQL 16+, PgBouncer, Node.js 22+ and cloudflared
itself (`--install-packages`), or you can install them beforehand.

## 2. Folder layout

The installation lives entirely in the folder that holds `setup.sh`:

| Path | Created by install | Contents |
|---|---|---|
| `./` | no | Code, run in place. Install adds `node_modules/` and `dist/` builds |
| `./runtime/config/` | yes | `install.env`, `secrets/` and `env/` (root only), `pgbouncer/` |
| `./runtime/data/` | yes | PostgreSQL cluster, tenant credentials, tenant files |
| `./runtime/logs/` | yes | One log per setup run (services log to the journal) |
| `./runtime/node/` | yes | Node.js, when `--install-packages` downloaded it |
| `./backups/` | yes | Encrypted backups (`BACKUP_DIR` can point elsewhere) |

Outside the folder, install adds only what a service needs:

- systemd units `/etc/systemd/system/<slug>-*`
- system users `<slug>-*`
- the PostgreSQL, PgBouncer and cloudflared packages, from the OS repositories

`sudo ./setup.sh uninstall --purge` removes all of that and returns the folder
to exactly its unzipped state, keeping `./backups/`.

Put the folder somewhere the service accounts can reach, such as
`/opt/<name>` or `/srv/<name>`. Every directory above it must be traversable
by other users, so `/root` does not work. `check` says so if a location
cannot be used. To run two installations on one server, use two folders with
different `APP_SLUG`s and ports.

What ships in the folder:

```
foundation/
├── setup.sh              ← the installer (run this)
├── .env/
│   ├── setup.env         ← every decision about the installation (no secrets)
│   └── secrets.env       ← credentials you supply (blank by default)
├── backend/              platform, public, tenant services and the provisioning worker
├── frontend/             landing, platform console, individual app, tenant app
├── dependency/           shared server kit, UI kit, Cloudflare and Drizzle packages
├── database/
│   ├── migrations/       platform migrations (ordered by manifest.json) and tenant schema versions
│   └── seeds/            optional demo individuals
├── deploy/templates/     systemd units, PgBouncer and PostgreSQL configuration templates
├── scripts/              migration, operator, backup, health and foundation helper scripts
├── tests/                unit and integration tests (run against a throwaway database)
└── docs/                 architecture, security and operations notes
```

## 3. Quick start

```bash
# 1. Unpack into the folder that will become the installation
sudo mkdir -p /opt/myplatform && cd /opt/myplatform
sudo unzip /path/to/foundation-<date>.zip

# 2. Make your decisions
sudo nano .env/setup.env        # product name, domain, edge mode, ports...
sudo nano .env/secrets.env      # Cloudflare token / Turnstile keys, as your choices require

# 3. Validate. This changes nothing.
sudo ./setup.sh check

# 4. Install
sudo ./setup.sh install --install-packages            # add --with-demo for sample data

# 5. First sign-in
sudo cat runtime/config/secrets/initial-owner.txt
```

Open `https://platform.<your domain>`, sign in as the owner and enrol a
security key when asked. After that, delete `initial-owner.txt`.

## 4. The `.env` folder

### `.env/setup.env` (decisions, no secrets)

| Section | Keys | Notes |
|---|---|---|
| Identity | `PRODUCT_NAME`, `APP_SLUG`, `ROOT_DOMAIN`, `PLATFORM_SUBDOMAIN`, `PUBLIC_SUBDOMAIN`, `CONTACT_EMAIL`, `BRAND_TAGLINE`, `BRAND_DESCRIPTION` | `APP_SLUG` names the system users, units and directories. Both subdomains are reserved so no tenant can claim them. |
| Owner | `OWNER_USERNAME`, `OWNER_DISPLAY_NAME` | Created on the first install only, with a generated password. |
| Edge | `EDGE_MODE`, `CLOUDFLARE_TUNNEL_NAME`, `LOGIN_CHALLENGE` | See section 5. |
| Defaults | `DEFAULT_CONNECTION_TIER`, `SHARED_STATE_BACKEND`, `ENABLE_INTEGRATIONS`, `TENANT_EDGE_VERIFY` | All of these can be changed later in the admin panel, except the state backend. |
| Locations | `BACKUP_DIR` | Optional. Leave it empty to use `./backups`. Everything else is fixed inside the folder. |
| Software | `PG_VERSION`, `NODE_MAJOR`, `NODE_BIN` | Node.js comes from `./runtime/node`, or from `node` on the PATH. |
| Ports | `POSTGRES_PORT`, `PGBOUNCER_*_PORT`, `LANDING_PORT`, `PLATFORM_PORT`, `PUBLIC_PORT`, `TENANT_PORT` | All ports bind to 127.0.0.1 only. |
| Operations | `BACKUP_SCHEDULE`, `BACKUP_RETENTION_DAYS`, `BACKUP_INCLUDE_STORAGE`, `HEALTHCHECK_INTERVAL` | |

### `.env/secrets.env` (credentials you already have)

The file ships blank. If you keep this folder in git, never commit it after
filling it in: keep your copy as `.env/secrets.env.local` (ignored) and copy it
into place on the server.

| Key | Needed when |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | `EDGE_MODE=cloudflare-api`. The token needs these permissions: *Account › Cloudflare Tunnel › Edit*, *Account › Turnstile › Edit* and *Zone › DNS › Edit*. |
| `CLOUDFLARE_TUNNEL_TOKEN` | `EDGE_MODE=cloudflare-token` |
| `TURNSTILE_{PLATFORM,PUBLIC,TENANT}_{SITE,SECRET}_KEY` | `LOGIN_CHALLENGE=turnstile` with an edge mode other than `cloudflare-api`. The tenant widget must allow `ROOT_DOMAIN`. |
| `NOTIFICATION_WEBHOOK_URL`, `NOTIFICATION_WEBHOOK_SECRET` | Optional. Invitation links are POSTed to this relay as signed JSON. |

### What the installer generates

Nothing generated is ever written into `.env/`. Install also restricts `.env/`
to root, so the service accounts cannot read your credentials.
`runtime/config/secrets/` is readable by root only. It holds:

- `generated.env`: database role passwords, PgBouncer admin/stats passwords, the tenant session secret and the integration sealing key
- `backup.key`: the backup encryption key
- `cloudflare.json` and `tunnel.token`: in the Cloudflare modes
- `initial-owner.txt` and `demo-tenant.txt`

Service environment files are in `runtime/config/env/*.env`, also root only.
systemd reads them when it starts each service.

**Copy `backup.key` and `generated.env` off the server.** Without
`backup.key`, backups cannot be decrypted. Without `INTEGRATION_SECRET_KEY`,
stored tenant integration credentials cannot be unsealed.

## 5. Public edge modes

**`cloudflare-api` (recommended, fully automatic).** The installer creates or
updates the following:

- a remotely-managed tunnel `<CLOUDFLARE_TUNNEL_NAME>`
- proxied DNS records for the apex, `www`, the platform and public hosts, and `*`
- three Turnstile widgets

Existing DNS records for those names that are not tunnel CNAMEs stop the
install. Remove them, or set `CLOUDFLARE_REPLACE_DNS=true` in `setup.env` to
have them replaced. The admin panel's DNS page uses the same API token.

**`cloudflare-token`.** Runs an existing tunnel. Add these public hostnames to
it in the Cloudflare dashboard:

| Hostname | Service |
|---|---|
| `ROOT_DOMAIN`, `www.ROOT_DOMAIN` | `http://127.0.0.1:LANDING_PORT` |
| `PLATFORM_SUBDOMAIN.ROOT_DOMAIN` | `http://127.0.0.1:PLATFORM_PORT` |
| `PUBLIC_SUBDOMAIN.ROOT_DOMAIN` | `http://127.0.0.1:PUBLIC_PORT` |
| `*.ROOT_DOMAIN` | `http://127.0.0.1:TENANT_PORT` |

**`none`.** No tunnel. Use your own TLS reverse proxy with the same mapping,
with a wildcard certificate for `*.ROOT_DOMAIN`. Forward the `Host` header
unchanged. HTTPS is mandatory, because security keys (WebAuthn) and secure
cookies do not work over plain HTTP. Here is an example for Caddy:

```
example.com, www.example.com { reverse_proxy 127.0.0.1:3651 }
platform.example.com         { reverse_proxy 127.0.0.1:3656 }
user.example.com             { reverse_proxy 127.0.0.1:3657 }
*.example.com                { tls { dns <provider> } reverse_proxy 127.0.0.1:6355 }
```

**`LOGIN_CHALLENGE=none`** removes the Turnstile widget from all sign-in pages.
Throttling and rate limits still apply. Use it only for private sandboxes.

## 6. Commands

```
sudo ./setup.sh check                 validate .env/ and the host, show the plan
sudo ./setup.sh install [options]     install, or upgrade in place
sudo ./setup.sh status                services, database, tenants, backups, health
sudo ./setup.sh demo                  add demo individuals and a demo tenant
sudo ./setup.sh owner-password        new password for OWNER_USERNAME (ends its sessions)
sudo ./setup.sh backup                encrypted backup now
sudo ./setup.sh logs [service]        follow logs (platform, tenant, provisioner, postgresql, ...)
./setup.sh test                       test suite against a throwaway database
sudo ./setup.sh uninstall             remove services and system users; keep ./runtime
sudo ./setup.sh uninstall --purge     also delete ./runtime, dependencies and builds, so the
                                      folder is back to its unzipped state (./backups kept)
./setup.sh package                    write a clean zip of this folder next to it

Options: --install-packages  --with-demo  --debug  --yes
```

### Progress and debug output

Every run prints numbered steps (`[5/15] Dependencies`), a timestamped line for
each action, and a ✓ with the duration when each step finishes. The full
record goes to `runtime/logs/setup-<timestamp>.log`, or to
`/tmp/platform-setup-*.log` before that directory exists. The log never
contains passwords.

- `--debug` streams every command's output live.
- On failure, the script shows the step, the failing action, the last lines of
  output and the log path.
- After a fix, re-run the same command. Completed work is detected and skipped.

### What `install` does

| Step | What happens |
|---|---|
| 1. Validate | Checks `.env/`, the OS, systemd, the folder's location and port conflicts, and shows the plan. |
| 2. Packages | Installs PostgreSQL, PgBouncer and cloudflared from the OS repositories if they are missing, and downloads Node.js into `./runtime/node` after checking its checksum (only with `--install-packages`). |
| 3. Users and directories | Creates the system users `<slug>-{landing,platform,public,tenant,provisioner,pgbouncer,cloudflared}` and `./runtime/` with least-privilege modes. |
| 4. Secrets | Generates any missing secrets. Existing secrets are always reused. |
| 5. Dependencies | Makes the code read-only for the services and runs `npm ci` in place (skipped if the lockfile is unchanged). |
| 6. Edge | Provisions the Cloudflare tunnel, DNS and Turnstile, or configures the chosen mode. |
| 7. Build | Builds the backends and the four frontends with your brand and keys. |
| 8. PostgreSQL | `initdb` for a dedicated cluster on `127.0.0.1:POSTGRES_PORT`, managed by the `<slug>-postgresql` unit. |
| 9. Database | Creates `platform_db` and applies all migrations (checksummed ledger). Sets runtime role passwords as SCRAM verifiers, then applies platform settings: product name, public origin, reserved subdomains, default tier and integrations. |
| 10. PgBouncer | Three pools (platform, public, tenant) that share the SCRAM verifiers. |
| 11. Service config | Writes per-service environment files. |
| 12. Services | Starts all services and waits until each one answers. Upgrades existing tenant schemas. |
| 13. Owner | Creates the first platform owner (first install only). |
| 14. Timers | Enables the daily encrypted backup and the periodic health check. |
| 15. Demo | Adds 100 sample individuals and a `demo` tenant, provisioned through the real pipeline, with a one-time owner invitation link (only with `--with-demo`). |

### Upgrading

Copy the new code over the folder while keeping `.env/`, `runtime/` and
`backups/`. For example, unzip the new package somewhere else, then run:

```bash
sudo rsync -a --exclude .env --exclude runtime --exclude backups /tmp/new/ /opt/myplatform/
sudo ./setup.sh install
```

The upgrade:

- rebuilds only what changed
- applies new platform migrations
- upgrades every tenant schema
- restarts the services

Secrets, data, tenants and tenant PgBouncer entries are preserved. You can
also run tenant schema upgrades per tenant from the admin panel.

## 7. After installation

- **Create tenants:** *Platform console › Tenants › New*. The worker runs about
  20 steps: schema, role, grants, storage, domain and verification. The
  owner receives a one-time invitation link.
- **Configuration:** *Platform console › Configuration* controls features,
  limits, branding, tiers and integrations. Settings apply at the platform,
  plan or tenant level.
- **Bring-your-own storage or database:** tenants (or operators) add an
  S3-compatible bucket or an external PostgreSQL, run **Test** and then
  **Activate**. The worker relocates the data. By default everything stays
  on this server.
- **Operators:** invite additional operators from the console. Security-key
  step-up protects sensitive actions.

## 8. Backups and restore

`<slug>-backup.timer` runs `scripts/backup-platform-db.sh` on
`BACKUP_SCHEDULE`. Each backup is a single AES-256 encrypted archive,
`backups/platform-backup-<timestamp>.tar.gz.enc`, containing:

- the roles and a full database dump
- tenant credential files and the PgBouncer tenant auth file
- tenant storage (optional)
- a SHA-256 manifest

Backups older than `BACKUP_RETENTION_DAYS` are removed.

Decrypt a backup:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in platform-backup-<ts>.tar.gz.enc \
  -pass file:runtime/config/secrets/backup.key | tar -xz -C /tmp/restore
```

`scripts/validate-backup-restore.sh` restores a backup into a throwaway
cluster and verifies the tenant schemas and isolation. Run it regularly. See
`docs/operations/robustness-runbook.md` for the full recovery procedure.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `check` reports a busy port | Change the port in `setup.env`, or stop the other program. |
| `check` says service accounts cannot reach the folder | Move the folder to `/opt` or `/srv`, or make each listed parent traversable (`chmod o+x`). |
| `APP_SLUG ... is already installed from <other folder>` | Give this folder its own `APP_SLUG` and ports, or uninstall the other one from its own folder. |
| A service does not start | `sudo ./setup.sh logs <service>` or `journalctl -u <slug>-<service> -n 100` |
| Cloudflare step fails with DNS conflicts | Remove the listed records, or set `CLOUDFLARE_REPLACE_DNS=true`. |
| Tenant stuck in *provisioning* | Open the tenant in *Console › Tenants* and check its Jobs tab for the failed step, then `logs provisioner`. Retry from the console. |
| Edge verification fails with `EDGE_MODE=none` | Keep `TENANT_EDGE_VERIFY=auto` (off without the Cloudflare API), or make sure your proxy serves the wildcard. |
| Lost owner password | `sudo ./setup.sh owner-password` |
| Start over from scratch | `sudo ./setup.sh uninstall --purge`, then `install` again. |
| Anything else | Re-run with `--debug`, and read the `runtime/logs/setup-*.log` of the failed run. |

## 10. Development and tests

```bash
./setup.sh test         # needs Node.js 22+ and PostgreSQL server binaries;
                        # runs npm ci and the backend build first if needed
./setup.sh package      # clean zip for distribution (see below)
```

The test harness (`scripts/with-test-cluster.sh`) creates a temporary cluster,
applies the migrations and provisions two fixture tenants (`alpha` and `beta`
on `sandbox.test`) through the real pipeline. It then runs the unit and
integration suites and removes everything afterwards.

### Packaging

`./setup.sh package` writes `../<folder>-<timestamp>.zip`, which contains
exactly what a new installation needs. It leaves out `runtime/`, `backups/`,
`node_modules/`, builds and logs, and every value in `.env/secrets.env` is
blanked. Your `.env/setup.env` decisions are kept. It works whether or not
the folder is installed, and it does not change the folder.
