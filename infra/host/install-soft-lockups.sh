#!/usr/bin/env bash
# Поставить метрику замираний хоста (`soft-lockups.sh`) раз в пять минут через cron — команда владельца под root:
#
#   sudo bash infra/host/install-soft-lockups.sh
#
# Одной короткой строкой, потому что длинную при вставке в терминал рвёт перенос (01.11.2026).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Нужен root: sudo bash $0" >&2; exit 1; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Прежняя версия читала весь журнал ядра и копила проходы под нагрузкой — остановить их перед заменой.
pkill -f '^bash /usr/local/sbin/cord-soft-lockups' 2>/dev/null || true
pkill -f '^journalctl -k --no-pager -q -o cat' 2>/dev/null || true
install -m 0755 "$HERE/soft-lockups.sh" /usr/local/sbin/cord-soft-lockups
echo '*/5 * * * * root /usr/local/sbin/cord-soft-lockups' > /etc/cron.d/cord-soft-lockups
chmod 0644 /etc/cron.d/cord-soft-lockups
/usr/local/sbin/cord-soft-lockups
echo "Установлено: /usr/local/sbin/cord-soft-lockups, cron /etc/cron.d/cord-soft-lockups. Сейчас:"
grep -v '^#' /var/lib/node_exporter/textfile/cord_host.prom
