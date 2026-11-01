#!/usr/bin/env bash
# Замирания хоста в метрику (R10, W1b шаг 7): сколько `soft lockup` видел журнал ядра Linux с загрузки
# и за сутки — файлом для textfile-коллектора node_exporter (`--collector.textfile.directory`, compose).
#
# Ставит владелец на хосте (контейнеры к `journalctl -k` не допущены), раз в пять минут:
#
#   sudo bash infra/host/install-soft-lockups.sh
#
# Читается только новое — с курсора прошлого прохода (`--after-cursor`), а не весь журнал: на стенде он
# 700 МБ, и полный проход на медленном диске шёл больше десяти минут, а cron звал следующий через пять — проходы
# копились и сами грузили машину (01.11.2026). `flock` не пускает второй проход, пока идёт первый. Состояние —
# рядом с метрикой: загрузка, курсор, счёт с загрузки и отметки за сутки. Файл метрики пишется целиком и
# подменяется атомарно: коллектор не прочитает половину.
set -euo pipefail

DIR=${1:-/var/lib/node_exporter/textfile}
mkdir -p "$DIR"
exec 9>"$DIR/.cord_host.lock"
flock -n 9 || exit 0

STATE="$DIR/.cord_host.state"
STAMPS="$DIR/.cord_host.stamps"
boot=$(cat /proc/sys/kernel/random/boot_id)
saved_boot="" cursor="" total=0
[[ -f "$STATE" ]] && source "$STATE"

if [[ "$saved_boot" != "$boot" ]]; then
  # Новая загрузка (или первый запуск): счёт с нуля, а курсор — в конец журнала, без чтения истории. Первый
  # запуск после прежней версии сохраняет её счёт с загрузки, если загрузка та же.
  total=0
  if [[ -z "$saved_boot" && -f "$DIR/cord_host.prom" ]]; then
    total=$(sed -n 's/^cord_host_soft_lockups_total \([0-9]*\)$/\1/p' "$DIR/cord_host.prom" | head -1)
    total=${total:-0}
  fi
  cursor=$(journalctl -k -b -n 1 --show-cursor -q -o cat 2>/dev/null | sed -n 's/^-- cursor: //p' | tail -1)
  : >"$STAMPS"
else
  new=$(journalctl -k --after-cursor="$cursor" --show-cursor --no-pager -q -o short-unix 2>/dev/null || true)
  next=$(sed -n 's/^-- cursor: //p' <<<"$new" | tail -1)
  [[ -n "$next" ]] && cursor=$next
  while read -r stamp; do
    [[ -n "$stamp" ]] || continue
    total=$((total + 1))
    echo "${stamp%%.*}" >>"$STAMPS"
  done < <(grep 'soft lockup' <<<"$new" | awk '{print $1}')
fi

now=$(date +%s)
touch "$STAMPS"
awk -v since=$((now - 86400)) '$1 >= since' "$STAMPS" >"$STAMPS.tmp" && mv -f "$STAMPS.tmp" "$STAMPS"
day=$(wc -l <"$STAMPS")
printf 'saved_boot=%q\ncursor=%q\ntotal=%q\n' "$boot" "$cursor" "$total" >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"

tmp=$(mktemp "$DIR/.cord_host.XXXXXX")
cat >"$tmp" <<EOF
# HELP cord_host_soft_lockups_total Замирания хоста (soft lockup в журнале ядра) с загрузки.
# TYPE cord_host_soft_lockups_total counter
cord_host_soft_lockups_total $total
# HELP cord_host_soft_lockups_day Замирания хоста за последние сутки.
# TYPE cord_host_soft_lockups_day gauge
cord_host_soft_lockups_day $day
# HELP cord_host_soft_lockups_scraped_at Когда счёт обновлён (unix time).
# TYPE cord_host_soft_lockups_scraped_at gauge
cord_host_soft_lockups_scraped_at $now
EOF
chmod 0644 "$tmp"
mv -f "$tmp" "$DIR/cord_host.prom"
