#!/usr/bin/env bash
# Замирания хоста в метрику (R10, W1b шаг 7): сколько `soft lockup` видел журнал ядра Linux с загрузки
# и за сутки — файлом для textfile-коллектора node_exporter (`--collector.textfile.directory`, compose).
#
# Ставит владелец на хосте (контейнеры к `journalctl -k` не допущены), раз в пять минут:
#
#   sudo install -m 0755 infra/host/soft-lockups.sh /usr/local/sbin/cord-soft-lockups
#   echo '*/5 * * * * root /usr/local/sbin/cord-soft-lockups' | sudo tee /etc/cron.d/cord-soft-lockups
#
# Каталог — тот, что смонтирован в node-exporter (`/var/lib/node_exporter/textfile`). Файл пишется
# целиком и подменяется атомарно: коллектор не прочитает половину.
set -euo pipefail

DIR=${1:-/var/lib/node_exporter/textfile}
mkdir -p "$DIR"

count() { journalctl -k --no-pager -q -o cat "$@" 2>/dev/null | grep -c 'soft lockup' || true; }
# С загрузки — счётчик (Prometheus переживёт сброс при перезагрузке), за сутки — для глаза.
boot=$(count)
day=$(count --since -24h)

tmp=$(mktemp "$DIR/.cord_host.XXXXXX")
cat >"$tmp" <<EOF
# HELP cord_host_soft_lockups_total Замирания хоста (soft lockup в журнале ядра) с загрузки.
# TYPE cord_host_soft_lockups_total counter
cord_host_soft_lockups_total $boot
# HELP cord_host_soft_lockups_day Замирания хоста за последние сутки.
# TYPE cord_host_soft_lockups_day gauge
cord_host_soft_lockups_day $day
# HELP cord_host_soft_lockups_scraped_at Когда счёт обновлён (unix time).
# TYPE cord_host_soft_lockups_scraped_at gauge
cord_host_soft_lockups_scraped_at $(date +%s)
EOF
chmod 0644 "$tmp"
mv -f "$tmp" "$DIR/cord_host.prom"
