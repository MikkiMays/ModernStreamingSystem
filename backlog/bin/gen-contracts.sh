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

IMAGE=modern-streaming-core:latest
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

docker run -d --name "$NAME-core" --network host --read-only --tmpfs /tmp \
  -e SERVER_ADDRESS=127.0.0.1 -e SERVER_PORT=$CORE_PORT -e SPRINGDOC_API_DOCS_ENABLED=true \
  -e DATABASE_URL="jdbc:postgresql://127.0.0.1:$PG_PORT/streaming" -e DATABASE_PASSWORD="$SECRET" \
  -e REDIS_HOST=127.0.0.1 -e SPRING_DATA_REDIS_PORT=$REDIS_PORT -e REDIS_PASSWORD="$SECRET" \
  -e LIVEKIT_API_KEY=contracts -e LIVEKIT_API_SECRET="$SECRET$SECRET" \
  -e SESSION_SECRET="$SECRET$SECRET" -e INTERNAL_SECRET="$SECRET$SECRET" \
  -e FILES_ROOT=/tmp/uploads \
  "$IMAGE" >/dev/null

# На перегруженной машине Spring поднимается минутами.
for _ in $(seq 1 120); do
  curl -fs "http://127.0.0.1:$CORE_PORT/api/openapi" -o /dev/null && break
  docker inspect -f '{{.State.Running}}' "$NAME-core" | grep -q true || { docker logs --tail 40 "$NAME-core"; exit 1; }
  sleep 5
done

(cd web && API_SCHEMA_URL="http://127.0.0.1:$CORE_PORT/api/openapi" npm run -s generate:api)
(cd web && npx prettier --log-level warn --write src/api/generated.ts >/dev/null 2>&1 || true)
git status --short -- contracts/openapi.json web/src/api/generated.ts
