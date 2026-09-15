#!/usr/bin/env bash
set -euo pipefail
# Host networking needs explicit protection of LiveKit's internal HTTP/TURN listeners.
# The SSH rule must match your VPS before you run this script.
#
# Which ports belong outside depends on the deployment mode, so .env is read first:
#   strict — the edge terminates TURN/TLS on 443 by SNI, so 5349 stays internal.
#   simple/ip — LiveKit terminates TURN/TLS itself, so 5349 has to be reachable.
SSH_PORT="${SSH_PORT:-22}"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || { echo 'Invalid SSH_PORT'; exit 1; }
command -v ufw >/dev/null || { echo 'Install ufw first'; exit 1; }

MODE="${DEPLOY_MODE:-}"
if [[ -z "$MODE" && -f .env ]]; then
  MODE="$(sed -n 's/^DEPLOY_MODE=//p' .env | head -1)"
fi
MODE="${MODE:-strict}"
case "$MODE" in
  simple|strict|ip) ;;
  *) echo "Unknown DEPLOY_MODE '$MODE'"; exit 1 ;;
esac
echo "Applying firewall rules for mode: $MODE"

ufw allow "$SSH_PORT/tcp"
# ACME needs port 80. Without a DNS name there is no ACME and nothing to serve there.
if [[ "$MODE" != "ip" ]]; then ufw allow 80/tcp; else ufw deny 80/tcp; fi
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 3478/udp
if [[ "$MODE" == "strict" ]]; then ufw deny 5349/tcp; else ufw allow 5349/tcp; fi
ufw deny 7880/tcp
ufw deny 8080/tcp
ufw deny 8090/tcp
ufw deny 8091/tcp
ufw deny 5432/tcp
ufw deny 6379/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status numbered
