---
name: cord-telegram-mini-app
description: Как Mini App Telegram открывает встречу Cord из беседы и три стены платформы — кнопка web_app в группах, рамка Telegram Web и скрипт с telegram.org
metadata:
  type: project
---

Mini App Cord (E09, 20.10.2026) — отдельный HTML-вход `/tg` (`web/tg.html`, `web/src/telegram/`), за флагом службы
`TELEGRAM_WEBAPP_ENABLED`.

**Why:** у платформы три стены, о которые спотыкаешься первым делом.
1. Кнопка `web_app` (inline, reply и меню) в группах запрещена Bot API — работает только url-кнопка
   `https://t.me/<бот>?startapp=<параметр>&mode=fullscreen` (главный Mini App из BotFather). Параметр приходит в
   `initData.start_param`; в Cord это номер привязки беседы (`telegram_links`), а не код комнаты.
2. Telegram Web (Web A, Web K) открывает Mini App в iframe — с `frame-ancestors 'none'` он пустой. Шлюз разрешает рамку
   `https://web.telegram.org` только путям `/tg` и `/tg/`; остальное держит `'none'` (`infra/csp-check.sh`).
3. Официальный `telegram-web-app.js` — скрипт с telegram.org, его не пускает `script-src 'self'`; поэтому
   `@tma.js/sdk` в бандле. Его мост можно подменить в тестах (`mockTelegramEnv`) и в браузере
   (`window.TelegramWebviewProxy.postEvent` + `Telegram.WebView.receiveEvent`, `web/scripts/tg-shots.mjs`).

**How to apply:** `initData` доверять только после HMAC по токену бота (эталон — docs.telegram-mini-apps.com,
токен `5768337691:…`); членство в беседе — `getChatMember`, а не `chat_instance`. Без настоящего бота всё проверяется
подменой; живое (камера в WebView iOS/Android, закреп в теме форума) — только на телефоне владельца.

Связано: [[cord-web-on-phone]].
