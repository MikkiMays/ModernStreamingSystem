#!/usr/bin/env bash
# Поставить или обновить прокси YouTube на этом узле (R196). Запускать на узле за рубежом из каталога с этими файлами.
#
#   sudo bash install.sh <адрес-сервера-cord> [ещё адреса…]
#
# Кто может подключаться — только перечисленные адреса. Пароль создаётся один раз и лежит здесь же в `.password` (0600);
# в репозиторий и журналы не попадает. Строка для `.env` сервера Cord печатается без пароля — см. docs/architecture/rollout.md.
set -euo pipefail
cd "$(dirname "$0")"
[[ $# -ge 1 ]] || { echo "Нужен хотя бы один адрес сервера Cord" >&2; exit 2; }
umask 077
[[ -s .password ]] || openssl rand -hex 24 > .password
printf 'cord:%s\n' "$(openssl passwd -apr1 "$(cat .password)")" > passwd
# Squid внутри контейнера читает файл своим пользователем.
chmod 644 passwd
docker compose pull -q
docker compose up -d --force-recreate
ufw delete allow 3128/tcp >/dev/null 2>&1 || true
for ip in "$@"; do ufw allow from "$ip" to any port 3128 proto tcp comment 'cord youtube proxy' >/dev/null; done
sleep 2
docker compose ps --format '{{.Name}} {{.Status}}'
echo "Готово. На сервере Cord в .env: CINEMA_PROXY_YOUTUBE=http://cord:<пароль из $(pwd)/.password>@$(hostname -I | cut -d' ' -f1):3128"
