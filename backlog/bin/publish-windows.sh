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
# Клиент на Electron (E01-B): `backlog/bin/publish-windows.sh --desktop 1.0.0` — релиз `desktop-v1.0.0`,
# файлы `Cord-Setup-1.0.0.exe`, `.blockmap`, `latest.yml`, `latest.yml.sig` в канал `/downloads/windows/desktop/`.
desktop=
if [ "${1:-}" = "--desktop" ]; then desktop=1; shift; fi
version=${1:?Какую версию? Например: $0 0.7.8 или $0 --desktop 1.0.0}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/artifacts"

if [ -n "$desktop" ]; then
  gh api "repos/$REMOTE/releases/tags/desktop-v$version" > "$work/release.json"
  gh release download "desktop-v$version" -R "$REMOTE" -D "$work/artifacts" \
    -p "Cord-Setup-$version.exe" -p "Cord-Setup-$version.exe.sha256" \
    -p "Cord-Setup-$version.exe.blockmap" -p "Cord-Setup-$version.exe.blockmap.sha256" \
    -p "latest.yml" -p "latest.yml.sig"
  cd "$REPO"
  python3 -I scripts/publish-windows-release.py --desktop "$work/release.json" "$work/artifacts"
else
  gh api "repos/$REMOTE/releases/tags/v$version" > "$work/release.json"
  gh release download "v$version" -R "$REMOTE" -D "$work/artifacts" \
    -p "Cord-Setup-$version-x64.exe" -p "Cord-Setup-$version-x64.exe.sha256" \
    -p "Cord-win-x64.zip" -p "Cord-win-x64.zip.sha256"
  cd "$REPO"
  python3 -I scripts/publish-windows-release.py "$work/release.json" "$work/artifacts"
fi
curl -fsS "https://$(sed -n 's/^APP_HOST=//p' .env | head -1)/downloads/windows/download.json" | head -c 300
echo
