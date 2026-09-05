#!/usr/bin/env bash
#
# install.sh — Replicate the Genie server setup on a fresh Ubuntu 24.04 machine.
#
# Reproduces the reference box documented in /opt/project/README.md:
#   Node 20 · PostgreSQL 17 · nginx · tmux · Claude Code CLI · the admin
#   Next.js dashboard (systemd: PROD `next start` at /admin on :3002 and an
#   on-demand DEV `next dev` at /admin-dev on :3003, both behind nginx :3000),
#   the genie-stats publisher, and (optional) code-server.
#
# Idempotent: safe to re-run. Every step checks current state first.
#
# Usage:
#   sudo ./deploy/install.sh                 # clone from GitHub, generate secrets
#   sudo SOURCE_DIR=/path/to/repo ./deploy/install.sh   # copy a local tree instead of git clone
#
# Configure via environment variables (all optional — sane defaults below):
#   GENIE_USER          Unix user that owns/runs everything      (default: genie)
#   REPO_URL            Git repo to clone if no SOURCE_DIR        (default: https://github.com/paulbrie/genie-local.git)
#   SOURCE_DIR          Copy this local tree instead of cloning   (default: unset)
#   INSTALL_DIR         Where the tree lives                      (default: /opt/project)
#   PUBLIC_HOST         Public hostname for nginx/APP_PUBLIC_HOSTS. If unset, an
#                       interactive setup UI is served at the domain root: it
#                       collects the host from the URL you open, then streams
#                       live install progress until admin is ready. Nothing is
#                       hardcoded.
#   DB_NAME / DB_USER / DB_PASSWORD   Postgres db/role/password   (password: generated if unset)
#   ADMIN_USER / ADMIN_PASSWORD       Dashboard login            (password: generated if unset)
#   GENIE_VPS_TOKEN     Bearer token for the genie-* MCP servers  (default: placeholder)
#   INSTALL_CODE_SERVER=1   Also install code-server              (default: 1)
#   START_SERVICES=1        Enable + start systemd units          (default: 1)
#   RUN_MIGRATIONS=1        Run drizzle migrations                (default: 1)
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
GENIE_USER="${GENIE_USER:-genie}"
REPO_URL="${REPO_URL:-https://github.com/paulbrie/genie-local.git}"
SOURCE_DIR="${SOURCE_DIR:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/project}"
# No default: the setup wizard (below) collects it from the URL the operator
# opens, unless PUBLIC_HOST is provided here for a non-interactive install.
PUBLIC_HOST="${PUBLIC_HOST:-}"
# The public/exposed port nginx listens on (the edge routes the domain here), and
# the internal port the setup UI runs on (nginx proxies the domain root -> it
# during install; the app then takes over). 3001 is otherwise unused.
SETUP_PORT_PUBLIC="${SETUP_PORT_PUBLIC:-3000}"
SETUP_PORT="${SETUP_PORT:-3001}"
# Where install.sh publishes live progress the setup UI streams to the browser.
SETUP_DIR="${SETUP_DIR:-/tmp/genie-setup}"
SETUP_PROGRESS="$SETUP_DIR/progress"
SETUP_UI=0          # set to 1 when the interactive setup UI is running
WIZ_PID=""          # setup-server pid (when SETUP_UI=1)

DB_NAME="${DB_NAME:-admin_dashboard}"
DB_USER="${DB_USER:-admin_app}"
DB_PASSWORD="${DB_PASSWORD:-}"

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

GENIE_VPS_TOKEN="${GENIE_VPS_TOKEN:-REPLACE_WITH_GENIE_VPS_TOKEN}"

PG_MAJOR="${PG_MAJOR:-17}"   # reference box runs 17 (from the PGDG apt repo)
INSTALL_CODE_SERVER="${INSTALL_CODE_SERVER:-1}"
START_SERVICES="${START_SERVICES:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"

NODE_MAJOR=20

# Directory this script lives in (so we can find vendor/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Run a command as the genie user, from a given cwd.
as_genie() {
  local dir="$1"; shift
  sudo -u "$GENIE_USER" -H bash -lc "cd '$dir' && $*"
}

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "Run as root (use sudo)."
  fi
}

gen_secret() { openssl rand -hex 32; }
gen_pw()     { openssl rand -base64 18 | tr -d '/+=' | cut -c1-24; }

# Publish a stage state ("key|state") for the setup UI to stream to the browser.
# No-op unless the interactive UI is running. states: running | done | failed.
stage() {
  [[ "$SETUP_UI" == "1" ]] || return 0
  mkdir -p "$SETUP_DIR"
  printf '%s|%s\n' "$1" "$2" >> "$SETUP_PROGRESS"
}
CURRENT_STAGE=""
begin_stage() { CURRENT_STAGE="$1"; stage "$1" running; }
end_stage()   { stage "$1" done; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
need_root
log "Preflight checks"
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "Not Ubuntu (ID=$ID); proceeding anyway."
  [[ "${VERSION_ID:-}" == "24.04" ]] || warn "Expected Ubuntu 24.04, found ${VERSION_ID:-unknown}; proceeding."
fi
export DEBIAN_FRONTEND=noninteractive
ok "root, os=${ID:-?} ${VERSION_ID:-?}"

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------
log "Installing base packages (apt)"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git tmux openssl sudo lsb-release \
  nginx build-essential >/dev/null
ok "nginx present, tmux $(tmux -V | awk '{print $2}')"

# PostgreSQL from the PGDG repo (Ubuntu 24.04's default repo ships 16; the
# reference box runs $PG_MAJOR). Falls back to the distro package if PGDG fails.
log "Installing PostgreSQL $PG_MAJOR (PGDG repo)"
if command -v psql >/dev/null && psql --version | grep -q " $PG_MAJOR\."; then
  ok "PostgreSQL $(psql --version | awk '{print $3}') already present"
else
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc 2>/dev/null || true
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  if apt-get update -qq 2>/dev/null && \
     apt-get install -y -qq "postgresql-$PG_MAJOR" "postgresql-contrib-$PG_MAJOR" >/dev/null 2>&1; then
    ok "PostgreSQL $(psql --version | awk '{print $3}') (PGDG)"
  else
    warn "PGDG install failed; falling back to distro postgresql."
    rm -f /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql postgresql-contrib >/dev/null
    ok "PostgreSQL $(psql --version | awk '{print $3}') (distro)"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Node.js 20 (NodeSource)
# ---------------------------------------------------------------------------
log "Installing Node.js ${NODE_MAJOR}.x"
if command -v node >/dev/null && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
  ok "Node $(node -v) already present"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v), npm $(npm -v)"
fi

# ---------------------------------------------------------------------------
# 2b. Setup UI — bring nginx up now, serve the setup page at the domain root
# ---------------------------------------------------------------------------
# Nothing about the public domain is hardcoded. We stand nginx up immediately on
# the public port, proxying the domain ROOT to a small setup server on :3001.
# Opening the box's public URL shows the setup page: it auto-detects the host,
# and once confirmed the SAME page streams live install progress until admin is
# ready — at which point nginx flips the root to /admin and the setup server is
# retired. Skipped entirely when PUBLIC_HOST is supplied (unattended installs).
HOST_FILE="$SETUP_DIR/host"
if [[ -z "$PUBLIC_HOST" ]]; then
  SETUP_UI=1
  log "Bringing up the setup UI (nginx :$SETUP_PORT_PUBLIC → setup server :$SETUP_PORT)"
  rm -rf "$SETUP_DIR"; mkdir -p "$SETUP_DIR"

  # Temporary nginx: the whole domain root proxies to the setup server. Swapped
  # for the real admin vhost at the end (see the handoff after services start).
  cat > /etc/nginx/sites-available/genie-setup <<EOF
# TEMPORARY — active only during install; replaced by ft-admin at the end.
server {
    listen $SETUP_PORT_PUBLIC;
    listen [::]:$SETUP_PORT_PUBLIC;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:$SETUP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_buffering off;            # stream progress updates immediately
    }
}
EOF
  ln -sf /etc/nginx/sites-available/genie-setup /etc/nginx/sites-enabled/genie-setup
  rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/ft-admin
  nginx -t >/dev/null 2>&1 && { systemctl restart nginx || systemctl start nginx; } \
    || die "temporary setup nginx config failed to validate."

  # Start the setup server (stays up for the whole install; retired at the end).
  SETUP_HOST_FILE="$HOST_FILE" SETUP_PROGRESS_FILE="$SETUP_PROGRESS" SETUP_PORT="$SETUP_PORT" \
    node "$SCRIPT_DIR/setup-server.mjs" &
  WIZ_PID=$!
  sleep 1
  kill -0 "$WIZ_PID" 2>/dev/null || die "setup server failed to start on :$SETUP_PORT."
  stage host running
  echo
  warn "ACTION REQUIRED: open this box's public URL in a browser and confirm the host."
  warn "  e.g. https://<your-domain>/  — then leave the page open to watch progress."
  echo
  # Wait (up to 1h) for the operator to confirm; the setup server writes the host.
  for _ in $(seq 1 3600); do
    [[ -s "$HOST_FILE" ]] && break
    kill -0 "$WIZ_PID" 2>/dev/null || break
    sleep 1
  done
  PUBLIC_HOST="$(tr -d '[:space:]' < "$HOST_FILE" 2>/dev/null || true)"
  [[ -n "$PUBLIC_HOST" ]] || die "Setup UI did not capture a public host (timed out?)."
  stage host done
  ok "public host confirmed: $PUBLIC_HOST"
else
  ok "public host provided: $PUBLIC_HOST (setup UI skipped)"
fi

# Emit "failed" for whatever stage was running, keep the setup UI up so the
# operator sees where it broke, and exit. Wired to ERR while SETUP_UI is on.
setup_fail() {
  local rc=$?
  stage "${CURRENT_STAGE:-install}" failed
  warn "install failed at stage '${CURRENT_STAGE:-?}' (exit $rc) — the setup page shows the error."
  exit "$rc"
}
if [[ "$SETUP_UI" == "1" ]]; then trap setup_fail ERR; fi

# ---------------------------------------------------------------------------
# 3. genie user
# ---------------------------------------------------------------------------
log "Ensuring user '$GENIE_USER'"
if id "$GENIE_USER" >/dev/null 2>&1; then
  ok "user '$GENIE_USER' exists"
else
  adduser --disabled-password --gecos "" "$GENIE_USER"
  usermod -aG sudo "$GENIE_USER"
  ok "created user '$GENIE_USER' (sudo group)"
fi

# ---------------------------------------------------------------------------
# 4. Global npm tooling
# ---------------------------------------------------------------------------
log "Installing global npm packages"
# Claude Code CLI + agent-browser (headless Chrome live view / researcher agent).
npm install -g --silent @anthropic-ai/claude-code agent-browser >/dev/null 2>&1 || \
  warn "Global npm install of claude-code/agent-browser failed (network?); continuing."

# @genie/vps-stats is private — install the vendored copy globally.
STATS_GLOBAL="$(npm root -g)/@genie/vps-stats"
log "Installing vendored @genie/vps-stats"
if [[ -d "$SCRIPT_DIR/vendor/vps-stats" ]]; then
  mkdir -p "$(dirname "$STATS_GLOBAL")"
  rm -rf "$STATS_GLOBAL"
  cp -r "$SCRIPT_DIR/vendor/vps-stats" "$STATS_GLOBAL"
  ok "@genie/vps-stats -> $STATS_GLOBAL"
else
  warn "vendor/vps-stats not found; genie-stats will be skipped."
fi

# ---------------------------------------------------------------------------
# 5. Get the code
# ---------------------------------------------------------------------------
log "Placing the code at $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ -e "$INSTALL_DIR/admin/package.json" ]]; then
  ok "tree already present at $INSTALL_DIR"
elif [[ -n "$SOURCE_DIR" ]]; then
  # Copy a local tree (used for testing the current working copy).
  cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
  ok "copied local tree from $SOURCE_DIR"
else
  # git clone requires an empty target; clone to temp then move contents.
  tmp="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$tmp/repo"
  cp -a "$tmp/repo/." "$INSTALL_DIR/"
  rm -rf "$tmp"
  ok "cloned $REPO_URL"
fi
mkdir -p "$INSTALL_DIR/projects"
chown -R "$GENIE_USER":"$GENIE_USER" "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# 6. npm install for each package
# ---------------------------------------------------------------------------
log "Installing project dependencies (npm install)"
begin_stage deps
for pkg in admin tools tools/local-genie-mcp; do
  if [[ -f "$INSTALL_DIR/$pkg/package.json" ]]; then
    log "  npm install: $pkg"
    as_genie "$INSTALL_DIR/$pkg" "npm install --no-audit --no-fund" >/dev/null
    ok "  deps installed: $pkg"
  fi
done
end_stage deps

# Playwright Chromium (headless UI verification). Use the tools-local, pinned
# playwright-core CLI so the browser matches tools/package.json (not whatever
# `npx playwright` floats to). System libs need root; the browser binary goes
# into the genie user's ~/.cache/ms-playwright.
log "Installing Playwright Chromium"
PW_CLI="$INSTALL_DIR/tools/node_modules/playwright-core/cli.js"
if [[ -f "$PW_CLI" ]]; then
  node "$PW_CLI" install-deps chromium >/dev/null 2>&1 \
    || warn "playwright install-deps failed; Chromium may miss shared libs."
  as_genie "$INSTALL_DIR/tools" "node '$PW_CLI' install chromium" >/dev/null 2>&1 \
    && ok "Chromium installed (~/.cache/ms-playwright)" \
    || warn "Playwright Chromium download failed (network?); UI verification may not work — rerun: cd tools && node $PW_CLI install chromium"
else
  warn "playwright-core not found under tools/; skipping Chromium."
fi

# ---------------------------------------------------------------------------
# 7. PostgreSQL: role + database
# ---------------------------------------------------------------------------
log "Configuring PostgreSQL"
begin_stage db
systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start || true

[[ -n "$DB_PASSWORD" ]] || { DB_PASSWORD="$(gen_pw)"; warn "Generated DB password."; }

role_exists="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER';" 2>/dev/null || true)"
if [[ "$role_exists" == "1" ]]; then
  sudo -u postgres psql -c "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';" >/dev/null
  ok "role '$DB_USER' password set"
else
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';" >/dev/null
  ok "role '$DB_USER' created"
fi

db_exists="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" 2>/dev/null || true)"
if [[ "$db_exists" == "1" ]]; then
  ok "database '$DB_NAME' exists"
else
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
  ok "database '$DB_NAME' created"
fi
end_stage db

# ---------------------------------------------------------------------------
# 8. admin/.env.local
# ---------------------------------------------------------------------------
log "Writing admin/.env.local"
ENV_FILE="$INSTALL_DIR/admin/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env.local exists; leaving it untouched."
else
  [[ -n "$ADMIN_PASSWORD" ]] || { ADMIN_PASSWORD="$(gen_pw)"; warn "Generated ADMIN_PASSWORD."; }
  APP_ENC_KEY="$(gen_secret)"
  cat > "$ENV_FILE" <<EOF
# Generated by deploy/install.sh
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
PROJECTS_ROOT=$INSTALL_DIR/projects
APP_ENC_KEY=$APP_ENC_KEY
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  chown "$GENIE_USER":"$GENIE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env.local written (ADMIN_USER=$ADMIN_USER)"
fi

# ---------------------------------------------------------------------------
# 9. .mcp.json
# ---------------------------------------------------------------------------
log "Writing .mcp.json"
MCP_FILE="$INSTALL_DIR/.mcp.json"
if [[ -f "$MCP_FILE" ]]; then
  warn ".mcp.json exists; leaving it untouched."
else
  cat > "$MCP_FILE" <<EOF
{
  "mcpServers": {
    "local-genie": {
      "command": "node",
      "args": ["$INSTALL_DIR/tools/local-genie-mcp/server.mjs"]
    },
    "genie-tracker":  { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/tracker",  "headers": { "Authorization": "Bearer $GENIE_VPS_TOKEN" } },
    "genie-security": { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/security", "headers": { "Authorization": "Bearer $GENIE_VPS_TOKEN" } },
    "genie-notify":   { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/notify",   "headers": { "Authorization": "Bearer $GENIE_VPS_TOKEN" } },
    "genie-storage":  { "type": "http", "url": "https://api.genie.teleporthq.ai/api/vps/mcp/storage",  "headers": { "Authorization": "Bearer $GENIE_VPS_TOKEN" } }
  }
}
EOF
  chown "$GENIE_USER":"$GENIE_USER" "$MCP_FILE"
  ok ".mcp.json written ($([[ "$GENIE_VPS_TOKEN" == REPLACE_* ]] && echo 'token is a PLACEHOLDER — edit it' || echo 'token set'))"
fi

# ---------------------------------------------------------------------------
# 10. Drizzle migrations
# ---------------------------------------------------------------------------
if [[ "$RUN_MIGRATIONS" == "1" ]]; then
  log "Running database migrations (drizzle)"
  begin_stage migrate
  # drizzle-kit does not auto-load .env.local, so pass DATABASE_URL explicitly.
  # Prefer the value already in .env.local (source of truth across re-runs).
  MIGRATE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  MIGRATE_URL="${MIGRATE_URL:-postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME}"
  if as_genie "$INSTALL_DIR/admin" "DATABASE_URL='$MIGRATE_URL' npm run db:migrate" >/dev/null; then
    ok "migrations applied"; end_stage migrate
  else
    warn "db:migrate failed; run it manually later."; stage migrate failed
  fi
fi

# ---------------------------------------------------------------------------
# 11. systemd units
# ---------------------------------------------------------------------------
log "Installing systemd units"
begin_stage services

cat > /etc/systemd/system/genie-stats.service <<EOF
[Unit]
Description=Genie VM stats publisher
After=network-online.target
ConditionPathExists=$STATS_GLOBAL/dist/daemon.js

[Service]
Type=simple
User=$GENIE_USER
Group=$GENIE_USER
RuntimeDirectory=genie
ExecStart=/usr/bin/node $STATS_GLOBAL/dist/daemon.js --interval 5 --output /run/genie/stats.jsonl
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# admin.service — PRODUCTION instance: serves the built app at /admin on :3002
# via `next start` (reads the .next-prod build). basePath/distDir come from env
# (see next.config.ts). nginx on :3000 fronts it.
cat > /etc/systemd/system/admin.service <<EOF
[Unit]
Description=Projects Supervisor — admin (Next.js PROD, /admin on :3002)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$GENIE_USER
Group=$GENIE_USER
WorkingDirectory=$INSTALL_DIR/admin
Environment=PORT=3002
Environment=APP_PUBLIC_HOSTS=$PUBLIC_HOST
Environment=APP_BASE_PATH=/admin
Environment=NEXT_PUBLIC_BASE_PATH=/admin
Environment=APP_DIST_DIR=.next-prod
ExecStart=/usr/bin/node $INSTALL_DIR/admin/node_modules/next/dist/bin/next start -p 3002 -H 0.0.0.0
# KillMode=process so restarting admin (e.g. on deploy) does NOT kill the
# project dev servers launched from the UI (they live in this unit's cgroup).
KillMode=process
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# admin-dev.service — on-demand DEV instance: hot-reload Next.js at /admin-dev on
# :3003 (own .next-dev distDir so it never clobbers the prod build). NO [Install]
# section: it is started/stopped from the admin UI (admin-ctl), not at boot.
cat > /etc/systemd/system/admin-dev.service <<EOF
[Unit]
Description=Projects Supervisor — admin-dev (Next.js DEV, /admin-dev on :3003)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$GENIE_USER
Group=$GENIE_USER
WorkingDirectory=$INSTALL_DIR/admin
Environment=PORT=3003
Environment=APP_PUBLIC_HOSTS=$PUBLIC_HOST
Environment=APP_BASE_PATH=/admin-dev
Environment=NEXT_PUBLIC_BASE_PATH=/admin-dev
Environment=APP_DIST_DIR=.next-dev
ExecStart=/usr/bin/node $INSTALL_DIR/admin/node_modules/next/dist/bin/next dev -p 3003 -H 0.0.0.0
KillMode=process
Restart=on-failure
RestartSec=3
EOF
ok "genie-stats.service, admin.service (prod :3002), admin-dev.service (dev :3003)"

# admin-ctl — root-owned privileged helper the admin UI runs via a scoped
# NOPASSWD sudoers rule to control the prod/dev services and ship builds. The
# helper hardcodes APP_DIR=/opt/project/admin, so retarget it if INSTALL_DIR
# differs. The sudoers file references the fixed /usr/local/bin/admin-ctl path.
if [[ -f "$INSTALL_DIR/admin/ops/admin-ctl" ]]; then
  sed "s#^APP_DIR=/opt/project/admin#APP_DIR=$INSTALL_DIR/admin#" \
    "$INSTALL_DIR/admin/ops/admin-ctl" > /usr/local/bin/admin-ctl
  chown root:root /usr/local/bin/admin-ctl
  chmod 0755 /usr/local/bin/admin-ctl
  install -o root -g root -m 0440 \
    "$INSTALL_DIR/admin/ops/admin-supervisor.sudoers" /etc/sudoers.d/admin-supervisor
  if visudo -cf /etc/sudoers.d/admin-supervisor >/dev/null 2>&1; then
    ok "admin-ctl + scoped sudoers (genie -> admin-ctl: deploy/dev controls)"
  else
    rm -f /etc/sudoers.d/admin-supervisor
    warn "admin-supervisor sudoers failed validation; removed. UI deploy/dev controls disabled."
  fi
else
  warn "admin/ops/admin-ctl not found; UI deploy/dev controls will be unavailable."
fi

# Per-minute persistent stats sampler (cron). The genie-stats daemon feeds
# /run/genie/stats.jsonl (tmpfs, wiped on reboot); this copies a compact snapshot
# into a persistent file so the admin's activity graph keeps 1d/7d/30d history.
# Installed as the genie user's crontab, idempotently (drop any prior copy first).
STATS_CRON="* * * * * /usr/bin/node $INSTALL_DIR/admin/scripts/stats-history.mjs >/dev/null 2>&1"
if command -v crontab >/dev/null; then
  # `|| true`: on a box with no existing crontab, grep matches nothing and exits
  # 1, which under `set -euo pipefail` would abort the whole installer.
  ( crontab -u "$GENIE_USER" -l 2>/dev/null | grep -v -F "admin/scripts/stats-history.mjs" || true; \
    echo "$STATS_CRON" ) | crontab -u "$GENIE_USER" -
  ok "stats-history sampler cron (every minute, user $GENIE_USER)"
else
  warn "crontab not found; the stats-history graph will have no data. Install cron or schedule scripts/stats-history.mjs yourself."
fi

if [[ "$INSTALL_CODE_SERVER" == "1" ]]; then
  log "Installing code-server"
  if command -v code-server >/dev/null; then
    ok "code-server already present ($(code-server --version 2>/dev/null | head -1 | awk '{print $1}'))"
  else
    curl -fsSL https://code-server.dev/install.sh | sh >/dev/null 2>&1 \
      && ok "code-server installed" \
      || warn "code-server install failed; skipping its service."
  fi
  if command -v code-server >/dev/null; then
    cat > /etc/systemd/system/code-server.service <<EOF
[Unit]
Description=code-server — VS Code in the browser (Genie)
After=network.target

[Service]
Type=simple
User=$GENIE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v code-server) $INSTALL_DIR
Restart=on-failure
RestartSec=5
KillMode=mixed
StandardOutput=append:/var/log/code-server.log
StandardError=append:/var/log/code-server.log

[Install]
WantedBy=multi-user.target
EOF
    ok "code-server.service"
  fi
fi

systemctl daemon-reload

# ---------------------------------------------------------------------------
# 12. nginx
# ---------------------------------------------------------------------------
log "Configuring nginx"

# The $connection_upgrade map (required by the site's WebSocket/HMR handling).
cat > /etc/nginx/conf.d/upgrade-map.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

cat > /etc/nginx/sites-available/ft-admin <<EOF
# Public entrypoint (port 3000 is exposed as https://$PUBLIC_HOST).
server {
    listen 3000;
    listen [::]:3000;
    server_name $PUBLIC_HOST _;
    absolute_redirect off;   # relative redirects -> resolve to public https origin

    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade           \$http_upgrade;
    proxy_set_header Connection        \$connection_upgrade;
    proxy_read_timeout 300s;
    proxy_buffering off;            # let HMR/SSE streams through (dev hot-reload)

    # Admin Next.js app — PROD (basePath /admin) on :3002.
    location /admin {
        proxy_pass http://127.0.0.1:3002;
    }

    # Hot-reload DEV instance (basePath /admin-dev) on :3003. nginx longest-prefix
    # matching sends /admin-dev* here and everything else under /admin* to :3002,
    # so the two never collide. Started on demand from the admin UI (admin-ctl).
    location /admin-dev {
        proxy_pass http://127.0.0.1:3003;
    }

    location = / { return 302 /admin; }

    # Per-app live routes, GENERATED from the admin DB (apps.port).
    # Regenerated + reloaded whenever a port is edited in the admin UI.
    include $INSTALL_DIR/admin/nginx/projects.conf;
}
EOF

# The include target must exist for `nginx -t` to pass.
mkdir -p "$INSTALL_DIR/admin/nginx"
[[ -f "$INSTALL_DIR/admin/nginx/projects.conf" ]] || \
  echo "# GENERATED from the admin DB (apps.port). Empty until a project port is set." \
    > "$INSTALL_DIR/admin/nginx/projects.conf"
chown -R "$GENIE_USER":"$GENIE_USER" "$INSTALL_DIR/admin/nginx"

if [[ "$SETUP_UI" == "1" ]]; then
  # The temporary genie-setup vhost keeps serving the domain root (setup UI) on
  # :3000 for now. ft-admin is enabled at the handoff, once admin is healthy —
  # so the operator watches progress until the very end without a dead window.
  ok "nginx admin vhost prepared (activated at handoff)"
else
  ln -sf /etc/nginx/sites-available/ft-admin /etc/nginx/sites-enabled/ft-admin
  rm -f /etc/nginx/sites-enabled/default   # avoid clashing default server
  if nginx -t >/dev/null 2>&1; then
    ok "nginx config valid"
  else
    nginx -t || true
    warn "nginx config test failed — review above."
  fi
fi
end_stage services

# ---------------------------------------------------------------------------
# 12b. Initial production build (.next-prod)
# ---------------------------------------------------------------------------
# admin.service runs `next start`, which requires a prebuilt app. Produce
# .next-prod with the prod basePath baked in (NEXT_PUBLIC_* is inlined at build
# time). On later deploys the admin UI's Deploy button (admin-ctl) rebuilds this.
# The first build on a fresh box occasionally fails transiently (native
# toolchain warmup under load); a failed/partial build leaves `next start`
# crash-looping, so we log the output, retry once, and verify BUILD_ID exists.
log "Building admin for production (.next-prod)"
begin_stage build
BUILD_LOG=/var/log/genie-admin-build.log
BUILD_ENV="APP_BASE_PATH=/admin NEXT_PUBLIC_BASE_PATH=/admin APP_DIST_DIR=.next-prod NODE_ENV=production"
# Clean stale build dirs first. tsconfig.json includes the sibling instance's
# generated types (.next-dev/.next-prod), so a prod build type-checks whatever
# is on disk — a stale .next-dev (e.g. copied in, or from a prior run) makes
# `next build` fail with TS2307. These dirs are gitignored (a fresh clone has
# none); remove any that a reused tree carries. Leave .next-dev alone if the dev
# instance is actively running (it keeps its own copy fresh).
rm -rf "$INSTALL_DIR/admin/.next" "$INSTALL_DIR/admin/.next-prod"
systemctl is-active --quiet admin-dev.service || rm -rf "$INSTALL_DIR/admin/.next-dev"
build_prod() { as_genie "$INSTALL_DIR/admin" "$BUILD_ENV npm run build" >"$BUILD_LOG" 2>&1; }
built=0
if build_prod; then built=1; else
  warn "next build failed — retrying once (log: $BUILD_LOG)"
  sleep 2
  build_prod && built=1
fi
if [[ "$built" == 1 && -f "$INSTALL_DIR/admin/.next-prod/BUILD_ID" ]]; then
  ok "production build complete (.next-prod)"
  end_stage build
else
  stage build failed
  warn "next build did not produce a usable .next-prod; admin.service (next start)"
  warn "  will crash-loop until it succeeds. Log: $BUILD_LOG"
  warn "  retry: cd $INSTALL_DIR/admin && $BUILD_ENV npm run build"
  # Don't proceed to start a crash-looping admin behind a torn-down setup UI —
  # leave the setup page showing the failed build so the operator can see it.
  [[ "$SETUP_UI" == "1" ]] && { warn "See $BUILD_LOG for the build error."; exit 1; }
fi

# ---------------------------------------------------------------------------
# 13. Enable + start services
# ---------------------------------------------------------------------------
if [[ "$START_SERVICES" == "1" ]]; then
  log "Enabling and starting services"
  begin_stage start
  # admin-dev.service is intentionally NOT enabled/started here: it has no
  # [Install] section and is launched on demand from the admin UI (admin-ctl).
  UNITS=(admin.service)
  [[ -f "$STATS_GLOBAL/dist/daemon.js" ]] && UNITS+=(genie-stats.service)
  [[ -f /etc/systemd/system/code-server.service ]] && UNITS+=(code-server.service)
  systemctl enable "${UNITS[@]}" >/dev/null 2>&1 || true
  systemctl restart "${UNITS[@]}" || warn "Some services failed to start; check journalctl."

  # Wait for the prod app (:3002) to actually serve before declaring readiness.
  admin_ready=0
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/admin/login 2>/dev/null || true)"
    [[ "$code" == "200" || "$code" == "307" || "$code" == "302" ]] && { admin_ready=1; break; }
    sleep 2
  done
  if [[ "$admin_ready" == 1 ]]; then ok "admin is serving on :3002"; end_stage start
  else warn "admin.service did not become ready on :3002 (see journalctl -u admin.service)"; stage start failed; fi

  # Handoff: flip nginx from the setup UI to the admin vhost, then retire the
  # setup server. The setup page detects the swap (its status endpoint goes away)
  # and redirects the operator to /admin. Non-UI installs just (re)load nginx.
  if [[ "$SETUP_UI" == "1" ]]; then
    if [[ "$admin_ready" != 1 ]]; then
      # Don't tear down the setup UI onto a dead admin — leave it up showing the
      # failed 'start' stage so the operator can see and diagnose it.
      warn "admin did not come up; leaving the setup UI showing the failure."
      exit 1
    fi
    stage ready done
    sleep 2   # let the setup page render the final "ready" state before the swap
    ln -sf /etc/nginx/sites-available/ft-admin /etc/nginx/sites-enabled/ft-admin
    rm -f /etc/nginx/sites-enabled/genie-setup
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || systemctl restart nginx || true
      ok "nginx now serves /admin — setup UI retired"
    else
      nginx -t || true; warn "final nginx config failed to validate; leaving setup UI up."
    fi
    [[ -n "$WIZ_PID" ]] && kill "$WIZ_PID" >/dev/null 2>&1 || true
    rm -f /etc/nginx/sites-available/genie-setup
    trap - ERR   # install succeeded; drop the setup-failure handler
  else
    systemctl reload nginx 2>/dev/null || systemctl restart nginx || true
  fi
  ok "started: ${UNITS[*]}"
else
  warn "START_SERVICES=0 — units installed but not started."
fi

# ---------------------------------------------------------------------------
# 14. Summary
# ---------------------------------------------------------------------------
echo
log "Setup complete."
cat <<EOF

  Install dir : $INSTALL_DIR
  Run as user : $GENIE_USER
  Public host : $PUBLIC_HOST
  DB          : postgresql://$DB_USER:***@localhost:5432/$DB_NAME
  Admin login : $ADMIN_USER / (see admin/.env.local)

  Admin URLs  : /admin      → PROD (next start, :3002, .next-prod)
                /admin-dev  → DEV  (next dev,  :3003) — start via the UI/admin-ctl

  Verify:
    systemctl is-active admin.service genie-stats.service postgresql nginx
    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/            # -> 302
    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/admin/login # -> 200
    sudo -u $GENIE_USER sudo -n admin-ctl status                               # prod/dev/deploy
    sudo -u $GENIE_USER sudo -n admin-ctl dev-start                            # bring up /admin-dev

  Secrets written to: $INSTALL_DIR/admin/.env.local  (chmod 600)
  MCP token:          edit $INSTALL_DIR/.mcp.json if it says REPLACE_WITH_...
EOF
