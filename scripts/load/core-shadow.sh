#!/bin/bash
# Теневое ядро для нагрузки: своя база и свой Redis на других портах, тот же образ ядра, SFU — общий.
# Данные стенда не трогает. up | down
set -e
E=${CORD_ENV:-$(cd "$(dirname "$0")/../.." && pwd)/.env}
get() { grep "^$1=" $E | cut -d= -f2-; }
if [ "$1" = down ]; then docker rm -f lt-core lt-pg lt-redis >/dev/null 2>&1 || true; exit 0; fi
docker rm -f lt-core lt-pg lt-redis >/dev/null 2>&1 || true
docker run -d --name lt-pg -e POSTGRES_DB=streaming -e POSTGRES_USER=streaming -e POSTGRES_PASSWORD=lt \
  -p 127.0.0.1:15432:5432 postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7 >/dev/null
docker run -d --name lt-redis -p 127.0.0.1:16379:6379 redis:8.6.6-alpine@sha256:75934ddb37bfaebe3b4082ba673cac39f66495244134f33dd0a502ce03cdcd36 redis-server --requirepass lt --save '' >/dev/null
sleep 6
docker run -d --name lt-core --network host --memory 2g --cpu-shares 2048 --read-only --tmpfs /tmp \
  -e SERVER_ADDRESS=127.0.0.1 -e SERVER_PORT=18080 -e SPRINGDOC_API_DOCS_ENABLED=false \
  -e DATABASE_URL=jdbc:postgresql://127.0.0.1:15432/streaming -e DATABASE_USER=streaming -e DATABASE_PASSWORD=lt \
  -e REDIS_HOST=127.0.0.1 -e SPRING_DATA_REDIS_PORT=16379 -e REDIS_PASSWORD=lt \
  -e LIVEKIT_URL=ws://127.0.0.1:7880 -e LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880 \
  -e LIVEKIT_API_KEY="$(get LIVEKIT_API_KEY)" -e LIVEKIT_API_SECRET="$(get LIVEKIT_API_SECRET)" \
  -e SESSION_SECRET="$(head -c 32 /dev/urandom | base64)" -e INTERNAL_SECRET="$(head -c 32 /dev/urandom | base64)" \
  -e FILES_ROOT=/tmp/uploads -e PUBLIC_URL=http://127.0.0.1:18080 -e SERVER_NAME=loadtest \
  -e HUMAN_CHECK=off -e STREAM_MAX_ROOMS=5000 -e STREAM_MAX_PARTICIPANTS=50 \
  -e STREAM_JOINSECONDS=300 -e STREAM_UNUSEDROOMSECONDS=7200 -e ONE_ACTIVE_MEETING_PER_PROFILE=false \
  -e ABUSE_IP_ROOMS_CREATED=off -e ABUSE_IP_OPEN_ROOMS=100000 -e ABUSE_IP_ADMISSIONS=off -e ABUSE_IP_CODE_JOINS=off \
  -e ABUSE_IP_SOCKETS=100000 -e ABUSE_IP_SOCKET_OPENS=off -e ABUSE_IP_SIGNALING=off -e ABUSE_IP_CHAT_MESSAGES=off \
  -e ABUSE_PROFILE_ROOMS_CREATED=off -e ABUSE_PROFILE_OPEN_ROOMS=100000 -e ABUSE_MEMBER_CHAT_MESSAGES=off \
  -e ABUSE_MEMBER_CHAT_REPEAT=1s -e ABUSE_SERVER_CODE_MISSES=off -e MEETING_WAITING=50 \
  modern-streaming-core >/dev/null
for i in $(seq 1 120); do curl -sf http://127.0.0.1:18080/actuator/health >/dev/null && { echo "core up after ${i}x5s"; exit 0; }; sleep 5; done
echo "core not healthy"; docker logs --tail 40 lt-core; exit 1
