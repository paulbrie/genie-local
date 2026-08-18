#!/usr/bin/env bash
#
# install.sh — Replicate the Genie server setup on a fresh Ubuntu 24.04 machine.
#
# Reproduces the reference box documented in /opt/project/README.md:
#   Node 20 · PostgreSQL 17 · nginx · tmux · Claude Code CLI · the admin
#   Next.js dashboard (systemd, dev server on :3001 behind nginx :3000),
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
#   PUBLIC_HOST         Public hostname for nginx/allowedDevOrigins (default: ft.cloud.teleporthq.ai)
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
PUBLIC_HOST="${PUBLIC_HOST:-ft.cloud.teleporthq.ai}"

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
for pkg in admin tools tools/local-genie-mcp; do
  if [[ -f "$INSTALL_DIR/$pkg/package.json" ]]; then
    log "  npm install: $pkg"
    as_genie "$INSTALL_DIR/$pkg" "npm install --no-audit --no-fund" >/dev/null
    ok "  deps installed: $pkg"
  fi
done

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
  # drizzle-kit does not auto-load .env.local, so pass DATABASE_URL explicitly.
  # Prefer the value already in .env.local (source of truth across re-runs).
  MIGRATE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  MIGRATE_URL="${MIGRATE_URL:-postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME}"
  as_genie "$INSTALL_DIR/admin" "DATABASE_URL='$MIGRATE_URL' npm run db:migrate" >/dev/null \
    && ok "migrations applied" \
    || warn "db:migrate failed; run it manually later."
fi

# ---------------------------------------------------------------------------
# 11. systemd units
# ---------------------------------------------------------------------------
log "Installing systemd units"

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

cat > /etc/systemd/system/admin.service <<EOF
[Unit]
Description=Projects Supervisor (admin Next.js app — DEV behind nginx on :3001)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$GENIE_USER
Group=$GENIE_USER
WorkingDirectory=$INSTALL_DIR/admin
Environment=PORT=3001
# Dev server (hot-reload) on :3001; nginx on :3000 fronts it.
ExecStart=/usr/bin/node $INSTALL_DIR/admin/node_modules/next/dist/bin/next dev -p 3001 -H 0.0.0.0
# Do NOT kill child processes (project dev servers) when this service restarts.
KillMode=process
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
ok "genie-stats.service, admin.service"

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

    # Admin Next.js app (basePath /admin) on :3001.
    location /admin {
        proxy_pass http://127.0.0.1:3001;
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

ln -sf /etc/nginx/sites-available/ft-admin /etc/nginx/sites-enabled/ft-admin
rm -f /etc/nginx/sites-enabled/default   # avoid clashing default server

if nginx -t >/dev/null 2>&1; then
  ok "nginx config valid"
else
  nginx -t || true
  warn "nginx config test failed — review above."
fi

# ---------------------------------------------------------------------------
# 13. Enable + start services
# ---------------------------------------------------------------------------
if [[ "$START_SERVICES" == "1" ]]; then
  log "Enabling and starting services"
  UNITS=(admin.service)
  [[ -f "$STATS_GLOBAL/dist/daemon.js" ]] && UNITS+=(genie-stats.service)
  [[ -f /etc/systemd/system/code-server.service ]] && UNITS+=(code-server.service)
  systemctl enable "${UNITS[@]}" >/dev/null 2>&1 || true
  systemctl restart "${UNITS[@]}" || warn "Some services failed to start; check journalctl."
  systemctl reload nginx 2>/dev/null || systemctl restart nginx || true
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

  Verify:
    systemctl is-active admin.service genie-stats.service postgresql nginx
    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/    # -> 302
    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/admin/login

  Secrets written to: $INSTALL_DIR/admin/.env.local  (chmod 600)
  MCP token:          edit $INSTALL_DIR/.mcp.json if it says REPLACE_WITH_...
EOF
