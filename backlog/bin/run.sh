#!/usr/bin/env bash
# Запускает сессию Claude над бэклогом Cord в отдельном окне tmux.
#
#   backlog/bin/run.sh master          # большой прогон: текущая волна из README.md
#   backlog/bin/run.sh E05             # один эпик отдельной сессией
#   backlog/bin/run.sh resume master   # вернуться в последнюю сессию с этим именем
#
# Переменные: CORD_MODEL (opus[1m]), CORD_EFFORT (xhigh), CORD_PERMISSIONS (auto).
# Пути считаются от места скрипта, поэтому бэклог работает на любой машине, где рядом лежат
# обе репы. Под root Claude Code отказывается от bypassPermissions — там остаётся auto.
set -euo pipefail

BACKLOG=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(dirname "$BACKLOG")
ROOT=$(dirname "$REPO")
MODEL=${CORD_MODEL:-opus[1m]}
EFFORT=${CORD_EFFORT:-xhigh}
PERMISSIONS=${CORD_PERMISSIONS:-auto}

if [[ $PERMISSIONS == bypassPermissions && $(id -u) -eq 0 ]]; then
  echo "bypassPermissions под root не запустится: нужен отдельный пользователь или CORD_PERMISSIONS=auto" >&2
  exit 1
fi

target=${1:?"master | Exx | resume <имя>"}
export CORD_ROOT=$ROOT

if [[ $target == resume ]]; then
  name=cord-${2:?"имя: master или Exx"}
  exec tmux new-session -A -s "$name" -c "$ROOT" -e CORD_ROOT="$ROOT" \
    "claude --resume '$name' --model '$MODEL' --effort '$EFFORT' --permission-mode '$PERMISSIONS'; exec bash"
fi

if [[ $target == master ]]; then
  prompt="Прочитай $BACKLOG/README.md и работай по текущей волне, которую он называет (её PLAN.md и \
STATUS.md), по $BACKLOG/PROTOCOL.md. CORD_ROOT=$ROOT."
else
  # Эпики первой волны (T01–T59) закрыты и лежат в архиве; запуск по имени оставлен для повторов.
  epic=$(ls "$BACKLOG"/archive/*/epics/"$target"-*.md 2>/dev/null | head -1)
  [[ -n $epic ]] || { echo "Нет эпика $target в $BACKLOG/archive/*/epics" >&2; exit 1; }
  prompt="Ты делаешь один эпик бэклога Cord: $epic. CORD_ROOT=$ROOT. Сначала прочитай \
$BACKLOG/README.md (как устроен бэклог) и $BACKLOG/PROTOCOL.md, затем эпик. Другие эпики \
не начинай: закончив этот, обнови $BACKLOG/STATUS.md и журнал и остановись."
fi

name=cord-$target
exec tmux new-session -A -s "$name" -c "$ROOT" -e CORD_ROOT="$ROOT" \
  "claude -n '$name' --model '$MODEL' --effort '$EFFORT' --permission-mode '$PERMISSIONS' \"$prompt\"; exec bash"
