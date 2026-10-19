# Platform Foundation

A ready-made base for multi-tenant SaaS products. Install it on one Linux
server with a single script and you get:

| Part | Where | What it gives you |
|---|---|---|
| **Operator console** | `platform.<your domain>` | Tenants, plans, configuration, operators, domains, server health, audit log, schema upgrades. Security-key sign-in |
| **Tenant workspaces** | `<tenant>.<your domain>` | One per organisation, with its own isolated database schema: users and roles, departments and groups, files, audit trail, settings, a first-login setup wizard |
| **Shared sign-in** | `app.<your domain>` | Users sign in with company, username and password, without knowing their tenant's address |
| **Individual-user app** | `user.<your domain>` | Accounts for individuals (B2C), with plans |
| **Landing page** | `<your domain>` | A generic public home page |
| **Operations** | on the server | PostgreSQL with connection pools, a provisioning worker, encrypted daily backups, health checks, an optional Cloudflare Tunnel |

The repository contains **no product features and no customer data**. You
add your product as **modules**: tables, routes and screens that plug in
without touching the security code, and that operators switch on per tenant
or plan.

| Document | Read it when |
|---|---|
| **This README** | You want to install, run or adapt the platform |
| [`AGENTS.md`](AGENTS.md) | You (or a coding agent) are about to change the code |
| [`stacks.md`](stacks.md) | You want to know which technologies are used, where and why |
| [`docs/architecture/extending-the-foundation.md`](docs/architecture/extending-the-foundation.md) | You are building a module |
| [`docs/operations/robustness-runbook.md`](docs/operations/robustness-runbook.md) | You operate an installation |

---

## How to use

Pick the path that matches what you want to do.

| I want to… | Go to |
|---|---|
| Run the platform on a server | [A. Install on a server](#a-install-on-a-server) |
| Work on the code and run the tests | [B. Develop and test](#b-develop-and-test) |
| Build my own product on it | [C. Make it your product](#c-make-it-your-product) |

### A. Install on a server

You need:
- **A server:** Ubuntu 22.04/24.04 or Debian 12, with root access, 2+ vCPUs,
  4 GB+ RAM and 20 GB+ disk.
- **A domain.** For the automatic setup, its DNS must be on Cloudflare.

1. **Get the code** into the folder that will become the installation. Use
   `/opt` or `/srv`, not `/root`.

   ```bash
   sudo git clone https://github.com/amarjyotibairagi/skeleton_foundation.git /opt/myplatform
   cd /opt/myplatform
   ```

2. **Fill in five settings** in `.env/setup.env`:

   | Setting | Example | Meaning |
   |---|---|---|
   | `PRODUCT_NAME` | `"Acme Cloud"` | Shown on every page |
   | `APP_SLUG` | `acme` | Short name for system users and services |
   | `ROOT_DOMAIN` | `acme.com` | Tenants get `<name>.acme.com` |
   | `OWNER_USERNAME` | `owner` | The first operator account |
   | `EDGE_MODE` | `cloudflare-api` | How the internet reaches the server ([details](#4-public-edge-modes)) |

   With `EDGE_MODE=cloudflare-api`, also put `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` in `.env/secrets.env`. The
   token needs these permissions:
   - *Account › Cloudflare Tunnel › Edit*
   - *Account › Turnstile › Edit*
   - *Zone › DNS › Edit*

   Then protect the file:

   ```bash
   sudo chmod 600 .env/secrets.env
   sudo git update-index --skip-worktree .env/secrets.env   # keep your credentials out of commits
   ```

3. **Check.** This validates the settings and the server and changes nothing:

   ```bash
   sudo ./setup.sh check
   ```

4. **Install.** It takes several minutes, and you can safely re-run it if it stops:

   ```bash
   sudo ./setup.sh install --install-packages    # add --with-demo for sample data
   ```

5. **Sign in.** Read the generated owner password, then open
   `https://platform.<your domain>`:

   ```bash
   sudo cat runtime/config/secrets/initial-owner.txt
   ```

   Enrol a security key when asked, then delete that file. Create your first
   tenant from *Tenants › New tenant*. You set its administrator's login there
   too, so they can sign in at `https://<tenant>.<your domain>` as soon as it
   is ready.

Day to day:

```bash
sudo ./setup.sh status            # services, database, tenants, backups, health
sudo ./setup.sh backup            # encrypted backup now (a daily one runs automatically)
sudo ./setup.sh logs tenant       # follow a service's log
sudo git pull && sudo ./setup.sh install   # upgrade in place: data, secrets and tenants are kept
```

### B. Develop and test

You need Node.js 22+ and the PostgreSQL 16 server binaries (the
`postgresql-16` package). Nothing has to be installed with `setup.sh`.

```bash
git clone https://github.com/amarjyotibairagi/skeleton_foundation.git
cd skeleton_foundation
npm ci
npx playwright install --with-deps chromium   # once: the browser for the UI tests
npm run build
./setup.sh test
```

`./setup.sh test` starts a throwaway PostgreSQL cluster and applies every
migration. It provisions two test tenants through the real pipeline, runs the
unit, integration and browser tests, and deletes everything afterwards.

To run one test file:

```bash
bash scripts/with-test-cluster.sh node --test tests/integration/<file>.test.mjs
```

Before changing code, read [`AGENTS.md`](AGENTS.md): the rules, the map and
step-by-step recipes.

### C. Make it your product

1. **Start your own repository from this one.** Fork it on GitHub, or clone
   it and push to a new remote. Keep this repository as `upstream` to pull
   foundation updates later:

   ```bash
   git remote add upstream https://github.com/amarjyotibairagi/skeleton_foundation.git
   git pull upstream main
   ```

2. **Brand it without code.** The product name, domain and landing-page text
   are settings (`.env/setup.env`). Each tenant's colours, logo and sign-in
   message are set in the console.

3. **Add your features as modules.** A module is:
   - a feature switch, off by default, that operators turn on per tenant or
     plan;
   - tenant tables, with their access declared in one manifest;
   - API routes, given the session, permissions and the tenant's database
     connection;
   - screens in the tenant workspace.

   Follow the recipe in [`AGENTS.md` §5](AGENTS.md#add-a-module); the
   reference module is `backend/tenant/src/modules/delegations.ts`.

4. **Ship.** Push to your repository: CI builds and runs the full test suite.
   On the server, `sudo git pull && sudo ./setup.sh install` applies the new code,
   migrations and tenant schema upgrades.

---

## Repository layout

```
.
├── setup.sh              installer and day-to-day control (check, install, status, backup, test, …)
├── .env/
│   ├── setup.env         every installation decision (no secrets)
│   └── secrets.env       credentials you supply (ships blank)
├── backend/              platform, public and tenant servers (Fastify) and the provisioning worker
├── frontend/             operator console, tenant workspace, individual-user app (React), landing page
├── dependency/           shared packages: server kit, UI kit, Cloudflare and database clients
├── database/
│   ├── migrations/       platform migrations (ordered by manifest.json) and tenant schema versions
│   └── seeds/            optional demo individuals
├── deploy/templates/     systemd units, PgBouncer and PostgreSQL configuration templates
├── scripts/              migrations, operator tools, backup and restore drill, test cluster, installer helpers
├── tests/                unit, integration and browser tests (run against a throwaway database)
├── docs/                 architecture and operations notes
├── AGENTS.md             guide for coding agents and contributors
└── stacks.md             technologies: what, where and why
```

---

# Reference

The rest of this file covers the installer in detail.

## 1. Requirements

- **Server:** Ubuntu 22.04/24.04 or Debian 12 with systemd and root access;
  2+ vCPUs, 4 GB+ RAM, 20 GB+ disk.
- **Domain:** with `EDGE_MODE=cloudflare-api`, its DNS must be on Cloudflare.
- **Internet access** during installation (packages, npm, the Cloudflare
  API).
- **Software:** PostgreSQL 16+, PgBouncer, Node.js 22+ and cloudflared. The
  installer fetches them with `--install-packages`, or you can install them
  beforehand.

## 2. Folder layout of an installation

Everything lives in the folder that holds `setup.sh`:

| Path | Created by install | Contents |
|---|---|---|
| `./` | no | Code, run in place. Install adds `node_modules/` and `dist/` builds |
| `./runtime/config/` | yes | `install.env`, `secrets/` and `env/` (root only), `pgbouncer/` |
| `./runtime/data/` | yes | PostgreSQL cluster, tenant credentials, tenant files |
| `./runtime/logs/` | yes | One log per setup run (services log to the journal) |
| `./runtime/node/` | yes | Node.js, when `--install-packages` downloaded it |
| `./backups/` | yes | Encrypted backups (`BACKUP_DIR` can point elsewhere) |

Outside the folder, install adds only:

- systemd units `/etc/systemd/system/<slug>-*`;
- system users `<slug>-*`;
- PostgreSQL, PgBouncer and cloudflared, from the OS repositories.

`sudo ./setup.sh uninstall --purge` removes all of that and returns the folder
to its original state, keeping `./backups/`. Every directory above the folder
must be traversable by other users, so use `/opt` or `/srv`; `check` says so
if a location cannot be used. To run two installations on one server, give
the folders different `APP_SLUG`s and ports.

## 3. The `.env` folder

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

The file ships blank, and it must never be committed once filled in. In a git
clone, run `git update-index --skip-worktree .env/secrets.env` after editing
it, so git ignores your changes. Alternatively, keep your copy as
`.env/secrets.env.local` (ignored) and copy it into place on the server.
Either way, keep it `chmod 600`.

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

## 4. Public edge modes

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

## 5. Commands

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

From a git clone:

```bash
sudo git pull
sudo ./setup.sh install
```

From a zip, copy the new code over the folder while keeping `.env/`,
`runtime/` and `backups/`:

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

## 6. After installation

- **Create tenants:** *Console › Tenants › New tenant*.
  - **Administrator:** create their login on the spot, email them an
    invitation link, or invite them later from the tenant's page.
  - **Modules and plan:** choose them in the same form.
  - **Provisioning:** the worker runs about 20 steps (schema, role, grants,
    storage, domain, administrator, verification), shown live.
- **Manage a tenant:** open it in *Console › Tenants*. Its tabs cover
  overview and schema upgrade, profile and branding, plan and modules,
  administrator access, storage and data, configuration overrides, and job
  history. Suspend, resume and remove are there too; removing needs the
  subdomain typed and releases it for reuse.
- **Configuration:** *Console › Configuration* controls features,
  limits, branding, tiers and integrations. Settings apply at the platform,
  plan or tenant level.
- **Bring-your-own storage or database:** tenants (or operators) add an
  S3-compatible bucket or an external PostgreSQL, run **Test** and then
  **Activate**. The worker relocates the data. By default everything stays
  on this server.
- **Operators:** invite more operators from *Console › Operators* (owners
  only). Changes, and reading live server data, require a recent
  security-key check; the console asks for one when needed.
- **Tenant users:** a tenant's administrator manages users, categories,
  departments and groups, and a workspace default password from the tenant
  workspace. A first-login wizard walks a new administrator through it.

## 7. Backups and restore

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

Known gap: a backup taken while files are being uploaded can contain a file
without its database row, or the reverse. File writes already take the
shared side of a database lock (`skeleton-local-storage-backup`); the backup
script does not yet hold the exclusive side.

## 8. Troubleshooting

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

## 9. Tests and packaging

```bash
./setup.sh test         # Node.js 22+ and PostgreSQL server binaries; no root and no installation needed.
                        # Installs dependencies and builds the backends and console if they are missing.
./setup.sh package      # a clean zip for distribution (see below)
```

The test harness (`scripts/with-test-cluster.sh`) creates a temporary cluster,
applies the migrations and provisions two fixture tenants (`alpha` and `beta`
on `sandbox.test`) through the real pipeline. It then runs the unit,
integration and browser suites and removes everything afterwards. CI
(`.github/workflows/ci.yml`) runs the same suites through a real PgBouncer and
fails if any test is skipped.

### Packaging a release

`./setup.sh package` writes `../<folder>-<timestamp>.zip`, which contains
exactly what a new installation needs. It leaves out `runtime/`, `backups/`,
`node_modules/`, builds and logs, and every value in `.env/secrets.env` is
blanked. Your `.env/setup.env` decisions are kept. It works whether or not
the folder is installed, and it does not change the folder.
