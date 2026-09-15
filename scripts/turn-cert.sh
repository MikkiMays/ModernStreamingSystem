#!/usr/bin/env bash
# Keeps the certificate LiveKit presents for TURN/TLS in step with the one Caddy issued.
#
# Only simple mode needs this. strict mode terminates TURN/TLS at the edge, so the SFU
# never holds a certificate; ip mode uses a self-signed certificate that never rotates.
#
# Renewal replaces a file the SFU reads only at boot, so a changed certificate means a
# LiveKit restart, which ends the calls in progress at that moment. Pass --no-restart to
# stage the file and choose the moment yourself.
#
# Exit codes: 0 installed, already current, or not applicable. 2 nothing issued yet.
set -euo pipefail

RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

[[ -f .env ]] || { echo "Run this from the ModernStreamingSystem directory." >&2; exit 1; }
MODE="$(sed -n 's/^DEPLOY_MODE=//p' .env | head -1)"
DOMAIN="$(sed -n 's/^TURN_HOST=//p' .env | head -1)"

if [[ "$MODE" != simple ]]; then
  echo "Mode ${MODE:-unknown} does not sync a TURN certificate. Nothing to do."
  exit 0
fi
[[ -n "$DOMAIN" ]] || { echo "TURN_HOST missing from .env" >&2; exit 1; }

MOUNT="$(docker volume inspect modern-streaming_certificates --format '{{.Mountpoint}}' 2>/dev/null)" \
  || { echo "Cannot inspect the certificate volume. Run this as root on the server." >&2; exit 1; }

# Caddy nests issued certificates under whichever ACME directory it used, so the issuer
# folder is discovered rather than assumed.
SRC="$(find "$MOUNT/caddy/certificates" -type f -name "$DOMAIN.crt" 2>/dev/null | head -1)"
if [[ -z "$SRC" ]]; then
  echo "No certificate for $DOMAIN yet. Check that the A record points here and that port 80 is reachable."
  exit 2
fi
KEY="${SRC%.crt}.key"
[[ -f "$KEY" ]] || { echo "Found $SRC but no matching key." >&2; exit 1; }

mkdir -p infra/generated/tls
if [[ -f infra/generated/tls/turn.crt ]] && cmp -s "$SRC" infra/generated/tls/turn.crt; then
  echo "TURN certificate for $DOMAIN is already current."
  exit 0
fi

install -m 0644 "$SRC" infra/generated/tls/turn.crt
install -m 0600 "$KEY" infra/generated/tls/turn.key
echo "Installed the issued certificate for $DOMAIN."

if [[ $RESTART -eq 0 ]]; then
  echo "Restart the SFU to serve it: docker compose restart livekit"
  exit 0
fi
docker compose restart livekit
echo "LiveKit restarted with the issued certificate."
