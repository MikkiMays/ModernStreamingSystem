---
name: cord-deploy
description: Use when Cord code changes must reach the running server (stand cord.nikg.tech or production), when "fixed but still broken" after a deploy, or when a Windows client release has to appear on /download.
---

# Выкатка Cord

## Какая служба что везёт

| Изменено | Служба |
| --- | --- |
| `web/**`, `infra/Dockerfile.web`, `infra/Caddyfile` | `gateway` (веб собирается **внутрь** него) |
| `server/**`, `pom.xml`, `infra/Dockerfile.server` | `core` (проверки, права, комнаты — тоже здесь) |
| `services/**` (кинозал, музыка, Telegram) | `services` и, если `services/sniffer/**`, `sniffer` |
| `compose.yaml`, `scripts/configure.mjs` | смотри `update.sh` — он сравнивает хэши конфигурации |

«Починил, а не работает» — чаще всего выкатили не ту службу (правило в `core`, а пересобран `gateway`).

## Команда

```bash
cd "$CORD_ROOT/ModernStreamingSystem"
backlog/bin/deploy.sh gateway core          # встречи → flock → build → up → health → коммит в бандле
```

- Скрипт сам зовёт `backlog/bin/active-meetings.sh` и откладывает выкатку, если идут встречи
  (`CORD_DEPLOY_FORCE=1` — только для стенда без людей).
- Сборка `services` и `core` долгая — запускать в фоне, не под `timeout`.
- Никогда `docker compose down -v` (сносит базу и файлы).

## После выкатки

1. `deploy.sh` проверяет, что коммит HEAD вшит в страницу (`<meta name="cord-build">`, снаружи —
   `curl -s https://<домен>/ | grep cord-build`). Человеку коммит не показывается нигде (владелец, 29.10.2026).
2. `curl -fsS https://cord.nikg.tech/api/v1/ping` и e2e по тронутым сценариям:
   `cd web && PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/<спек>.ts`
   (без переменной конфиг поднимает пустой dev-сервер — «всё падает»).
3. Изменения бэклога/доков выкатки не требуют.

## Релиз Windows

Пуш в `main` репы Windows запускает CI, который **выкладывает релиз**. Второй пуш подряд убивает выкладку
(останется черновик — удалить его через `gh api -X DELETE repos/MikkiMays/ModernStreamingSystem.Windows/releases/<id>`).
Затем зеркало: `gh api repos/MikkiMays/ModernStreamingSystem.Windows/releases/tags/vX.Y.Z > release.json`,
`gh release download vX.Y.Z -R MikkiMays/ModernStreamingSystem.Windows -D artifacts -p 'Cord-Setup-*' -p 'Cord-win-x64.zip*'`,
`python3 scripts/publish-windows-release.py release.json artifacts/`. Без зеркала клиенты новую версию не увидят.
