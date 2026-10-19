# Technology stack

This file lists every technology the foundation uses: **what** it is,
**where** it is used, and **why** it was chosen. The versions are the ones
locked in `package-lock.json` or set as defaults in `.env/setup.env`. Change
them there, not here.

The choices follow from three goals:

1. **Isolation you can prove.** Tenant data stays separated by the database
   itself, not by application code alone.
2. **Few moving parts.** One server, one database, no container platform or
   message broker, and no paid services apart from Cloudflare (which is
   optional).
3. **Readable by people and agents.** One language end to end, explicit SQL,
   and small dependencies.

---

## At a glance

| Layer | Technology | Version |
|---|---|---|
| Language | TypeScript (native compiler) | 7.0.2 |
| Server runtime | Node.js | 22+ (CI and installer default: 24) |
| HTTP framework | Fastify | 5.12 |
| Validation | Zod | 4.4 |
| Password hashing | argon2 (argon2id) | 0.45 |
| Security keys | @simplewebauthn/server | 14.0 |
| Database | PostgreSQL | 16+ |
| Connection pooling | PgBouncer | OS package |
| Database driver | node-postgres (`pg`) | 8.23 |
| Pool factory and schema types | Drizzle ORM | 0.45 |
| UI library | React | 19.2 |
| Build tool | Vite | 7.3 |
| Icons | lucide-react | 1.33 |
| Edge, DNS, bot check | Cloudflare Tunnel, DNS API, Turnstile (`cloudflare` SDK 7.1, `cloudflared`) | optional |
| Process supervision | systemd | OS |
| Tests | `node:test`, Playwright (Chromium) | Node built-in, 1.62 |
| CI | GitHub Actions | ubuntu-24.04 |

---

## Language and runtime

### TypeScript 7 (native compiler)

- **Where:** every backend (`backend/**/src`), the shared packages
  (`dependency/**/src`) and the React frontends. Each workspace builds with
  `tsc -b`; `npm run typecheck` checks the backends and shared packages.
- **Why:** one language from the database layer to the browser, so a person or
  an agent can follow a request end to end. Strict mode catches contract drift
  between a BFF and its frontend. TypeScript 7 is the native (Go)
  implementation, so building every workspace takes seconds rather than
  minutes.
- **Not used:** the landing page (`frontend/landing`) is plain JavaScript and
  CSS. It is static marketing copy and needs no types or framework.

### Node.js 22+ (24 in CI and by default)

- **Where:**
  - the four BFF processes and the provisioner (`node dist/server.js`,
    `node dist/worker.js`);
  - the landing server (`scripts/serve-landing.mjs`);
  - the operational scripts (`scripts/*.mjs`);
  - the test runner.
- **Why:** it runs TypeScript output directly and has a built-in test runner
  (`node:test`) and `fetch`. Version 22 is the oldest line with everything
  used here. The installer can download a checksum-verified Node.js into
  `./runtime/node` (`--install-packages`), so the host needs no system-wide
  Node.js.
- **Development:** `tsx` (4.23) runs a BFF straight from source
  (`npm run dev:platform:bff` and the other `dev:*:bff` scripts).

### npm workspaces

- **Where:** the root `package.json` lists 12 workspaces: 4 backends, 4
  frontends and 4 shared packages. There is one `package-lock.json`.
- **Why:** shared code (`@skeleton/server-kit`, `@skeleton/ui`) is linked
  locally without publishing anything, `npm ci` installs everything
  reproducibly, and there is no extra tool (Lerna, Nx, Turborepo) to learn.

---

## Backend

### Fastify 5

- **Where:**
  - `backend/src/server.ts` (platform BFF, port 3656);
  - `backend/public/src/server.ts` (public BFF, 3657);
  - `backend/tenant/src/server.ts` (tenant BFF, 6355).
- **Why:**
  - **Speed:** it is fast, with low overhead per request.
  - **Typed contracts:** route handlers are typed, and requests pass through
    hooks (`onRequest`, `preHandler`). The tenant BFF uses those hooks to
    resolve the tenant from the `Host` header, gate on schema version and
    lifecycle, and block everything during a forced password change.
  - **Built-in test client:** `app.inject()` drives the real server in tests
    without opening a port, which is how the integration suite and the
    browser tests work.
- **Plugins:**

  | Plugin | Version | Used for |
  |---|---|---|
  | `@fastify/cookie` | 11.1 | `__Host-` session cookies, and the signed company cookie on the shared `app.` host |
  | `@fastify/helmet` | 13.1 | Security headers (CSP, HSTS, frame and referrer policy) |
  | `@fastify/rate-limit` | 11.2 | Per-client-address limits, tighter on sign-in and password routes |
  | `@fastify/static` | 10.1 | Each BFF serves its own frontend's `dist/`, with per-file cache headers |

### BFF pattern (backend for frontend)

- **Where:** each browser application talks only to its own BFF on the same
  origin (`/api/*`).
- **Why:** session cookies stay `HttpOnly` and same-site, CSRF tokens and
  origin checks are simple, and database credentials never reach a browser.
  Each surface (operators, individuals, tenants) has its own process, so a bug
  in one cannot reach another's routes or credentials.

### Zod 4

- **Where:** request bodies and parameters in every BFF, for example
  `backend/src/tenant-provisioning.ts` (subdomain rules, owner details,
  modules) and `backend/tenant/src/modules/*`.
- **Why:** it parses and validates in one step. Invalid input becomes a 400
  before any handler logic runs, and handlers receive typed values.

### Authentication libraries

| Library | Version | Where | Why |
|---|---|---|---|
| `argon2` | 0.45 | Password hashing in all BFFs; `scripts/platform-operator.mjs audit-hashes` checks it | argon2id is memory-hard; CI fails if any operator hash is not argon2id |
| `@simplewebauthn/server` | 14.0 | `backend/src/mfa.ts` (platform operators); browser side in `frontend/platform/src/admin/webauthn.ts` | Phishing-resistant security keys. A key check within the last 5 minutes unlocks privileged actions (step-up) |
| Cloudflare Turnstile | API | `dependency/platform/ServerKit/src/turnstile.ts` (server check); `dependency/ui/src/useTurnstile.ts` and `TurnstileSlot.tsx` (widget) | Bot protection on every sign-in page without a CAPTCHA puzzle. `LOGIN_CHALLENGE=none` turns it off for sandboxes |
| Node `crypto` | built-in | Session tokens, CSRF tokens, invitation tokens (stored hashed), signed cookies, integration secret sealing | No extra dependency for primitives the platform already gets |

### Shared server kit: `@skeleton/server-kit`

- **Where:** `dependency/platform/ServerKit/src`, imported by every BFF and the
  provisioner.
- **What it holds:**

  | File | Responsibility |
  |---|---|
  | `config.ts` | Resolving and validating configuration keys (platform → plan → tenant → tenant-local) |
  | `storage.ts`, `s3.ts` | Local object store, and an S3 client written in-house (Signature V4, path- or virtual-hosted style) |
  | `integrations.ts`, `integration-service.ts` | Bring-your-own storage and database: connection tests and sealed credentials |
  | `network.ts` | Outbound endpoint policy (blocks private addresses unless allowed) |
  | `shared-state.ts` | Throttle and rate-limit state, held in `memory` or in `postgres` |
  | `turnstile.ts`, `invitations.ts`, `security.ts`, `secrets.ts`, `deployment.ts` | Sign-in challenge, invitation tokens, security helpers, secrets, production-only settings |

- **Why an in-house S3 client:** the platform needs only put, get, delete and
  list. A small, audited client covers AWS S3, MinIO, Cloudflare R2, Wasabi,
  Backblaze B2 and Ceph without pulling in the full AWS SDK. Every outbound
  connection also goes through `network.ts`, which blocks requests to
  internal addresses that a tenant-supplied endpoint could otherwise reach.

### Provisioning worker

- **Where:** `backend/provisioner/src` (`worker.ts`, `tenant-migrations.ts`,
  `tenant-operations.ts`). It is a Node process with no HTTP port.
- **Why:** creating, upgrading, moving and removing tenants means DDL,
  credential files and PgBouncer changes. These run as numbered steps in a job
  table (`platform.tenant_provisioning_job`), so any step can fail and be
  retried from where it stopped. They run as their own database role
  (`tenant_provisioner`), separate from the web processes.

---

## Data

### PostgreSQL 16+

- **Where:** one cluster and one database (`platform_db`) holding three kinds
  of schema:

  | Schema | Contents |
  |---|---|
  | `platform` | Operators, tenant registry, jobs, plans, configuration registry, audit |
  | `consumer` | Individual (B2C) users |
  | `tenant_<key>` | One schema per tenant |

- **Why:**
  - **Isolation by the database:** each tenant schema has its own role,
    forced row-level security keyed on `app.tenant_id`, and grants generated
    from `database/migrations/tenant/access-manifest.json`. Isolation does not
    rely on application code alone.
  - **Database-enforced rules:** `SECURITY DEFINER` functions enforce
    platform rules inside the database (for example, at least one active
    owner always remains) and write the audit row in the same transaction.
  - **Migrations:** they are plain SQL, checksummed in a ledger, and applied
    by `scripts/platform-migrate.mjs` (platform) and the provisioner (tenant
    schemas).
  - **Extensions:** only `pgcrypto` and `pg_stat_statements`.
- **Installed by:** `setup.sh`, from the OS repositories, as a dedicated
  cluster on `127.0.0.1:5433` run by a unit called `<slug>-postgresql`.

### PgBouncer

- **Where:** three pools (`platform` on 3658, `public` on 3659, `tenant` on
  6360) using transaction pooling and SCRAM-SHA-256 authentication. Templates
  are in `deploy/templates/pgbouncer`. The provisioner writes tenant login
  verifiers into the tenant pool's auth file.
- **Why:** PostgreSQL connections are expensive. Pooling per trust zone keeps
  the server's connection count bounded, and the *pooled* tenant tier lets
  many small tenants share one login (see
  `docs/architecture/adr-001-tenancy-scaling-tiers.md`).
- **Caveat:** in transaction mode, session state does not survive across
  transactions. All tenant work therefore happens inside one transaction with
  `SET LOCAL` (`kit.withTenant`).

### node-postgres (`pg` 8.23) and Drizzle ORM (0.45)

- **Where:**
  - `pg` runs every query, as **explicit SQL**, in the BFFs, the provisioner
    and the scripts;
  - `@skeleton/drizzle` (`dependency/platform/Drizzle`) provides the
    connection-pool factory (`createDatabaseClient`) and a typed description
    of the platform schema (`schema.ts`).
- **Why explicit SQL:** row-level security, `SET LOCAL ROLE`, advisory locks
  and `SECURITY DEFINER` calls are the core of the security model. Writing
  them by hand keeps every statement visible and reviewable. Drizzle is kept
  for typed schema references and can be used for new, non-tenant queries
  where it helps.

---

## Frontend

### React 19 and Vite 7

- **Where:**

  | App | Path | Dev port |
  |---|---|---|
  | Operator console | `frontend/platform` | 3652 |
  | Individual-user (B2C) app | `frontend/public` | 3653 |
  | Tenant workspace | `frontend/tenant` | 6354 |
  | Landing page (vanilla JS) | `frontend/landing` | 3651 |

  In production each BFF serves its app's build output.
- **Why:**
  - React is widely known by people and coding agents.
  - Vite builds each app in a couple of seconds, with content-hashed asset
    names. Those names make long-term caching safe.
  - The tenant build keeps the previous week's assets after a deploy
    (`keepRecentAssets` in `frontend/tenant/vite.config.ts`), so a tab opened
    before the deploy can still lazy-load.
- **No client router or state library:**
  - The console uses a small hash router (`frontend/platform/src/shell/router.ts`),
    which gives every page an address while staying a single static page.
  - State is plain React state and a small `useResource` hook
    (`frontend/platform/src/admin/ui.tsx`).
  - This keeps the apps small and easy to read.

### Styling: CSS with design tokens, no CSS framework

- **Where:**
  - `frontend/platform/src/theme.css` (console design system: tokens on
    `:root`, a light and a dark theme, and the component classes);
  - `frontend/tenant/src/theme.css`;
  - `frontend/public/src/theme.css`;
  - `dependency/ui/styles.css` (shared).
- **Why:**
  - **Theming:** colours, spacing and radii are custom properties, so a dark
    theme or a tenant accent colour (`--g-brand`) is a change of variables,
    not of components.
  - **Simplicity:** there is no build-time CSS tool and nothing to configure.
- **Fonts:** Fira Sans and Fira Code in the console, Plus Jakarta Sans and
  Instrument Serif in the tenant workspace. They come from Google Fonts, which
  the content security policy allows explicitly.

### lucide-react (1.33)

- **Where:** every React frontend.
- **Why:** one consistent, tree-shaken SVG icon set. No icon fonts and no
  emoji icons.

### Shared UI package: `@skeleton/ui`

- **Where:** `dependency/ui` (`useTurnstile`, `TurnstileSlot`, `MetricCard`,
  base styles).
- **Why:** every sign-in page uses the same Turnstile handling, and its slot
  is a fixed size, so the sign-in card does not change size while the
  challenge loads, runs or resets.

---

## Edge and infrastructure

### Cloudflare (optional)

| Component | Where | Why |
|---|---|---|
| Cloudflare Tunnel (`cloudflared`) | `<slug>-cloudflared` unit; set up by `scripts/foundation/cloudflare.mjs` | Publishes the server without opening inbound ports. TLS and DDoS protection are handled at the edge |
| DNS API (`cloudflare` SDK 7.1) | `scripts/foundation/cloudflare.mjs` (install), `backend/src/server.ts` (console Domains page) | Creates the apex, `www`, platform, user and wildcard records; operators manage platform subdomains from the console |
| Turnstile | All sign-in pages | See the authentication libraries above |

`EDGE_MODE=cloudflare-token` uses an existing tunnel, and `EDGE_MODE=none`
works behind any TLS reverse proxy (Caddy, nginx), so Cloudflare is not
required.

### systemd

- **Where:** templates in `deploy/templates/systemd`, rendered by
  `scripts/foundation/render.mjs` during `setup.sh install`. There is one unit
  per process plus timers for backups and health checks.
- **Why:**
  - **Process supervision** (restart on failure, journal logging) with no
    container runtime.
  - **Per-service hardening:** dedicated system users, `ProtectSystem=strict`,
    `ReadWritePaths` limited to what each service writes, `UMask=0007`, and
    restricted address families.

### Installer: `setup.sh` (Bash)

- **Where:** the repository root.
- **Why:** one command turns a fresh Ubuntu or Debian server into a running
  platform and can be re-run safely. It checks the host, installs packages,
  creates users, generates secrets, builds, initialises the database, starts
  the services and creates the first owner. It also handles status, backups,
  upgrades, uninstall and packaging. All decisions live in `.env/setup.env`;
  everything generated goes to `./runtime`.

### Backups

- **Where:** `scripts/backup-platform-db.sh`, run by the `<slug>-backup`
  timer; `scripts/validate-backup-restore.sh` runs a restore drill.
- **What:** `pg_dumpall --globals-only` and `pg_dump`, plus tenant credential
  files, the PgBouncer auth file and tenant storage. They are packed into one
  archive with a SHA-256 manifest and encrypted with `openssl` (AES-256,
  PBKDF2).
- **Why:** standard PostgreSQL tools give portable dumps. Encrypting with a key
  kept outside the backup directory makes it safe to copy archives off the
  server.

---

## Testing and CI

### `node:test` with a throwaway PostgreSQL cluster

- **Where:** `tests/unit`, `tests/integration`, `tests/fixtures`,
  `tests/helpers`; harness `scripts/with-test-cluster.sh`.
- **How it works:**
  1. `initdb` creates a temporary cluster on a free port.
  2. Every migration is applied.
  3. Two fixture tenants (`alpha`, `beta` on `sandbox.test`) are provisioned
     through the real worker.
  4. The suites run.
  5. Everything is deleted.
- **Why:** tests run against the real database, with real row-level security
  and real provisioning, and nothing is mocked. They never touch an installed
  system.

### Playwright (1.62, Chromium)

- **Where:**
  - `tests/integration/platform-console.test.mjs`: the built console in a real
    browser, with requests routed to `app.inject()`, so it needs no DNS, TLS
    or Turnstile;
  - WebAuthn tests, which use Chrome's virtual authenticator.
- **Why:** it checks real behaviour (navigation, dialogs, layout at phone
  width, the security-key step-up), not just API responses.

### GitHub Actions

- **Where:** `.github/workflows/ci.yml` (Ubuntu 24.04 runner, PostgreSQL 16
  service container, PgBouncer from apt).
- **What runs:**
  - `npm ci`;
  - the full build and typecheck;
  - unit and integration tests (the job fails if any test is skipped);
  - migration ledger verification and the tenant registry check;
  - the argon2id hash audit;
  - the frontend bundle secret scan;
  - a restore drill;
  - `npm audit`.
- **Why:** each class of failure that has happened in production has a gate.
  The actions are pinned to commit SHAs.

---

## Deliberately not used

| Not used | Because |
|---|---|
| Docker or Kubernetes | One server with systemd is simpler to run, secure and back up at this scale. The isolation that matters is inside PostgreSQL |
| A message broker (Redis, RabbitMQ) | The provisioning job table in PostgreSQL is the queue, and it is transactional with the data it changes |
| A full ORM for queries | The security model depends on SQL that must stay visible (RLS, `SET LOCAL ROLE`, advisory locks) |
| A CSS framework or component library | The token-based CSS is small and themeable, and has no build plugin |
| Client-side routing or state libraries | A hash router and plain React state cover the needs |
| Third-party auth (Auth0, Clerk, …) | Sessions, argon2id, WebAuthn and invitations are built in, and no user data leaves the server |
