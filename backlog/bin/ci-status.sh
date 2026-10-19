#!/usr/bin/env bash
# Последние прогоны CI обеих реп Cord на main (или на ветке из первого аргумента).
#
#   backlog/bin/ci-status.sh            # main, по 5 прогонов
#   backlog/bin/ci-status.sh epic/E05 3 # своя ветка и число прогонов
#
# Доступ — через `gh` (владелец один раз делает `gh auth login`), иначе токен из окружения
# (GH_TOKEN/GITHUB_TOKEN). Репозитории приватные: без доступа API отвечает 404, это не
# «прогонов нет». Код выхода 1 — последний прогон какой-то из реп не зелёный.
set -euo pipefail

BRANCH=${1:-main}
COUNT=${2:-5}
OWNER=${CORD_GH_OWNER:-MikkiMays}

api() {
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh api "$1"
  elif [[ -n ${GH_TOKEN:-${GITHUB_TOKEN:-}} ]]; then
    curl -fsS -H "Authorization: Bearer ${GH_TOKEN:-$GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
  else
    echo "Нет доступа к GitHub: gh auth login или GH_TOKEN в окружении" >&2
    exit 2
  fi
}

red=0
for repo in ModernStreamingSystem ModernStreamingSystem.Windows; do
  echo "== $repo ($BRANCH)"
  json=$(api "repos/$OWNER/$repo/actions/runs?branch=$BRANCH&per_page=$COUNT")
  python3 -c '
import json, sys
runs = json.loads(sys.argv[1]).get("workflow_runs", [])
if not runs:
    print("  прогонов нет")
for r in runs:
    state = r["conclusion"] or r["status"]
    print(f"  {r[\"created_at\"][:16]}  {r[\"head_sha\"][:7]}  {state:<11} {r[\"name\"]}  {r[\"html_url\"]}")
latest = runs[0]["conclusion"] if runs else "success"
sys.exit(0 if latest in ("success", None) else 1)
' "$json" || red=1
done
exit $red
