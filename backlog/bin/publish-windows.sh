#!/usr/bin/env bash
# Выложить выпуск клиента Windows на зеркало этого сервера (`/downloads/windows/`), откуда его берут
# страница /download и обновление при запуске клиента.
#
#   backlog/bin/publish-windows.sh 0.7.8
#
# Скачивает описание выпуска и его файлы с GitHub в пустой временный каталог и отдаёт их
# `scripts/publish-windows-release.py`: тот сверяет размеры и дайджесты с описанием и только после
# этого переключает latest.json. Шлюз читает каталог `.local/windows-releases` только на чтение.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
REMOTE=MikkiMays/ModernStreamingSystem.Windows
version=${1:?Какую версию? Например: $0 0.7.8}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/artifacts"

gh api "repos/$REMOTE/releases/tags/v$version" > "$work/release.json"
gh release download "v$version" -R "$REMOTE" -D "$work/artifacts" \
  -p "Cord-Setup-$version-x64.exe" -p "Cord-Setup-$version-x64.exe.sha256" \
  -p "Cord-win-x64.zip" -p "Cord-win-x64.zip.sha256"

cd "$REPO"
python3 -I scripts/publish-windows-release.py "$work/release.json" "$work/artifacts"
curl -fsS "https://$(sed -n 's/^APP_HOST=//p' .env | head -1)/downloads/windows/latest.json" | head -c 300
echo
