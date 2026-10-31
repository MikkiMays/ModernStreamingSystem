# Cord — вход для агентов

Cord — закрытый продукт для видеовстреч. Две репы лежат рядом в `$CORD_ROOT` (на `cord.nikg.tech` — `/opt`):

- `ModernStreamingSystem` — ядро `server/` (Java, Spring), веб `web/` (React, TypeScript), службы `services/`
  (Python, Go), контракты `contracts/`, инфраструктура `infra/`, `compose.yaml`, приложение Android `mobile/`,
  документы `docs/`, бэклог `backlog/`.
- `ModernStreamingSystem.Windows` — клиент Windows на Electron (`desktop/`).

С чего начать: `backlog/README.md` (текущая волна, протокол задачи, решения), карта системы — `backlog/CONTEXT.md`.
Выпуск и выкатка — `docs/RELEASE.md`. Работа — в своём worktree от свежего `origin/main`; `/opt/ModernStreamingSystem`
— каталог установки стенда, выкатка только из него. Параллельно работает другая сессия — чужие коммиты не терять.

Жёсткие правила:

1. Никогда: `docker compose down -v`, force-push, `reset --hard` чужой работы, правка применённой миграции Flyway.
2. Выкатка — только без идущих встреч (`backlog/bin/active-meetings.sh`); `CORD_DEPLOY_FORCE=1` — только когда людей
   на стенде нет.
3. Контракты (`contracts/openapi.json`, `web/src/api/generated.ts`) — только `backlog/bin/gen-contracts.sh`, руками не
   правятся.
4. Документы, коммиты и журналы — по-русски, в стиле соседних.
5. То, что может сделать только владелец (DNS, ключи и сертификаты, токены, оплата, команды root на хосте), — в
   `backlog/OWNER-ACTIONS.md`; остальная работа его не ждёт.
