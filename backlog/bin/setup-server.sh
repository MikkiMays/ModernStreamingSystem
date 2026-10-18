#!/usr/bin/env bash
# Готовит новую машину к работе над бэклогом Cord: проверяет инструменты, кладёт рядом репу
# Windows и ставит плагины Claude Code. Повторный запуск безопасен. Секретов не трогает —
# вход в Claude и GitHub, перенос .env и cookies делает владелец (OWNER-ACTIONS.md).
set -uo pipefail

BACKLOG=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO=$(dirname "$BACKLOG")
ROOT=$(dirname "$REPO")
missing=0

echo "CORD_ROOT=$ROOT"
for tool in git tmux docker node npm claude; do
  if command -v "$tool" >/dev/null; then
    printf '  %-7s %s\n' "$tool" "$("$tool" --version 2>/dev/null | head -1)"
  else
    printf '  %-7s НЕТ\n' "$tool"; missing=1
  fi
done
docker compose version >/dev/null 2>&1 || { echo "  docker compose НЕТ"; missing=1; }
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "  gh      вход выполнен" \
  || echo "  gh      нет или не вошли — нужен gh auth login или токен в окружении (OWNER-ACTIONS.md)"

if [[ ! -d $ROOT/ModernStreamingSystem.Windows/.git ]]; then
  url=$(git -C "$REPO" remote get-url origin | sed 's/ModernStreamingSystem\(\.git\)\?$/ModernStreamingSystem.Windows.git/')
  echo "Клонирую репу Windows: $url"
  git clone "$url" "$ROOT/ModernStreamingSystem.Windows" || missing=1
fi

if command -v claude >/dev/null; then
  claude plugin marketplace list 2>/dev/null | grep -q claude-plugins-official \
    || claude plugin marketplace add anthropics/claude-plugins-official
  for plugin in superpowers frontend-design playwright context7 figma feature-dev \
      code-simplifier skill-creator mattpocock-skills vercel claude-md-management plugin-dev \
      typescript-lsp jdtls-lsp csharp-lsp pyright-lsp gopls-lsp; do
    claude plugin install "$plugin@claude-plugins-official" >/dev/null 2>&1 \
      && echo "  плагин $plugin" || echo "  плагин $plugin — не поставился, проверь вручную"
  done
fi

cat <<NEXT

Дальше руками (один раз):
  1. claude → /login (план Max); затем /mcp → figma и context7 → авторизоваться в браузере.
  2. Для переезда прода — OWNER-ACTIONS.md → «Перед запуском на новом сервере».
  3. Запуск: $BACKLOG/bin/run.sh master
NEXT
exit $missing
