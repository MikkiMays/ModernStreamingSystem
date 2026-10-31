#!/usr/bin/env bash
# Больше не нужен (01.11.2026): SFU не держит сертификата ни в одном режиме. TURN/TLS есть только в
# strict, где TLS снимает edge; в simple и ip его нет вовсе — LiveKit 1.13 объявляет `turns:<имя>:443`
# при любом включённом TLS, а 443 под одним именем — это HTTPS (scripts/edge-config.mjs).
#
# Файл оставлен, чтобы записи cron прежних установок (`17 4 * * * … bash scripts/turn-cert.sh`) молча
# проходили, а не падали каждую ночь. Запись можно убрать: `crontab -l | grep -v turn-cert.sh | crontab -`.
echo "turn-cert.sh: не нужен — SFU не держит сертификата TURN (TURN/TLS только в strict, через edge)."
exit 0
