#!/usr/bin/env bash
# Выкатка служб Cord на этой машине: проверка встреч → блокировка → сборка → подъём →
# ожидание здоровья → сверка коммита образа с HEAD.
#
#   backlog/bin/deploy.sh gateway core          # нужные службы
#   CORD_DEPLOY_FORCE=1 backlog/bin/deploy.sh services   # выкатить, даже если идут встречи
#   backlog/bin/deploy.sh --drain core services livekit  # дренаж: закрыть новые встречи, дождаться
#                                                        # конца идущих (до 15 мин), потом собрать
#
# Дренаж (W1b, docs/resilience.md): рычагом владельца (`POST /api/v1/admin/maintenance`, пароль
# `ADMIN_PASSWORD` из .env) ядро перестаёт создавать встречи — `503 MAINTENANCE`, главная говорит
# «сервер обновляется»; идущие встречи доигрывают, вход в них открыт. Как только `active-meetings.sh`
# пуст — сборка и подъём, как обычно. Флаг снимается на выходе всегда (`trap`), а перезапуск ядра
# сбрасывает его сам. Без `ADMIN_PASSWORD` в .env дренажа нет — скрипт откажет сразу.
#
# Никогда не делает `down` и `-v`: тома с базой и файлами не трогаются. Веб собирается внутрь
# `gateway`, правила и проверки — `core`, кинозал/музыка/Telegram — `services`.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
LOCK=$REPO/backlog/.deploy.lock
cd "$REPO"

DRAIN=0
if [[ ${1:-} == --drain ]]; then DRAIN=1; shift; fi
(($#)) || { echo "Какие службы? Например: $0 gateway core" >&2; exit 2; }

# Сколько ждать, пока встречи кончатся сами (секунды), и как часто смотреть.
DRAIN_WAIT=${CORD_DRAIN_WAIT:-900}
DRAIN_POLL=30
CORE=http://127.0.0.1:${CORE_PORT:-8080}

# Рычаг владельца: `maintenance on|off`. Пароль — из .env, в командную строку curl он не попадает
# (тело запроса читается из stdin).
admin_token() {
  local password
  password=$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -1)
  [[ -n $password ]] || { echo "В .env нет ADMIN_PASSWORD — дренажу нечем включить обслуживание." >&2; return 1; }
  ADMIN_PASSWORD=$password python3 - "$CORE" <<'PY'
import json, os, sys, urllib.request
body = json.dumps({"password": os.environ["ADMIN_PASSWORD"]}).encode()
request = urllib.request.Request(sys.argv[1] + "/api/v1/admin/session", body, {"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=20) as response:
    print(json.load(response)["token"])
PY
}

maintenance() {
  local state=$1 token
  token=$(admin_token) || return 1
  curl -fsS -o /dev/null -X POST "$CORE/api/v1/admin/maintenance" \
    -H "X-Cord-Admin: $token" -H 'Content-Type: application/json' \
    -d "{\"on\":$([[ $state == on ]] && echo true || echo false)}"
}

if ((DRAIN)); then
  echo "== дренаж: обслуживание включено $(date -Is) — новые встречи не создаются"
  maintenance on || exit 1
  # Снять флаг при любом исходе: после перезапуска ядра его уже нет, и это не ошибка.
  trap 'maintenance off >/dev/null 2>&1 && echo "== обслуживание выключено $(date -Is)" || echo "== обслуживание снято перезапуском ядра"' EXIT
  waited=0
  while ! "$BIN/active-meetings.sh"; do
    if ((waited >= DRAIN_WAIT)); then
      if [[ ${CORD_DEPLOY_FORCE:-0} != 1 ]]; then
        echo "Встречи не кончились за $((DRAIN_WAIT / 60)) мин — выкатка отложена (CORD_DEPLOY_FORCE=1, чтобы всё равно)." >&2
        exit 1
      fi
      echo "Встречи не кончились за $((DRAIN_WAIT / 60)) мин, но CORD_DEPLOY_FORCE=1 — выкатываю." >&2
      break
    fi
    sleep "$DRAIN_POLL"
    waited=$((waited + DRAIN_POLL))
  done
  echo "== дренаж: встреч нет, ждали $((waited / 60)) мин $((waited % 60)) с"
elif ! "$BIN/active-meetings.sh"; then
  if [[ ${CORD_DEPLOY_FORCE:-0} != 1 ]]; then
    echo "Идут встречи — выкатка отложена (CORD_DEPLOY_FORCE=1, чтобы всё равно; --drain, чтобы дождаться)." >&2
    exit 1
  fi
  echo "Идут встречи, но CORD_DEPLOY_FORCE=1 — выкатываю." >&2
fi

head=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain --untracked-files=no -- . ':!backlog' | head -1)
[[ -z $dirty ]] || echo "Внимание: в рабочем дереве есть незакоммиченные правки — образ не равен HEAD." >&2

exec 9>"$LOCK"
flock -w 1800 9 || { echo "Другая выкатка держит $LOCK дольше 30 минут" >&2; exit 1; }

# Без bake: compose 2.x отдаёт сборку BuildKit-у через bake, и под нагрузкой тот теряет задание
# («NotFound: forwarding Ping: no such job») — сборка падает на ровном месте.
export COMPOSE_BAKE=false
echo "== сборка $* (коммит $head)"
# Сеть хоста время от времени рвётся посреди загрузки (Maven, Go, npm — 19–20.10.2026); слои,
# собранные до обрыва, остаются в кэше, поэтому повтор стоит минут, а не часа.
for attempt in 1 2 3; do
  CORD_BUILD=$head docker compose build "$@" && break
  ((attempt < 3)) || { echo "Сборка не удалась трижды" >&2; exit 1; }
  echo "== сборка упала (попытка $attempt) — повтор через 30 с" >&2
  sleep 30
done
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
