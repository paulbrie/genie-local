#!/usr/bin/env bash
#
# test-docker.sh — Test deploy/install.sh against a fresh Ubuntu 24.04 container.
#
# Runs a real systemd container (privileged, cgroup v2) so that
# `systemctl enable --now` actually works and services can be verified.
#
# The current working tree is copied into the container as SOURCE_DIR, so we
# test *this* code (not whatever is on GitHub).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="genie-install-test"
IMAGE="genie-systemd:24.04"   # built below from ubuntu:24.04 + systemd

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> Staging a clean copy of the working tree (excluding node_modules/.git/projects)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; cleanup' EXIT
# rsync gives us clean excludes; fall back to tar if unavailable.
if command -v rsync >/dev/null; then
  rsync -a \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.next*' \
    --exclude 'projects/' \
    --exclude '.run-logs' \
    --exclude 'admin/.env.local' \
    --exclude '.mcp.json' \
    "$REPO_ROOT/" "$STAGE/src/"
else
  mkdir -p "$STAGE/src"
  tar -C "$REPO_ROOT" \
    --exclude='.git' --exclude='node_modules' --exclude='.next*' \
    --exclude='projects' --exclude='.run-logs' \
    --exclude='admin/.env.local' --exclude='.mcp.json' \
    -cf - . | tar -C "$STAGE/src" -xf -
fi

echo "==> Building systemd-enabled base image ($IMAGE)"
docker build -t "$IMAGE" -f - "$STAGE" >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
# cron is installed so the installer's crontab step actually runs (a real Ubuntu
# box has it). Without it that code path is skipped and bugs there go uncaught.
RUN apt-get update -qq && \
    apt-get install -y -qq systemd systemd-sysv dbus sudo cron && \
    rm -rf /var/lib/apt/lists/* && \
    # Remove systemd units that make no sense (or hang) inside a container.
    find /etc/systemd/system /lib/systemd/system \
      \( -name '*getty*' -o -name '*udev*' -o -name '*mount*' \
         -o -name 'systemd-firstboot*' \) -exec rm -f {} + 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
DOCKERFILE

echo "==> Launching systemd container: $NAME ($IMAGE)"
docker run -d --name "$NAME" \
  --privileged \
  --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$STAGE/src:/srv/genie-src:ro" \
  "$IMAGE" >/dev/null

echo "==> Waiting for systemd to reach running state"
for i in $(seq 1 30); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  [[ "$state" == "running" || "$state" == "degraded" ]] && break
  sleep 1
done
echo "    systemd state: $(docker exec "$NAME" systemctl is-system-running 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------------------
# Run install.sh — either unattended (PUBLIC_HOST set) or via the setup wizard
# (default), simulating the browser confirm the operator would do at /setup.
# ---------------------------------------------------------------------------
COMMON_ENV=(-e SOURCE_DIR=/srv/genie-src -e INSTALL_CODE_SERVER="${INSTALL_CODE_SERVER:-0}")

if [[ -n "${PUBLIC_HOST:-}" ]]; then
  EXPECT_HOST="$PUBLIC_HOST"
  echo "==> Running install.sh (PUBLIC_HOST=$PUBLIC_HOST — wizard skipped)"
  docker exec "${COMMON_ENV[@]}" -e PUBLIC_HOST="$PUBLIC_HOST" \
    "$NAME" bash /srv/genie-src/deploy/install.sh
else
  EXPECT_HOST="${WIZARD_HOST:-genie.test.local}"
  echo "==> Running install.sh WITH the setup wizard (will confirm host='$EXPECT_HOST')"
  # Run the installer in the background; it blocks on the wizard at :3000 until
  # we POST the confirm, exactly as a browser would.
  docker exec -d "${COMMON_ENV[@]}" \
    "$NAME" bash -lc 'bash /srv/genie-src/deploy/install.sh >/var/log/install.log 2>&1'

  # The wizard only comes up after base apt + PostgreSQL 17 + Node install, which
  # on a fresh container (cold apt cache, PGDG download) can take well over 5 min
  # — more under load. Wait up to ~15 min; the loop breaks the moment /setup answers.
  echo "    waiting for the wizard to serve :3000/setup ..."
  code=""
  for _ in $(seq 1 450); do
    code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
             -H "X-Forwarded-Host: $EXPECT_HOST" http://127.0.0.1:3000/setup 2>/dev/null || true)
    [ "$code" = "200" ] && break
    docker exec "$NAME" grep -q "ERROR:" /var/log/install.log 2>/dev/null && break
    sleep 2
  done
  echo "    GET /setup -> ${code:-none}"
  if [ "$code" != "200" ]; then
    echo "!! wizard did not come up — install log tail:"; docker exec "$NAME" tail -n 40 /var/log/install.log || true
    exit 1
  fi
  # Verify /setup actually shows the detected host, then confirm it.
  docker exec "$NAME" curl -s -H "X-Forwarded-Host: $EXPECT_HOST" http://127.0.0.1:3000/setup \
    | grep -q "$EXPECT_HOST" && echo "    /setup shows detected host: $EXPECT_HOST"
  docker exec "$NAME" curl -s -o /dev/null -w '    POST /setup/confirm -> %{http_code}\n' \
    -X POST http://127.0.0.1:3000/setup/confirm --data "host=$EXPECT_HOST"

  echo "    install continuing (npm install + prod build) — waiting for completion ..."
  done_ok=0
  for _ in $(seq 1 240); do
    docker exec "$NAME" grep -q "Setup complete." /var/log/install.log 2>/dev/null && { done_ok=1; break; }
    docker exec "$NAME" grep -q "ERROR:" /var/log/install.log 2>/dev/null && break
    sleep 5
  done
  echo "--- install log tail ---"; docker exec "$NAME" tail -n 25 /var/log/install.log || true
  [ "$done_ok" = 1 ] || { echo "!! install did not complete"; exit 1; }
fi

echo
echo "==> VERIFICATION (expected public host: $EXPECT_HOST)"
docker exec -e EXPECT_HOST="$EXPECT_HOST" "$NAME" bash -lc '
  set +e
  echo "--- service states ---"
  systemctl is-active postgresql nginx admin.service genie-stats.service
  echo "--- admin.service is PROD (next start) with APP_PUBLIC_HOSTS baked in ---"
  echo "ExecStart mode : $(systemctl show -p ExecStart --value admin.service | grep -oE "next (start|dev)" | head -1)"
  systemctl show -p Environment --value admin.service | tr " " "\n" | grep APP_PUBLIC_HOSTS || echo "APP_PUBLIC_HOSTS: MISSING"
  echo "--- stats-history cron installed (installer ran the crontab step) ---"
  crontab -u genie -l 2>/dev/null | grep -q stats-history.mjs && echo "cron: present" || echo "cron: MISSING"
  echo "--- HTTP: / (expect 302) ---"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    [ "$code" = "302" ] && break; sleep 2
  done
  echo "GET /                 -> $code"
  echo "--- HTTP: /admin/login (prod build) ---"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin/login 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 2
  done
  echo "GET /admin/login      -> $code"
  echo "--- DEV instance: admin-ctl dev-start, then /admin-dev/login ---"
  sudo -u genie sudo -n /usr/local/bin/admin-ctl dev-start
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin-dev/login 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 2
  done
  echo "GET /admin-dev/login  -> $code"
  echo "--- origin allowlist (dev /_next chunk: expected host vs bogus) ---"
  chunk=$(curl -s http://127.0.0.1:3000/admin-dev/login | grep -oE "/admin-dev/_next/[^\"]+\.js" | head -1)
  if [ -n "$chunk" ]; then
    echo "good Origin ($EXPECT_HOST) -> $(curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://$EXPECT_HOST" "http://127.0.0.1:3000$chunk")"
    echo "bogus Origin               -> $(curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.example.com" "http://127.0.0.1:3000$chunk")"
  else
    echo "(no /_next chunk found to test)"
  fi
  echo "--- stats feed ---"
  sleep 6
  test -s /run/genie/stats.jsonl && echo "stats.jsonl: $(wc -l < /run/genie/stats.jsonl) lines" || echo "stats.jsonl: MISSING"
'

echo
echo "==> Container left running as \"$NAME\" for inspection."
echo "    docker exec -it $NAME bash   |   docker logs $NAME   |   docker rm -f $NAME"
trap 'rm -rf "$STAGE"' EXIT   # keep the container; only clean the stage dir
