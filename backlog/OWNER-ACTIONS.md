# Что нужно от владельца

Только то, что может сделать или решить владелец. Работа над остальным не стоит. Отвечать — строкой
«Ответ:» под пунктом или в сессии; ответ переносится в `DECISIONS.md` → «Решено владельцем».
Полная история пунктов 18–25.10.2026 с ответами — `archive/2026-10-wave1/OWNER-ACTIONS-2026-10.md`.

Сверено с машиной 31.10.2026: `gh` авторизован, ключ подписи обновлений в секрете CI, `ADMIN_PASSWORD`
задан, Figma сделана, вопрос Cloudflare разобран (R92) — эти пункты закрыты.

## Открыто

1. **Хост `cord.nikg.tech` — одна команда под root** (`swappiness = 10` уже сохранён в
   `/etc/sysctl.d/90-cord-dev.conf`; задачу cron агенту не даёт поставить автоматический режим среды). Метрика
   замираний хоста (`cord_host_soft_lockups_*`, «Cord — медиа», алерт `HostSoftLockups`):
   ```bash
   install -m 0755 /opt/ModernStreamingSystem/infra/host/soft-lockups.sh /usr/local/sbin/cord-soft-lockups && echo '*/5 * * * * root /usr/local/sbin/cord-soft-lockups' > /etc/cron.d/cord-soft-lockups && /usr/local/sbin/cord-soft-lockups && cat /var/lib/node_exporter/textfile/cord_host.prom
   ```
   В сессии Claude Code — с префиксом `! `.
   Ответ:
2. **Выделенные ядра.** Хост стенда замирает (soft lockup), steal до 60 %, диск ~7 МБ/с — кодом не чинится.
   Решение по тарифу или хостеру — ваше. Сравнивать до/после — по `cord_probe_loss_ratio{leg="down"}` и
   метрике из п. 1.
   Ответ:
3. ~~Доступ к `meet.nikg.tech` и `cordcam.ru` для выкатки~~ — **снято 01.11.2026**: «раскатывать на другие
   сервера тебе не нужно»; выкатка — только этот стенд, для остальных — инструкция `docs/RELEASE.md`.
   Ответ: снято владельцем.
4. **Алерты и поддержка в Telegram.** В `.env` пусто: `ALERT_TELEGRAM_CHAT_ID` (куда слать алерты),
   `SUPPORT_TELEGRAM_CHAT_ID` (куда — обращения; без него — в чат алертов), `HEALTHCHECKS_URL` (внешняя
   проверка «жива ли машина», healthchecks.io, период 1 мин, льгота 10 мин). Пока чата нет, обращения
   копятся в базе и не теряются.
   Ответ:
5. **Сменить токен GitHub**, вставленный в чат 19.10 с правами администратора. Для работы хватает
   fine-grained: Contents, Actions, Workflows — запись, только две репы Cord.
   Ответ:
6. **Ключ каталога серверов для прода.** Каталог подписан ключом стенда (`.local/cord-catalog-key.pem`).
   Свой ключ: `node scripts/sign-catalog.mjs keygen --out <путь>.pem`, JWK — вторым ключом в
   `contracts/catalog-keys.json` и `desktop/build/catalog-keys.json`, выпуск клиента, затем `sign`. Срок
   нынешнего каталога — до 2027-04-18.
   Ответ:
7. ~~DNS для VPN (R149, Р-50)~~ — **сделано 01.11.2026**: записи `rtc.`/`turn.cord.nikg.tech` и
   `rtc.`/`turn.cordcam.ru` есть; стенд переведён в `strict`, TURN/TLS на 443 проверен (`turn-relay-check.mjs
   --transport=tls`). cordcam.ru переводится так же — `docs/RELEASE.md`.
   Ответ: записи добавлены владельцем.
8. **Подпись установщика Windows** — сертификат OV/EV или Azure Trusted Signing. Без него SmartScreen.
   Ответ:
9. **Живые проверки, которых не сделать на сервере** — список релиза 1.1: `release-1.1/STATUS.md` →
   «Проверка владельцем» (захват показа 1080p60 с видеокарты и кодек в «Диагностике», микрофон Android в
   фоне, VPN в приложении, фон в видео на слабом ноутбуке, доска с телефона).
   Ответ:
10. **Вычитка переводов носителями** — не блокирует. Больше всего выиграют правила игр, `download.warning.*`,
   `errors`, китайский целиком (`web/src/i18n/locales/<язык>.json`, слова — `web/src/i18n/GLOSSARY.md`).
   Ответ:
11. **Telegram Mini App** — код готов и выключен (`TELEGRAM_WEBAPP_ENABLED`). Включить: BotFather → Configure
    Mini App → `https://<домен>/tg`, затем флаг в `.local/telegram.env` и перезапуск `services`
    (`docs/deployment.md` → «Telegram Mini App»).
    Ответ:
12. **Магазины приложений** — только если понадобятся: Apple Developer ($99/год) для TestFlight/iOS,
    Google Play Console ($25) для публикации Android. Сейчас APK собирает CI.
    Ответ:
