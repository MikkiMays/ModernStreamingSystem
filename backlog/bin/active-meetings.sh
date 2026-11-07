#!/usr/bin/env bash
# Есть ли сейчас живые встречи Cord на этой машине — или на одном медиаузле.
#
#   backlog/bin/active-meetings.sh              # выход 0 — пусто, 1 — идут встречи (список), 2 — не знаю
#   backlog/bin/active-meetings.sh --node hel   # только встречи, чей узел медиа — hel (R195)
#
# Смотрит в базу ядра: открытые комнаты, где есть живой человек (не бот) в статусе JOINING,
# CONNECTED или RECOVERING. Сборка на той же машине, что и SFU, душит звонки, поэтому перед
# каждой сборкой на проде — этот скрипт (его зовёт deploy.sh). Узел комнаты — `mediaNode` снимка;
# у комнат без него узел — управляющий (первая запись `infra/generated/nodes/registry.json` с `control: true`).
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Из worktree стека не видно (нет .env): CORD_INSTALL=/opt/ModernStreamingSystem указывает на установку.
cd "${CORD_INSTALL:-$REPO}" || exit 2

NODE=
if [[ ${1:-} == --node ]]; then NODE=${2:?--node <id>}; fi

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "Стек Cord не поднят (postgres не запущен) — встреч нет."
  exit 0
fi

node_filter=
if [[ -n $NODE ]]; then
  control=$(node -p "try{JSON.parse(require('fs').readFileSync('infra/generated/nodes/registry.json','utf8')).nodes.find(n=>n.control).id}catch{''}" 2>/dev/null)
  if [[ $NODE == "$control" ]]; then
    node_filter="AND (r.s->>'mediaNode' IS NULL OR r.s->>'mediaNode' = '$NODE')"
  else
    node_filter="AND r.s->>'mediaNode' = '$NODE'"
  fi
fi

sql="SELECT coalesce(s->>'title', '?') || ' · ' || coalesce(s->>'code', '?') || ' · узел ' || coalesce(s->>'mediaNode', '${control:-main}') || ' · людей: ' || count(*)
FROM (SELECT state::jsonb AS s FROM rooms) r, jsonb_each(r.s->'members') m(id, v)
WHERE r.s->>'closedAt' IS NULL
  AND m.v->>'status' IN ('JOINING', 'CONNECTED', 'RECOVERING')
  AND (m.v->>'service') IS NULL
  $node_filter
GROUP BY s->>'title', s->>'code', s->>'mediaNode';"

if ! out=$(docker compose exec -T postgres psql -U streaming -d streaming -At -c "$sql" 2>&1); then
  echo "Не удалось спросить базу ядра: $out" >&2
  exit 2
fi

if [[ -z $out ]]; then
  echo "Живых встреч нет${NODE:+ на узле $NODE}."
  exit 0
fi
echo "Идут встречи${NODE:+ на узле $NODE}:"
sed 's/^/  /' <<<"$out"
exit 1
