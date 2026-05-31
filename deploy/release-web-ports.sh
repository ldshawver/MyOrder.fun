#!/usr/bin/env bash
# Free ports 80/443 before starting the MyOrder nginx edge.
#
# Coolify/Traefik commonly leaves a `coolify-proxy` container bound to the
# public web ports. When the app is migrated to a standalone VPS, that proxy can
# keep answering requests with "no available server" even though this compose
# stack built successfully. Disable its restart policy and stop it so Docker can
# bind the MyOrder nginx container to 80/443.
set -euo pipefail

log() {
  printf '[release-web-ports] %s\n' "$*"
}

stop_container_if_present() {
  local name="$1"

  if ! docker container inspect "$name" >/dev/null 2>&1; then
    return 0
  fi

  log "Disabling restart policy for ${name}"
  docker update --restart=no "$name" >/dev/null 2>&1 || true

  log "Stopping ${name}"
  docker stop "$name" >/dev/null 2>&1 || true
}

stop_container_if_present coolify-proxy
stop_container_if_present coolify-realtime

# Stop any other container that currently publishes the public HTTP(S) ports.
# This keeps the deploy idempotent on VPSes that were previously managed by a
# different reverse proxy stack. The current compose project's nginx container is
# intentionally skipped so reruns do not bounce a healthy edge unnecessarily.
port_publishers() {
  docker ps --filter publish=80 --format '{{.ID}}'
  docker ps --filter publish=443 --format '{{.ID}}'
}

while IFS= read -r container_id; do
  [ -n "$container_id" ] || continue

  name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's#^/##')"
  [ -n "$name" ] || name="$container_id"

  case "$name" in
    alavont-nginx|myorder-nginx|*_nginx_*|*-nginx-*)
      log "Keeping existing app nginx container ${name}"
      ;;
    *)
      log "Container ${name} is publishing port 80/443; disabling restart policy and stopping it"
      docker update --restart=no "$container_id" >/dev/null 2>&1 || true
      docker stop "$container_id" >/dev/null 2>&1 || true
      ;;
  esac
done < <(port_publishers | sort -u)

# Open host firewall paths where these tools are present. These commands are
# deliberately best-effort because not every VPS image has ufw/iptables helpers.
if command -v ufw >/dev/null 2>&1; then
  log "Allowing 80/tcp and 443/tcp through ufw"
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw reload >/dev/null 2>&1 || true
fi

if command -v iptables >/dev/null 2>&1; then
  log "Ensuring iptables accepts 80/tcp and 443/tcp"
  iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
  iptables -C FORWARD -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I FORWARD -p tcp --dport 80 -j ACCEPT || true
  iptables -C FORWARD -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I FORWARD -p tcp --dport 443 -j ACCEPT || true
  iptables -C DOCKER-USER -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -p tcp --dport 80 -j ACCEPT || true
  iptables -C DOCKER-USER -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -p tcp --dport 443 -j ACCEPT || true

  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

log "Public web ports are ready for the app edge"
