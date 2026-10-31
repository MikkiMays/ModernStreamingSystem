# Cord

Закрытый продукт для видеовстреч: эта репа — ядро, веб, службы, инфраструктура, Android и бэклог; клиент Windows
(Electron) — соседняя `ModernStreamingSystem.Windows`. Подробнее — `AGENTS.md`.

- Начало работы — `backlog/README.md`; выпуск и выкатка — `docs/RELEASE.md`.
- Скиллы проекта — `.claude/skills/` (`cord-deploy`, `cord-server-tests`, `cord-i18n`, `cord-verify-ui`,
  `cord-live-call`).
- Работа — в своём worktree от свежего `origin/main`; выкатка — только из `/opt/ModernStreamingSystem`.

Жёсткие правила:

1. Никогда: `docker compose down -v`, force-push, `reset --hard` чужой работы, правка применённой миграции.
2. Выкатка — только без идущих встреч (`backlog/bin/active-meetings.sh`); `CORD_DEPLOY_FORCE=1` — только если людей нет.
3. Контракты — только `backlog/bin/gen-contracts.sh`, сгенерированное руками не правится.
4. Документы, коммиты и журналы — по-русски.
5. Только владелец (DNS, ключи, токены, оплата, root на хосте) — в `backlog/OWNER-ACTIONS.md`.
