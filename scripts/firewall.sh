#!/usr/bin/env bash
set -euo pipefail
# Host networking needs explicit protection of LiveKit's internal HTTP/TURN listeners.
# The SSH rule must match your VPS before you run this script.
SSH_PORT="${SSH_PORT:-22}"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || { echo 'Invalid SSH_PORT'; exit 1; }
command -v ufw >/dev/null || { echo 'Install ufw first'; exit 1; }
ufw allow "$SSH_PORT/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 3478/udp
ufw deny 7880/tcp
ufw deny 5349/tcp
ufw deny 8080/tcp
ufw deny 8090/tcp
ufw deny 8091/tcp
ufw deny 5432/tcp
ufw deny 6379/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status numbered
