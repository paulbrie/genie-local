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
    --exclude '.next' \
    --exclude 'projects/' \
    --exclude '.run-logs' \
    --exclude 'admin/.env.local' \
    --exclude '.mcp.json' \
    "$REPO_ROOT/" "$STAGE/src/"
else
  mkdir -p "$STAGE/src"
  tar -C "$REPO_ROOT" \
    --exclude='.git' --exclude='node_modules' --exclude='.next' \
    --exclude='projects' --exclude='.run-logs' \
    --exclude='admin/.env.local' --exclude='.mcp.json' \
    -cf - . | tar -C "$STAGE/src" -xf -
fi

echo "==> Building systemd-enabled base image ($IMAGE)"
docker build -t "$IMAGE" -f - "$STAGE" >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update -qq && \
    apt-get install -y -qq systemd systemd-sysv dbus sudo && \
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

echo "==> Running install.sh inside the container"
docker exec \
  -e SOURCE_DIR=/srv/genie-src \
  -e INSTALL_CODE_SERVER="${INSTALL_CODE_SERVER:-0}" \
  -e PUBLIC_HOST="${PUBLIC_HOST:-genie.test.local}" \
  "$NAME" bash /srv/genie-src/deploy/install.sh

echo
echo "==> VERIFICATION"
docker exec "$NAME" bash -lc '
  set +e
  echo "--- service states ---"
  systemctl is-active postgresql nginx admin.service genie-stats.service
  echo "--- HTTP: / (expect 302) ---"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    [ "$code" = "302" ] && break
    sleep 2
  done
  echo "GET /            -> $code"
  echo "--- HTTP: /admin/login (wait for Next dev compile) ---"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin/login 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 2
  done
  echo "GET /admin/login -> $code"
  echo "--- stats feed ---"
  sleep 6
  test -s /run/genie/stats.jsonl && echo "stats.jsonl: $(wc -l < /run/genie/stats.jsonl) lines" || echo "stats.jsonl: MISSING"
'

echo
echo "==> Container left running as \"$NAME\" for inspection."
echo "    docker exec -it $NAME bash   |   docker logs $NAME   |   docker rm -f $NAME"
trap 'rm -rf "$STAGE"' EXIT   # keep the container; only clean the stage dir
