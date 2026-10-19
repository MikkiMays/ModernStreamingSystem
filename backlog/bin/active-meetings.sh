#!/usr/bin/env bash
# Есть ли сейчас живые встречи Cord на этой машине.
#
#   backlog/bin/active-meetings.sh        # выход 0 — пусто, 1 — идут встречи (список), 2 — не знаю
#
# Смотрит в базу ядра: открытые комнаты, где есть живой человек (не бот) в статусе JOINING,
# CONNECTED или RECOVERING. Сборка на той же машине, что и SFU, душит звонки, поэтому перед
# каждой сборкой на проде — этот скрипт (его зовёт deploy.sh).
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO" || exit 2

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "Стек Cord не поднят (postgres не запущен) — встреч нет."
  exit 0
fi

sql="SELECT coalesce(s->>'title', '?') || ' · ' || coalesce(s->>'code', '?') || ' · людей: ' || count(*)
FROM (SELECT state::jsonb AS s FROM rooms) r, jsonb_each(r.s->'members') m(id, v)
WHERE r.s->>'closedAt' IS NULL
  AND m.v->>'status' IN ('JOINING', 'CONNECTED', 'RECOVERING')
  AND (m.v->>'service') IS NULL
GROUP BY s->>'title', s->>'code';"

if ! out=$(docker compose exec -T postgres psql -U streaming -d streaming -At -c "$sql" 2>&1); then
  echo "Не удалось спросить базу ядра: $out" >&2
  exit 2
fi

if [[ -z $out ]]; then
  echo "Живых встреч нет."
  exit 0
fi
echo "Идут встречи:"
sed 's/^/  /' <<<"$out"
exit 1
