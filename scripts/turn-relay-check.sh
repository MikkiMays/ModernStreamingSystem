#!/usr/bin/env bash
# TURN Cord — не открытый relay (A12 docs/abuse-model.md), проверка настоящим LiveKit.
#
# Порождает конфигурацию тем же `scripts/configure.mjs`, что и установка (режим ip, адрес узла из
# TEST-NET-3), поднимает одноразовый LiveKit того же образа, что в compose, в своей изолированной сети
# Docker (`--internal`: наружу из неё не выйти) и гоняет `scripts/turn-relay-check.mjs`:
#   1) с порождёнными правилами — relay только к SFU, всё остальное отклонено;
#   2) те же настройки без `deny_peer_cidrs` — relay в интернет открыт: проверка умеет видеть дыру.
#
#   bash scripts/turn-relay-check.sh
#
# Нужны docker, node и openssl (configure.mjs пишет самоподписанный сертификат TURN). Стенд и его .env
# не трогаются.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
sfu_image="$(grep -oE 'livekit/livekit-server:[^[:space:]]+' "$root/compose.yaml" | head -1)"
node_image="$(grep -oE 'node:[^[:space:]]+' "$root/infra/Dockerfile.web" | head -1)"
name="cord-turn-check-$$"
subnet="203.0.113.0/24"
node_ip="203.0.113.2"
work="$(mktemp -d)"

cleanup() {
  docker rm -f "$name-sfu" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

(cd "$work" && node "$root/scripts/configure.mjs" --mode=ip --ip="$node_ip" >/dev/null)
chmod -R a+rX "$work"

# Одиночный LiveKit: без Redis и без вебхука ядра — проверяется только TURN.
variant() {
  node -e '
    const fs = require("node:fs");
    const [from, to, mode] = process.argv.slice(1);
    const sfu = JSON.parse(fs.readFileSync(from, "utf8"));
    delete sfu.redis;
    delete sfu.webhook;
    sfu.logging = { level: "info" };
    if (mode === "open") {
      delete sfu.turn.deny_peer_cidrs;
      delete sfu.turn.allow_restricted_peer_cidrs;
    }
    fs.writeFileSync(to, JSON.stringify(sfu, null, 2));
    fs.chmodSync(to, 0o644);
  ' "$work/infra/generated/livekit.json" "$work/livekit-$1.json" "$1"
}
variant closed
variant open

docker network create --internal --subnet "$subnet" "$name" >/dev/null

run() {
  local config="$1"
  shift
  docker rm -f "$name-sfu" >/dev/null 2>&1 || true
  docker run -d --name "$name-sfu" --network "$name" --ip "$node_ip" \
    -v "$work/livekit-$config.json:/etc/livekit.json:ro" \
    -v "$work/infra/generated/tls:/etc/tls:ro" \
    "$sfu_image" --config /etc/livekit.json >/dev/null
  docker run --rm --network "$name" \
    -v "$root/scripts:/scripts:ro" -v "$work/.env:/check/.env:ro" \
    "$node_image" node -e '
      const deadline = Date.now() + 60000;
      (async function wait() {
        try { if ((await fetch(process.argv[1])).ok) return; } catch {}
        if (Date.now() > deadline) { console.error("LiveKit не поднялся за 60 с"); process.exit(1); }
        setTimeout(wait, 500);
      })();
    ' "http://$node_ip:7880/" || { docker logs "$name-sfu" | tail -20; return 1; }
  docker run --rm --network "$name" \
    -v "$root/scripts:/scripts:ro" -v "$work/.env:/check/.env:ro" \
    "$node_image" node /scripts/turn-relay-check.mjs --env=/check/.env \
    --signal="ws://$node_ip:7880" --turn="$node_ip:3478" --peer="$node_ip" "$@" \
    || { docker logs "$name-sfu" 2>&1 | tail -20; return 1; }
}

echo "== порождённая конфигурация (configure.mjs)"
run closed
echo "== та же без deny_peer_cidrs — проверка обязана увидеть открытый relay"
run open --expect-open
