#!/usr/bin/env bash
# Медиаузел Cord по SSH с узла управления (R195): подготовить машину, выкатить, проверить, дренировать.
#
#   backlog/bin/node.sh hel bootstrap   # docker, ufw, sysctl, каталог — один раз на новой машине
#   backlog/bin/node.sh hel deploy      # файлы из infra/generated/nodes/hel → узел, compose pull + up, проверки
#   backlog/bin/node.sh hel check       # здоровье узла: контейнеры, SFU, магистраль, 443
#   backlog/bin/node.sh hel drain       # ядро перестаёт ставить встречи на узел; ждать, пока идущие кончатся
#   backlog/bin/node.sh hel undrain
#   backlog/bin/node.sh hel ssh [команда]
#   backlog/bin/node.sh hel logs [служба]
#
# Откуда узел берётся: `infra/generated/nodes/registry.json` (`ssh`, `sshKey`, `ip`) — его пишет
# `scripts/node-config.mjs`. Файлы на узле: /opt/cord/node. Секреты уезжают только rsync по SSH (0600),
# в вывод и в git не попадают. `deploy` без встреч на узле (`active-meetings.sh --node <id>`), иначе —
# `drain` и ждать; CORD_DEPLOY_FORCE=1 — только если людей нет.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
# Установка — там, где `.env` и `infra/generated` (обычно сама репа; из worktree — CORD_INSTALL=/opt/ModernStreamingSystem).
INSTALL=${CORD_INSTALL:-$REPO}
cd "$INSTALL"
NODES=infra/generated/nodes/registry.json
REMOTE_DIR=/opt/cord/node

(($# >= 2)) || { sed -n '2,12p' "$0" >&2; exit 2; }
ID=$1; ACTION=$2; shift 2

[[ -f $NODES ]] || { echo "Нет $INSTALL/$NODES — сначала node scripts/node-config.mjs --node=$ID … (из каталога установки)" >&2; exit 1; }
read -r IP SSH_TARGET SSH_KEY CONTROL_IP < <(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const n = r.nodes.find((x) => x.id === process.argv[2] && !x.control);
  if (!n) { console.error("Узла " + process.argv[2] + " нет в реестре"); process.exit(1); }
  const c = r.nodes.find((x) => x.control);
  console.log(n.ip, n.ssh || ("root@" + n.ip), n.sshKey || "", c.ip);
' "$NODES" "$ID")
SSH=(ssh -o ConnectTimeout=15 -o BatchMode=yes)
[[ -n $SSH_KEY ]] && SSH+=(-i "$SSH_KEY")
remote() { "${SSH[@]}" "$SSH_TARGET" "$@"; }
LOCAL_DIR=infra/generated/nodes/$ID

case $ACTION in
  ssh) exec "${SSH[@]}" "$SSH_TARGET" "$@" ;;
  logs) exec "${SSH[@]}" "$SSH_TARGET" "cd $REMOTE_DIR && docker compose logs --tail 100 ${1:-}" ;;

  bootstrap)
    # Идемпотентно: повтор на готовой машине ничего не ломает. Брандмауэр — только то, что нужно узлу:
    # 22, 80/443 (edge и ACME), медиа (7881/tcp, 7882/udp, 3478/udp), магистраль 7443/tcp — только с A.
    remote bash -s "$CONTROL_IP" <<'EOF'
set -euo pipefail
CONTROL_IP=$1
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
apt-get install -y -qq ufw rsync fail2ban >/dev/null 2>&1 || true
cat > /etc/sysctl.d/90-cord-media.conf <<'SYS'
# Узел медиа Cord: буферы UDP под SFU, BBR на TCP, очереди.
net.core.rmem_max=26214400
net.core.wmem_max=26214400
net.core.rmem_default=2097152
net.core.wmem_default=2097152
net.core.netdev_max_backlog=30000
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.udp_rmem_min=16384
net.ipv4.udp_wmem_min=16384
net.ipv4.ip_local_port_range=10000 65000
vm.swappiness=10
SYS
sysctl -q --system >/dev/null
# Правила добавляются, а не переписываются: `ufw allow` идемпотентен, а чужие правила на машине (прокси
# YouTube для других серверов Cord, R196) остаются как были.
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw allow 7881/tcp >/dev/null; ufw allow 7882/udp >/dev/null; ufw allow 3478/udp >/dev/null
ufw allow from "$CONTROL_IP" to any port 7443 proto tcp comment 'cord backbone' >/dev/null
# Чего узлу не нужно (SFU на одном UDP-порту 7882, QUIC на 443 нет) — снять, если открыто раньше.
ufw delete allow 443/udp >/dev/null 2>&1 || true
ufw delete allow 50000:60000/udp >/dev/null 2>&1 || true
ufw --force enable >/dev/null
mkdir -p /opt/cord/node/pki /opt/cord/node/tls && chmod 700 /opt/cord/node /opt/cord/node/pki
echo "bootstrap: docker $(docker --version | awk '{print $3}') ufw $(ufw status | head -1)"
EOF
    ;;

  deploy)
    [[ -d $LOCAL_DIR ]] || { echo "Нет $LOCAL_DIR — node scripts/node-config.mjs --node=$ID …" >&2; exit 1; }
    if ! "$BIN/active-meetings.sh" --node "$ID"; then
      if [[ ${CORD_DEPLOY_FORCE:-0} != 1 ]]; then
        echo "На узле $ID идут встречи — сначала drain (CORD_DEPLOY_FORCE=1, чтобы всё равно)." >&2; exit 1
      fi
      echo "Встречи на $ID идут, но CORD_DEPLOY_FORCE=1 — выкатываю." >&2
    fi
    remote "mkdir -p $REMOTE_DIR/pki $REMOTE_DIR/tls && chmod 700 $REMOTE_DIR $REMOTE_DIR/pki"
    RSYNC=(rsync -az --chmod=D700,F600 -e "${SSH[*]}")
    "${RSYNC[@]}" "$LOCAL_DIR/node.env" "$SSH_TARGET:$REMOTE_DIR/.env"
    "${RSYNC[@]}" "$LOCAL_DIR/edge.json" "$LOCAL_DIR/livekit.json" "$LOCAL_DIR/backbone.json" "$SSH_TARGET:$REMOTE_DIR/"
    "${RSYNC[@]}" "$LOCAL_DIR/pki/" "$SSH_TARGET:$REMOTE_DIR/pki/"
    "${RSYNC[@]}" "$LOCAL_DIR/tls/" "$SSH_TARGET:$REMOTE_DIR/tls/"
    "${RSYNC[@]}" "$REPO/compose.node.yaml" "$SSH_TARGET:$REMOTE_DIR/compose.yaml"
    "${RSYNC[@]}" "$REPO/infra/Caddyfile.node" "$SSH_TARGET:$REMOTE_DIR/Caddyfile"
    # Контейнерам файлы нужны на чтение не от root: Caddy и LiveKit в образах работают от root, но
    # `edge.json`/`Caddyfile` секретов не несут — им 644; секреты (.env, livekit.json, pki) остаются 600.
    remote "chmod 644 $REMOTE_DIR/edge.json $REMOTE_DIR/backbone.json $REMOTE_DIR/Caddyfile $REMOTE_DIR/compose.yaml $REMOTE_DIR/pki/ca.crt $REMOTE_DIR/pki/node.crt; chmod 644 $REMOTE_DIR/tls/* 2>/dev/null || true"
    echo "== узел $ID: pull + up"
    # --force-recreate: edge.json, livekit.json, backbone.json и Caddyfile смонтированы по одному файлу, а rsync кладёт
    # новый файл — контейнер без пересоздания видит прежний, и `up -d` его не пересоздаёт (меняются только env и образ).
    # Так 09.11 hel остался на файлах стенда (режим ip, ключи A). Встреч на узле здесь уже нет — проверено выше.
    remote "cd $REMOTE_DIR && docker compose pull -q && docker compose up -d --remove-orphans --force-recreate && sleep 3 && docker compose ps --format '{{.Name}} {{.Status}}'"
    "$0" "$ID" check
    ;;

  check)
    echo "== узел $ID ($IP)"
    remote "cd $REMOTE_DIR && docker compose ps --format '  {{.Service}}: {{.Status}}'"
    # SFU отвечает на своём порту; магистраль слушает 7443; edge держит 443.
    remote "curl -fsS -o /dev/null -w '  livekit 7880: %{http_code}\n' http://127.0.0.1:7880/ || echo '  livekit 7880: нет ответа'"
    remote "ss -ltn | grep -q ':7443 ' && echo '  backbone 7443: слушает' || echo '  backbone 7443: НЕ слушает'"
    remote "ss -ltn | grep -q ':443 ' && echo '  edge 443: слушает' || echo '  edge 443: НЕ слушает'"
    # Пинг через edge по публичному адресу узла: в ip-режиме сертификат выписан на адрес, в strict — на имя.
    remote "host=\$(sed -n 's/^APP_HOST=//p' $REMOTE_DIR/.env); curl -fsS -k -m 5 -o /dev/null -w \"  ping через edge (\$host): %{http_code} %{time_total}s\n\" \"https://\$host/api/v1/ping\" || echo '  ping через edge: нет ответа'"
    # С узла управления: Twirp узла через магистраль (локальный порт из реестра).
    port=$(node -p "new URL(JSON.parse(require('fs').readFileSync('$NODES','utf8')).nodes.find(n=>n.id==='$ID').internalUrl).port")
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/"; then echo "  магистраль A→$ID (127.0.0.1:$port → livekit): ок"
    else echo "  магистраль A→$ID (127.0.0.1:$port): нет ответа — на A не поднят backbone или закрыт 7443 на узле"; fi
    ;;

  drain|undrain)
    enabled=$([[ $ACTION == undrain ]] && echo true || echo false)
    node "$REPO/scripts/node-config.mjs" --node="$ID" --refresh --enabled="$enabled" >/dev/null
    echo "== узел $ID: enabled=$enabled в $NODES (ядро перечитает за ≤ 10 с)"
    if [[ $ACTION == drain ]]; then
      waited=0; limit=${CORD_DRAIN_WAIT:-900}
      while ! "$BIN/active-meetings.sh" --node "$ID"; do
        ((waited < limit)) || { echo "Встречи на $ID не кончились за $((limit / 60)) мин." >&2; exit 1; }
        sleep 30; waited=$((waited + 30))
      done
      echo "== на узле $ID встреч нет (ждали $((waited / 60)) мин $((waited % 60)) с)"
    fi
    ;;
  *) echo "Неизвестное действие: $ACTION" >&2; exit 2 ;;
esac
