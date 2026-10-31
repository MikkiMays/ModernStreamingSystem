#!/usr/bin/env bash
# Выложить выпуск клиента Windows (Electron) на зеркало этого сервера, откуда его берут страница
# /download и обновление при запуске клиента:
#
#   backlog/bin/publish-windows.sh 1.1.0          # релиз desktop-v1.1.0 (флаг --desktop — по-старому, можно)
#
# Скачивает описание выпуска и его файлы с GitHub в пустой временный каталог и отдаёт их
# `scripts/publish-windows-release.py --desktop`: тот сверяет размеры и дайджесты, кладёт `Cord-Setup-X.Y.Z.exe`,
# `.blockmap`, `latest.yml` и `latest.yml.sig` в канал `/downloads/windows/desktop/` (`latest.yml` — последним) и
# переписывает `download.json`. Шлюз читает каталог `.local/windows-releases` только на чтение. Прежнего клиента
# WinUI (теги `vX.Y.Z`) больше нет — его режима здесь тоже (01.11.2026). Порядок выпуска — docs/RELEASE.md §7.
set -euo pipefail

BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$BIN/../.." && pwd)
REMOTE=MikkiMays/ModernStreamingSystem.Windows
if [ "${1:-}" = "--desktop" ]; then shift; fi
version=${1:?Какую версию? Например: $0 1.1.0}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Версия — X.Y.Z, а не «$version»" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/artifacts"

gh api "repos/$REMOTE/releases/tags/desktop-v$version" > "$work/release.json"
gh release download "desktop-v$version" -R "$REMOTE" -D "$work/artifacts" \
  -p "Cord-Setup-$version.exe" -p "Cord-Setup-$version.exe.sha256" \
  -p "Cord-Setup-$version.exe.blockmap" -p "Cord-Setup-$version.exe.blockmap.sha256" \
  -p "latest.yml" -p "latest.yml.sig"
cd "$REPO"
python3 -I scripts/publish-windows-release.py --desktop "$work/release.json" "$work/artifacts"
curl -fsS "https://$(sed -n 's/^APP_HOST=//p' .env | head -1)/downloads/windows/download.json" | head -c 300
echo
