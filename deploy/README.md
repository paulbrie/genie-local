# deploy/ — replicate the Genie server on a fresh Ubuntu 24.04 box

Reproduces the reference server documented in the top-level [`README.md`](../README.md):
Node 20, PostgreSQL 17 (PGDG), nginx, tmux, the Claude Code CLI, the **admin**
Next.js dashboard (systemd, `next dev` on :3001 behind nginx :3000), the
`genie-stats` publisher, and (optionally) code-server.

## Files

| File | What it does |
|------|--------------|
| `install.sh` | The installer. Idempotent — safe to re-run. |
| `test-docker.sh` | Builds a systemd-enabled Ubuntu 24.04 container and runs `install.sh` against it, then verifies HTTP + services. |
| `vendor/vps-stats/` | The private `@genie/vps-stats` package (not on npm), installed globally by the script. |

## Install on a real server

```bash
sudo ./deploy/install.sh
```

It clones the repo to `/opt/project`, generates secrets into
`admin/.env.local` (chmod 600), creates the Postgres role/db, runs Drizzle
migrations, installs the systemd units + nginx site, and starts everything.

Configure via env vars (all optional — see the header of `install.sh`):

```bash
sudo PUBLIC_HOST=my.host.example \
     ADMIN_USER=admin ADMIN_PASSWORD=... \
     DB_PASSWORD=... GENIE_VPS_TOKEN=... \
     ./deploy/install.sh
```

Key knobs: `GENIE_USER`, `REPO_URL`, `SOURCE_DIR` (copy a local tree instead of
cloning), `INSTALL_DIR`, `PG_MAJOR`, `INSTALL_CODE_SERVER`, `START_SERVICES`,
`RUN_MIGRATIONS`.

After it finishes, edit `/opt/project/.mcp.json` and replace
`REPLACE_WITH_GENIE_VPS_TOKEN` with the server's real Genie API token.

## Test in Docker

```bash
./deploy/test-docker.sh
```

Requires a Docker daemon with cgroup v2 (the script runs a **privileged**
systemd container so `systemctl enable --now` behaves like a real box). It
copies the current working tree in as `SOURCE_DIR` (so it tests *your* code, not
GitHub), runs the installer, and checks:

- `postgresql`, `nginx`, `admin.service`, `genie-stats.service` are `active`
- `GET /` → 302, `GET /admin/login` → 200 (Next dev compiles and serves)
- `/run/genie/stats.jsonl` is being written

The container is left running as `genie-install-test` for inspection
(`docker exec -it genie-install-test bash`). Set `INSTALL_CODE_SERVER=1` to also
exercise the code-server install.

### Verified

A full clean run provisions PostgreSQL 17.11, Node v20.20.2, applies all Drizzle
migrations (7 tables), and brings every service up with the HTTP checks passing.

> **Note:** the Playwright Chromium *binary* download needs outbound access to
> the Playwright CDN. In a network-restricted sandbox that step warns and is
> skipped (non-fatal); rerun it later with
> `cd /opt/project/tools && node node_modules/playwright-core/cli.js install chromium`.
