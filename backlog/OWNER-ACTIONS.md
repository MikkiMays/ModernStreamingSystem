# Что нужно от владельца

Только то, что может сделать или решить владелец. Работа над остальным не стоит. Отвечать — строкой
«Ответ:» под пунктом или в сессии; ответ переносится в `DECISIONS.md` → «Решено владельцем».
Полная история пунктов 18–25.10.2026 с ответами — `archive/2026-10-wave1/OWNER-ACTIONS-2026-10.md`.

Сверено с машиной 31.10.2026: `gh` авторизован, ключ подписи обновлений в секрете CI, `ADMIN_PASSWORD`
задан, Figma сделана, вопрос Cloudflare разобран (R92) — эти пункты закрыты.

## Открыто

1. **Хост `cord.nikg.tech` — две команды под root** (агенту запись в `/etc` и cron запрещена средой; сами
   значения уже в работе: `swappiness` выставлен до перезагрузки):
   ```bash
   printf 'vm.swappiness = 10\n' > /etc/sysctl.d/90-cord.conf && sysctl --system
   install -m 0755 /opt/ModernStreamingSystem/infra/host/soft-lockups.sh /usr/local/sbin/cord-soft-lockups && \
     echo '*/5 * * * * root /usr/local/sbin/cord-soft-lockups' > /etc/cron.d/cord-soft-lockups
   ```
   Первая переживает перезагрузку, вторая даёт метрику замираний хоста (`cord_host_soft_lockups_*`, панель
   «Cord — медиа», алерт `HostSoftLockups`).
   Ответ:
2. **Выделенные ядра.** Хост стенда замирает (soft lockup), steal до 60 %, диск ~7 МБ/с — кодом не чинится.
   Решение по тарифу или хостеру — ваше. Сравнивать до/после — по `cord_probe_loss_ratio{leg="down"}` и
   метрике из п. 1.
   Ответ:
3. **Доступ к `meet.nikg.tech` (108.165.32.23) и `cordcam.ru` (157.22.241.114) для выкатки.** Ключ этой
   машины там не принят (`publickey`). Либо добавить его в `authorized_keys`, либо стенды выкатывает
   параллельная сессия — тогда ничего не нужно.
   Ответ:
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
7. **DNS для VPN (R149, Р-50).** Чтобы звонок шёл там, где открыт только TCP 443 (VPN, офисные сети), TURN/TLS
   нужен на 443 — это режим `strict` с тремя именами. Записи A: `rtc.cord.nikg.tech` и `turn.cord.nikg.tech` →
   108.165.32.75; для `cordcam.ru` — `rtc.cordcam.ru` и `turn.cordcam.ru` → 157.22.241.114 (DNS only, без прокси).
   После записей стенд переводится в `strict` одной командой (`configure.mjs --refresh`) и перезапуском edge и SFU.
   Ответ:
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
