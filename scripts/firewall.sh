#!/usr/bin/env bash
set -euo pipefail
# Host networking needs explicit protection of LiveKit's internal HTTP/TURN listeners.
# The SSH rule must match your VPS before you run this script.
#
# Which ports belong outside depends on the deployment mode, so .env is read first (port 80
# for ACME — not in ip mode). TCP 5349 is never public: in strict the edge terminates TURN/TLS
# on 443 by SNI and reaches LiveKit's 5349 over loopback; simple/ip have no TURN/TLS at all
# (LiveKit would advertise it on 443, see scripts/edge-config.mjs).
# On an upgraded server an earlier `allow 5349/tcp` wins over the `deny` below: delete it
# first — `ufw delete allow 5349/tcp`.
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
ufw deny 5349/tcp
ufw deny 7880/tcp
# Метрики LiveKit (профиль monitoring): порт слушает 0.0.0.0, как и сигналинг; он под паролем,
# но снаружи его не видно и так. Остальной мониторинг слушает только 127.0.0.1.
ufw deny 6789/tcp
ufw deny 8080/tcp
ufw deny 8090/tcp
ufw deny 8091/tcp
ufw deny 5432/tcp
ufw deny 6379/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status numbered
