---
name: cord-deploy
description: Use when Cord code changes must reach a running server (stand cord.nikg.tech or another server), when "fixed but still broken" after a deploy, when the SFU config must be refreshed, or when a Windows client release has to appear on /download.
---

# Выкатка Cord

Полный порядок — `docs/RELEASE.md` (версии, проверки, стенд, другие серверы, переход в `strict`, клиент Windows,
APK, учёт, ловушки). Здесь — только быстрая памятка.

## Какая служба что везёт

| Изменено | Служба |
| --- | --- |
| `web/**`, `infra/Dockerfile.web`, `infra/Caddyfile` | `gateway` (веб собирается **внутрь** него) |
| `server/**`, `pom.xml`, `infra/Dockerfile.server`, `contracts/errors.json` | `core` (проверки, права, комнаты, миграции Flyway; реестр ошибок лежит в jar — счётчик ошибок клиента, R180) |
| `services/**` (кинозал, музыка, Telegram) | `services` и, если `services/sniffer/**`, `sniffer` |
| `scripts/configure.mjs`, `edge-config.mjs`, `turn-guard.mjs` | `node scripts/configure.mjs --refresh` + `docker compose restart livekit` (и `edge`) |
| `compose.yaml` | служба с изменённой конфигурацией: `docker compose up -d --no-deps <служба>` |
| `docs/**`, `backlog/**`, `mobile/**` | на сервере ничего |

«Починил, а не работает» — чаще всего выкатили не ту службу (правило в `core`, а пересобран `gateway`).

## Стенд cord.nikg.tech (эта машина, `strict`)

```bash
cd /opt/ModernStreamingSystem          # только отсюда: в worktree нет .env
git status -sb && git pull --ff-only
backlog/bin/active-meetings.sh         # 0 — пусто
TAG=cord-rollback-$(date +%Y%m%d-%H%M%S); for s in core gateway; do docker tag modern-streaming-$s:latest $TAG-$s:latest; done
backlog/bin/deploy.sh core gateway     # встречи → flock → build → up по одной → health → cord-build = HEAD
```

- Идут встречи — подождать или `backlog/bin/deploy.sh --drain <службы>` (нужен `ADMIN_PASSWORD`);
  `CORD_DEPLOY_FORCE=1` — только если людей нет.
- Сборка `core`/`services` долгая — в фоне, не под `timeout`.
- `deploy.sh` LiveKit не перезапускает: после `--refresh` — `backlog/bin/active-meetings.sh && docker compose restart livekit`.
- Никогда `docker compose down -v` и голый `docker compose up -d` (поднимет профиль `monitoring`).

После: `curl -s https://cord.nikg.tech/ | grep -o 'name="cord-build" content="[^"]*"'` = `git rev-parse --short HEAD`,
`curl -fsS https://cord.nikg.tech/api/v1/ping`, `node scripts/smoke.mjs`, e2e тронутого:
`cd web && PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/<спек>.ts` — не больше 10 новых
встреч в час с адреса. Откат — `docker tag $TAG-<служба>:latest modern-streaming-<служба>:latest` и
`docker compose up -d --no-deps <служба>`.

## Другие серверы

Отсюда ssh нет — выкатывает тот, у кого он есть: `backlog/bin/active-meetings.sh`, `./update.sh --check`,
`sudo ./update.sh` (встреч он не проверяет). Переход в `strict` — `docs/RELEASE.md` → «Переход в strict».

## Клиент Windows (Electron)

1. Репа Windows: номер в `desktop/package.json` (`npm version X.Y.Z --no-git-tag-version`) и
   `docs/releases/desktop-X.Y.Z.md` — одним коммитом с правкой `desktop/`; пуш в `main` → `desktop.yml` выпускает
   `desktop-vX.Y.Z`. Без нового номера — зелёный прогон и ничего нового.
2. Зеркало: `backlog/bin/publish-windows.sh --desktop X.Y.Z` из `/opt/ModernStreamingSystem`. Без зеркала новую
   версию не видят ни `/download`, ни клиенты.
3. cordcam: `git merge --no-ff origin/main` в `deploy/cordcam` (worktree `--detach` от `origin/deploy/cordcam`),
   `git push origin HEAD:deploy/cordcam` → предварительный релиз `cordcam-desktop-vX.Y.Z`; его зеркало — на
   сервере cordcam.
