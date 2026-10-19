#!/usr/bin/env bash
# Выкатка служб Cord на этой машине: проверка встреч → блокировка → сборка → подъём →
# ожидание здоровья → сверка коммита образа с HEAD.
#
#   backlog/bin/deploy.sh gateway core          # нужные службы
#   CORD_DEPLOY_FORCE=1 backlog/bin/deploy.sh services   # выкатить, даже если идут встречи
#
# Никогда не делает `down` и `-v`: тома с базой и файлами не трогаются. Веб собирается внутрь
# `gateway`, правила и проверки — `core`, кинозал/музыка/Telegram — `services`.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
LOCK=$REPO/backlog/.deploy.lock
cd "$REPO"

(($#)) || { echo "Какие службы? Например: $0 gateway core" >&2; exit 2; }

if ! "$BIN/active-meetings.sh"; then
  if [[ ${CORD_DEPLOY_FORCE:-0} != 1 ]]; then
    echo "Идут встречи — выкатка отложена (CORD_DEPLOY_FORCE=1, чтобы всё равно)." >&2
    exit 1
  fi
  echo "Идут встречи, но CORD_DEPLOY_FORCE=1 — выкатываю." >&2
fi

head=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain --untracked-files=no -- . ':!backlog' | head -1)
[[ -z $dirty ]] || echo "Внимание: в рабочем дереве есть незакоммиченные правки — образ не равен HEAD." >&2

exec 9>"$LOCK"
flock -w 1800 9 || { echo "Другая выкатка держит $LOCK дольше 30 минут" >&2; exit 1; }

echo "== сборка $* (коммит $head)"
CORD_BUILD=$head docker compose build "$@"
# Ядро — первым и отдельно: шлюз и службы ждут его здоровья (`depends_on: service_healthy`) даже
# при `--no-deps`, если оно в той же команде, а на перегруженной машине Spring поднимается и за 14
# минут. Каждая служба поднимается и ждётся по очереди.
order=()
[[ " $* " == *" core "* ]] && order+=(core)
for service in "$@"; do [[ $service == core ]] || order+=("$service"); done

wait_healthy() {
  local service=$1 deadline=$((SECONDS + 1200)) id state
  while :; do
    id=$(docker compose ps -q "$service")
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
    case $state in
      healthy|running) echo "  $service: $state"; return ;;
      unhealthy|exited|dead|missing) echo "  $service: $state" >&2; docker compose logs --tail 40 "$service" >&2; exit 1 ;;
    esac
    ((SECONDS < deadline)) || { echo "  $service: не стал здоровым за 20 минут ($state)" >&2; exit 1; }
    sleep 5
  done
}

for service in "${order[@]}"; do
  echo "== подъём $service"
  docker compose up -d --no-deps "$service"
  wait_healthy "$service"
done

# Коммит вшит в бандл веба (`__CORD_BUILD__`, web/vite.config.ts) — его же печатает «О программе».
if [[ " $* " == *" gateway "* ]]; then
  if docker compose exec -T gateway sh -c "grep -qr '$head' /srv/assets"; then
    echo "== gateway: бандл собран из $head"
  else
    echo "== gateway: в бандле нет $head — образ не из HEAD" >&2; exit 1
  fi
fi
docker compose ps
