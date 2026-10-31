#!/usr/bin/env bash
# Автопилот на несколько суток: запускает неинтерактивные прогоны один за другим, пока не
# появится итог (journal/FINAL.md). Каждый прогон продолжает с того места, где остановился
# предыдущий: состояние живёт в файлах бэклога (и в git), а не в сессии.
#
# Запуск — только внутри tmux, чтобы пережить отключение:
#   tmux new -s cord-autopilot '<путь>/backlog/bin/autopilot.sh'
#
# Режим по умолчанию — auto: он работает и под root. bypassPermissions снимает все
# подтверждения, но под root Claude Code его не принимает — нужен отдельный пользователь.
set -uo pipefail

BACKLOG=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(dirname "$(dirname "$BACKLOG")")
MODEL=${CORD_MODEL:-opus[1m]}
EFFORT=${CORD_EFFORT:-xhigh}
PERMISSIONS=${CORD_PERMISSIONS:-auto}
PAUSE=${CORD_PAUSE_SECONDS:-900}   # пауза после прогона, кончившегося ошибкой (лимиты и т. п.)
LOG=$BACKLOG/journal/autopilot.log

if [[ $PERMISSIONS == bypassPermissions && $(id -u) -eq 0 ]]; then
  echo "bypassPermissions под root не запустится: нужен отдельный пользователь или CORD_PERMISSIONS=auto" >&2
  exit 1
fi

export CORD_ROOT=$ROOT
mkdir -p "$BACKLOG/journal"
WAVE=${CORD_WAVE:-release-1.1}
prompt="Прочитай $BACKLOG/README.md и работай по волне $WAVE ($BACKLOG/$WAVE/PLAN.md, STATUS.md). \
CORD_ROOT=$ROOT. Это неинтерактивный прогон автопилота: вопросов не задавай, блокирующее \
записывай в $BACKLOG/OWNER-ACTIONS.md. Перед тем как закончить ответ, допиши журнал текущего \
эпика, закоммить и запушь бэклог, чтобы следующий прогон продолжил без потерь."

run=0
while [[ ! -f $BACKLOG/$WAVE/FINAL.md ]]; do
  run=$((run + 1))
  echo "=== прогон $run, $(date -Is)" | tee -a "$LOG"
  cd "$ROOT"
  if claude -p --model "$MODEL" --effort "$EFFORT" --permission-mode "$PERMISSIONS" \
      "$prompt" >>"$LOG" 2>&1; then
    echo "--- прогон $run закончился, $(date -Is)" | tee -a "$LOG"
    sleep 30
  else
    echo "--- прогон $run упал (код $?), пауза $PAUSE с, $(date -Is)" | tee -a "$LOG"
    sleep "$PAUSE"
  fi
done
echo "=== готово: journal/FINAL.md, $(date -Is)" | tee -a "$LOG"
