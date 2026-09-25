#!/usr/bin/env bash
# Cord — one-command server install.
#
#   sudo ./setup.sh --domain meet.example.com     one DNS name, Let's Encrypt  (recommended)
#   sudo ./setup.sh --ip-only                     no DNS name, self-signed certificate
#   sudo ./setup.sh --app meet.example.com \      three DNS names, TURN/TLS shares 443
#                   --rtc rtc.example.com \
#                   --turn turn.example.com
#
# Safe to re-run: an existing .env is never overwritten, so secrets and live sessions
# survive. Docker is the only thing this needs on the host; the configuration generator
# runs in a container so the machine needs no Node.js of its own.
set -euo pipefail

MODE="" DOMAIN="" APP="" RTC="" TURN="" PUBLIC_IP="" SSH_PORT="${SSH_PORT:-22}"
SKIP_FIREWALL=0 SKIP_DOCKER=0
NODE_IMAGE="node:22-alpine"

die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; MODE=simple; shift 2 ;;
    --ip-only) MODE=ip; shift ;;
    --app) APP="${2:-}"; MODE=strict; shift 2 ;;
    --rtc) RTC="${2:-}"; shift 2 ;;
    --turn) TURN="${2:-}"; shift 2 ;;
    --ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --skip-docker-install) SKIP_DOCKER=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root: sudo ./setup.sh ..."
[[ -n "$MODE" ]] || die "Choose one of --domain NAME, --ip-only, or --app/--rtc/--turn. See --help."
[[ -f compose.yaml ]] || die "Run this from the ModernStreamingSystem directory."
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || die "--ssh-port must be a number"
if [[ "$MODE" == strict ]]; then
  [[ -n "$APP" && -n "$RTC" && -n "$TURN" ]] || die "Strict mode needs --app, --rtc and --turn."
fi

step "Checking the machine"
. /etc/os-release 2>/dev/null || die "Cannot identify the operating system."
note "System: ${PRETTY_NAME:-unknown}"
[[ "$(uname -m)" == x86_64 || "$(uname -m)" == aarch64 ]] || die "Unsupported architecture: $(uname -m)"
MEM_GB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024 ))
note "Memory: ${MEM_GB} GB, CPUs: $(nproc)"
(( MEM_GB >= 3 )) || note "WARNING: 4 GB or more is recommended; the build may be killed on this machine."

step "Installing Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  note "Docker and Compose v2 are already present."
elif [[ $SKIP_DOCKER -eq 1 ]]; then
  die "Docker is missing and --skip-docker-install was given."
else
  note "Installing Docker Engine from the official script at https://get.docker.com"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "Could not download the Docker installer."
  sh /tmp/get-docker.sh >/dev/null || die "Docker installation failed."
  rm -f /tmp/get-docker.sh
  docker compose version >/dev/null 2>&1 || die "Compose v2 is missing after installing Docker."
  note "Docker installed."
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if ! command -v ufw >/dev/null && [[ $SKIP_FIREWALL -eq 0 ]]; then
  step "Installing ufw"
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ufw >/dev/null 2>&1 \
    || note "Could not install ufw automatically; configure the firewall yourself."
fi

step "Determining the public address"
if [[ -z "$PUBLIC_IP" ]]; then
  for source in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    PUBLIC_IP="$(curl -fsS --max-time 8 "$source" 2>/dev/null | tr -d '[:space:]')" && [[ -n "$PUBLIC_IP" ]] && break
  done
fi
[[ -z "$PUBLIC_IP" ]] && PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
[[ -n "$PUBLIC_IP" ]] || die "Could not determine the public IP. Pass it explicitly: --ip 203.0.113.10"
note "Public IP: $PUBLIC_IP"

# The SFU advertises this address for media. Behind NAT the detected address belongs to the
# router, not to this machine, and clients on the same LAN would try to reach media at an
# address that never answers. The certificate would name it too.
if ! ip -4 addr show 2>/dev/null | grep -qw "$PUBLIC_IP"; then
  note "NOTE: $PUBLIC_IP is not assigned to any interface here, so this machine is behind NAT."
  if [[ "$MODE" == ip ]]; then
    note "For a home or office network, re-run with the address this machine has on that"
    note "network instead, for example: sudo ./setup.sh --ip-only --ip 192.168.1.50"
  else
    note "Forward TCP 443, UDP 3478 and UDP 7882 from the router to this machine."
  fi
fi

if [[ "$MODE" != ip ]]; then
  CHECK_NAME="${DOMAIN:-$APP}"
  RESOLVED="$(getent ahostsv4 "$CHECK_NAME" 2>/dev/null | awk '{print $1; exit}')"
  if [[ -z "$RESOLVED" ]]; then
    die "$CHECK_NAME does not resolve yet. Create the A record first, then re-run. DNS can take a few minutes."
  elif [[ "$RESOLVED" != "$PUBLIC_IP" ]]; then
    note "WARNING: $CHECK_NAME resolves to $RESOLVED, not $PUBLIC_IP."
    note "If the name is behind a proxy, turn the proxy off: media traffic must reach this machine directly."
    note "Certificate issuance will fail until the record points here."
  else
    note "$CHECK_NAME resolves to this machine."
  fi
fi

step "Generating configuration"
if [[ -f .env ]]; then
  note ".env already exists — keeping the existing secrets and configuration."
  note "To start over: stop the stack, remove .env and infra/generated, then re-run."
else
  case "$MODE" in
    simple) ARGS=(--domain="$DOMAIN" --ip="$PUBLIC_IP") ;;
    strict) ARGS=(--app="$APP" --rtc="$RTC" --turn="$TURN" --ip="$PUBLIC_IP") ;;
    ip)     ARGS=(--mode=ip --ip="$PUBLIC_IP") ;;
  esac
  if command -v node >/dev/null && command -v openssl >/dev/null \
     && [[ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 20 ]]; then
    node scripts/configure.mjs "${ARGS[@]}"
  else
    note "Using $NODE_IMAGE to generate the configuration."
    docker run --rm -v "$PWD:/w" -w /w "$NODE_IMAGE" \
      sh -c "apk add --no-cache openssl >/dev/null && node scripts/configure.mjs $(printf '%q ' "${ARGS[@]}")"
  fi
fi

if [[ $SKIP_FIREWALL -eq 0 ]] && command -v ufw >/dev/null; then
  step "Applying firewall rules"
  note "Keeping SSH on port $SSH_PORT open."
  SSH_PORT="$SSH_PORT" bash scripts/firewall.sh
else
  step "Skipping the firewall"
  note "Open 443/tcp, 3478/udp, 7882/udp and — outside strict mode — 5349/tcp yourself."
fi

# Disk housekeeping, installed before the first build rather than after it: the build is
# already the largest thing this script writes, and a server that fills up has no good
# moment to be told about the timer it never got. Details and the list of what the sweep
# will never touch live in infra/tidy.sh.
step "Installing the daily disk cleanup"
bash infra/tidy.sh --install || note "Cleanup timer not installed; run it by hand: bash infra/tidy.sh"

# The cinema page player opens pages anyone pasted, in a browser that cannot use its own sandbox inside
# the container. Its subnet gets a network wall before the first container starts, again on every boot
# before Docker starts (cord-sniffer-firewall.service) and every five minutes after that
# (cord-sniffer-wall.timer). Details in infra/sniffer-firewall.sh.
#
# The subnet is checked first, and a bad one stops the install: Docker creates the player's network on
# `compose up` even when the player itself is not started, and a range that overlaps this host's own
# networks, holds its default gateway or one of its addresses would take that traffic over.
step "Installing the network wall for the cinema page player"
if ! SUBNET_REPORT="$(bash infra/sniffer-firewall.sh validate 2>&1)"; then
  printf '%s\n' "$SUBNET_REPORT" | sed 's/^/    /'
  die "Choose a free range for CINEMA_SNIFFER_SUBNET in .env (/16 to /29, outside 172.16.0.0/12) and re-run."
fi
note "$SUBNET_REPORT"
WALL=0
if bash infra/sniffer-firewall.sh --install && bash infra/sniffer-firewall.sh check >/dev/null; then
  WALL=1
else
  note "The wall is not in place, so the page player is not started (links fall back to yt-dlp)."
  note "Fix it, then: sudo bash infra/sniffer-firewall.sh --install && docker compose up -d --no-deps sniffer"
fi

step "Building and starting the stack"
note "The first build compiles the server and the web client; expect several minutes."
docker compose build
if [[ $WALL -eq 1 ]]; then
  docker compose up -d
else
  # Everything but the page player: it runs only behind its network wall.
  docker compose up -d --scale sniffer=0
fi

step "Waiting for the service to come up"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/actuator/health 2>/dev/null | grep -q '"status":"UP"'; then
    READY=1; break
  fi
  sleep 5
done
[[ $READY -eq 1 ]] || die "The core did not become healthy. Inspect: docker compose logs core --tail 50"
note "Core is healthy."

ORIGIN="$(sed -n 's/^PUBLIC_URL=//p' .env | head -1)"

if [[ "$MODE" == simple ]]; then
  step "Installing the issued certificate for TURN"
  note "Waiting for Caddy to finish the certificate order."
  SYNCED=0
  for _ in $(seq 1 24); do
    set +e; bash scripts/turn-cert.sh; RC=$?; set -e
    # 2 means the order has not completed yet; anything else is final.
    [[ $RC -ne 2 ]] && { SYNCED=$RC; break; }
    sleep 5
  done
  if [[ $SYNCED -ne 0 ]]; then
    note "WARNING: no certificate for TURN yet. Relay over TLS stays unavailable until"
    note "the order completes. Re-run later: sudo bash scripts/turn-cert.sh"
  fi
fi

step "Checking the public address"
if curl -fsS --max-time 15 -k "$ORIGIN/api/v1/capabilities" >/dev/null 2>&1; then
  note "$ORIGIN answers."
else
  note "WARNING: $ORIGIN did not answer from this machine."
  note "This is often only a firewall or DNS delay. Check from another network before worrying."
fi

cat <<BANNER

  ────────────────────────────────────────────────────────────
   Cord is running.

   Server address:  $ORIGIN

   Open that address in a browser, or paste it into Cord
   for Windows: the connect screen, blue + , then Connect.

   The server is open: anyone with the address can create and
   join meetings. To ask for a password instead, put one in
   ACCESS_PASSWORD in .env and restart the core:

     docker compose up -d --no-deps --force-recreate core
  ────────────────────────────────────────────────────────────

BANNER

if [[ "$MODE" == ip ]]; then
  cat <<'WARNING'
  This server uses a self-signed certificate. Every browser shows a warning
  the first time. Open the address, choose "Advanced" and continue.

  Camera, microphone and screen sharing need a secure context, which is why
  plain http:// is not offered: browsers block capture on it entirely.

WARNING
fi

if [[ "$MODE" == simple ]]; then
  cat <<RENEWAL
  Add the certificate sync to cron so TURN keeps working after renewal:

    (crontab -l 2>/dev/null; echo "17 4 * * * cd $PWD && bash scripts/turn-cert.sh >> /var/log/cord-turn-cert.log 2>&1") | crontab -

  It restarts the SFU only when the certificate actually changed, which ends
  any call in progress at that moment. Pick an hour when nobody is talking.

RENEWAL
fi

note "Logs:    docker compose logs -f core"
note "Status:  docker compose ps"
note "Stop:    docker compose down        (this keeps your data)"
