#!/usr/bin/env bash
# Перегенерировать contracts/openapi.json и web/src/api/generated.ts из образа ядра — без локального
# стека и не трогая стенд.
#
#   backlog/bin/gen-contracts.sh            # собрать образ ядра из рабочего дерева и снять схему
#   CORD_GEN_NO_BUILD=1 backlog/bin/gen-contracts.sh   # взять уже собранный образ
#
# Поднимает одноразовые Postgres и Redis на своих портах и второй экземпляр ядра с открытой схемой
# (`SPRINGDOC_API_DOCS_ENABLED=true`) на 127.0.0.1:18089, снимает схему тем же `npm run
# generate:api`, что и CI, и всё убирает за собой. База стенда, его Redis и его ядро не задеваются:
# у одноразовых контейнеров нет томов, а имена и порты свои.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
cd "$REPO"

# Свой образ (`CORD_GEN_IMAGE=cord-core-w1b CORD_GEN_NO_BUILD=1`) — когда ядро собрано из ветки под
# своим тегом и образ стенда `modern-streaming-core` трогать нельзя.
IMAGE=${CORD_GEN_IMAGE:-modern-streaming-core:latest}
PG_PORT=15432 REDIS_PORT=16379 CORE_PORT=18089
NAME=cord-contracts-$$
SECRET=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')

cleanup() { docker rm -f "$NAME-core" "$NAME-pg" "$NAME-redis" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [[ ${CORD_GEN_NO_BUILD:-0} != 1 ]]; then
  COMPOSE_BAKE=false CORD_BUILD=$(git rev-parse --short HEAD) docker compose build core
fi

docker run -d --name "$NAME-pg" --network host \
  -e POSTGRES_DB=streaming -e POSTGRES_USER=streaming -e POSTGRES_PASSWORD="$SECRET" \
  postgres:18.3-alpine -c listen_addresses=127.0.0.1 -c port=$PG_PORT >/dev/null
docker run -d --name "$NAME-redis" --network host redis:8.6.6-alpine \
  redis-server --bind 127.0.0.1 --port $REDIS_PORT --requirepass "$SECRET" --save '' >/dev/null

until docker exec "$NAME-pg" pg_isready -q -h 127.0.0.1 -p $PG_PORT -U streaming; do sleep 2; done
until docker exec "$NAME-redis" redis-cli -p $REDIS_PORT -a "$SECRET" --no-auth-warning ping 2>/dev/null | grep -q PONG; do sleep 2; done

docker run -d --name "$NAME-core" --network host --read-only --tmpfs /tmp \
  -e SERVER_ADDRESS=127.0.0.1 -e SERVER_PORT=$CORE_PORT -e SPRINGDOC_API_DOCS_ENABLED=true \
  -e DATABASE_URL="jdbc:postgresql://127.0.0.1:$PG_PORT/streaming" -e DATABASE_PASSWORD="$SECRET" \
  -e REDIS_HOST=127.0.0.1 -e SPRING_DATA_REDIS_PORT=$REDIS_PORT -e REDIS_PASSWORD="$SECRET" \
  -e SPRING_DATA_REDIS_TIMEOUT=10s \
  -e LIVEKIT_API_KEY=contracts -e LIVEKIT_API_SECRET="$SECRET$SECRET" \
  -e SESSION_SECRET="$SECRET$SECRET" -e INTERNAL_SECRET="$SECRET$SECRET" \
  -e FILES_ROOT=/tmp/uploads \
  "$IMAGE" >/dev/null

# На перегруженной машине Spring поднимается минутами.
ready=0
for _ in $(seq 1 360); do
  curl -fs "http://127.0.0.1:$CORE_PORT/api/openapi" -o /dev/null && { ready=1; break; }
  docker inspect -f '{{.State.Running}}' "$NAME-core" | grep -q true || { docker logs --tail 40 "$NAME-core"; exit 1; }
  sleep 5
done
((ready)) || { echo "Ядро не ответило за 30 минут" >&2; docker logs --tail 20 "$NAME-core"; exit 1; }

# Схему — сначала в файл, с повторами: одноразовое ядро на перегруженной машине отвечало на
# проверку готовности и тут же переставало принимать соединения к запросу генератора.
SCHEMA=$(mktemp)
curl -fsS --retry 20 --retry-connrefused --retry-delay 5 --max-time 120 \
  "http://127.0.0.1:$CORE_PORT/api/openapi" -o "$SCHEMA" \
  || { echo "Схему снять не удалось" >&2; docker logs --tail 60 "$NAME-core"; exit 1; }
(cd web && API_SCHEMA_FILE="$SCHEMA" npm run -s generate:api)
rm -f "$SCHEMA"
(cd web && npx prettier --log-level warn --write src/api/generated.ts >/dev/null 2>&1 || true)
git status --short -- contracts/openapi.json web/src/api/generated.ts
