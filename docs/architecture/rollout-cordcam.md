# Переезд всей сети Cord на `cordcam.ru`: инструкция для исполнителя с доступом ко всем серверам (R200)

Для кого: человек или ИИ-агент (GPT владельца), у которого есть SSH ко всем четырём серверам, но **нет контекста**
проекта. Делать ровно по порядку, после каждого шага — проверка; не сошлось — остановиться и написать владельцу.
Проект — `docs/architecture/server-selection.md` (§6–§7), база — `docs/architecture/rollout.md` (R198: узлы, магистраль,
реестр; **читать его разделы 2, 3, 7 обязательно** — здесь они не повторяются).

Пометки: **[проверено]** — выполнялось 08.11.2026; **[код фазы 2]** — требует кода, которого на 08.11.2026 нет
(`server-selection.md` §8.6); до его выкатки шаг не делать; **[не проверено]** — по коду и документации.

**Решения владельца 08.11.2026:** «все домены мои, поэтому все лишнее можно удалять»; «callcord поставим на этот
сервер, а cordcam теперь будет один общий на все». Старые имена `nikg.tech` удаляются в момент переезда, а не через 30
дней.

**Схема изменена владельцем 08.11.2026 (Р-110):** «все управление и админ панель будет теперь только на этом сервере,
а остальные будут служить рабочими машинами для проекта. На этот сервер больше нельзя подключаться пользователям… Из
германии остается сервер meet.nikg.tech»; «callcord поставим на этот сервер, а cordcam теперь будет один общий на все».
Итог: A (108.165.32.75, `callcord.ru`) — разработка и админ-панель, людей нет; **meet
(108.165.32.23) — продукт `cordcam.ru`** (ядро, база, сайт) и медиаузел `fra`; B — узел `hel`; cordcam — узел `msk`.
Разделы 3–6 ниже написаны под прежнюю схему (продукт на A) и будут переписаны главной сессией вместе с проектом
админ-панели — **их не выполнять**. Выполнять: «Сейчас», затем «Шаг 2» (продукт на meet).

**Порядок для исполнителя.** Сейчас — только раздел **«Сейчас»** ниже: он ничего не меняет у людей. Разделы 3–6 —
**только по сигналу** владельца, который передаст сообщение главной сессии «код выкачен, DNS переключён, делай раздел N».
Без сигнала их не начинать, даже если всё кажется готовым.

## Сейчас (до сигнала): подготовка, ничего не меняет у людей

1. **Характеристики серверов cordcam (157.22.241.114) и meet (108.165.32.23)** — для ёмкости узлов:
   ```bash
   nproc; free -g | sed -n 2p; df -h / | tail -1; lsb_release -ds; uname -r
   cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/speed 2>/dev/null   # Мбит/с порта, если отдаёт
   docker --version; docker compose version
   ss -ltnup | grep -E ':(80|443|3478|5349|7880|7881|7882|8443) '
   ```
   Плюс тариф и лимит трафика у хостера, если знаешь.
2. **Замер YouTube на cordcam** — раздел 5.1 ниже, ровно его команда. Записать скорость и ошибки.
3. **Бэкапы обеих установок (cordcam и meet)**, ничего не останавливая: из каталога установки
   ```bash
   docker compose exec -T postgres pg_dump -U streaming streaming | gzip > /root/$(hostname)-cord-$(date +%F).sql.gz
   cp .env /root/$(hostname)-cord.env.bak && chmod 600 /root/$(hostname)-cord.env.bak
   docker compose ps > /root/$(hostname)-cord-ps.txt; git -C . log --oneline -1 > /root/$(hostname)-cord-version.txt
   ```
   (имя пользователя базы сверить с `.env`: `POSTGRES_USER`). Файлы остаются на своих серверах.
4. **Ключи для команд узлов**: на A положить приватные ключи к cordcam и meet — `/root/.ssh/cord_msk` и
   `/root/.ssh/cord_fra` (0600), и проверить с A: `ssh -i /root/.ssh/cord_msk -o BatchMode=yes root@157.22.241.114 true`
   и `ssh -i /root/.ssh/cord_fra -o BatchMode=yes root@108.165.32.23 true`. Ключи в git и в отчёт не попадают.
5. **Отчёт владельцу** одним сообщением: пп. 1–2 цифрами, п. 3 — пути файлов и размеры, п. 4 — «ssh с A работает» по
   каждому, плюс всё необычное (чужие сервисы на портах 80/443/3478, нехватка диска, старая ОС). Владелец передаст его
   главной сессии.

На этом всё до сигнала. **Не делать сейчас**: не останавливать и не переконфигурировать установки cordcam и meet, не
трогать A (кроме п. 4), не менять DNS.

## Шаг 2 (по сигналу 08.11.2026 — DNS уже переключён): продукт `cordcam.ru` на meet одним узлом

Владелец 08.11.2026 перевёл `cordcam.ru` и `www` на meet (108.165.32.23) и удалил старые `rtc`/`turn.cordcam.ru`:
старая установка cordcam по имени больше недоступна, «ничего страшного если временно сайты не будут работать». Задача —
поднять продукт на meet под именами `cordcam.ru` (сайт), `rtc-fra.cordcam.ru` (медиа), `turn-fra.cordcam.ru` (TURN);
`www.cordcam.ru` владелец удаляет.
Медиаузлы `hel` и `msk` подключаются позже, отдельным шагом. Основа — `docs/RELEASE.md` §6 («Перед обновлением»,
«Обновление», «Переход в strict»); ниже — только то, чем этот случай отличается. Порядок строгий.

**2.0. Условие.** «Сейчас» выполнен и отчёт отдан. DNS с самого meet:
```bash
for h in cordcam.ru rtc-fra.cordcam.ru turn-fra.cordcam.ru; do printf '%-22s %s\n' $h "$(getent ahostsv4 $h | awk 'NR==1{print $1}')"; done
# все три — 108.165.32.23; иначе остановиться
```

**2.1. Соседи на 443.** На meet рядом с Cord живут другие сайты (апекс `nikg.tech`, `app.`, `media.`, `remote.nikg.tech`,
скрипт `scripts/cohost-cutover.py`). Ничего из чужого не удалять и не перенастраивать:
```bash
cd /opt/meet/ModernStreamingSystem          # каталог установки; сверить: docker compose ls
docker compose ls; docker ps --format '{{.Names}} {{.Ports}}' | grep -E ':443->|:80->'
python3 scripts/cohost-cutover.py           # без --apply ничего не меняет — прочитать, кто держит 443
```
Если 443 держит не `edge` Cord, а другой обратный прокси — остановиться и написать владельцу: имена `cordcam.ru` надо
добавить в тот прокси, это другой порядок.

**2.2. Обновление до `main`** — `RELEASE.md` §6 «Перед обновлением» и «Обновление» как есть (`backlog/bin/active-meetings.sh`
= 0, `./update.sh --check`, затем `sudo ./update.sh --yes`). Встречи на meet при этом оборвутся — владелец согласен.

**2.3. Имена `cordcam.ru` и режим `strict`** — `RELEASE.md` §6 «Переход в strict», пп. 1–7, с этими значениями:
```bash
D=$(date +%Y%m%d); cp -a infra/generated infra/generated.before-$D-cordcam && cp -p .env .local/env.before-$D-cordcam
# .env руками не править: с R200 §8.6 --refresh с именами сам переписывает DEPLOY_MODE, APP_HOST, RTC_HOST, TURN_HOST,
# PUBLIC_URL и LIVEKIT_URL (секреты не трогает) и печатает «.env retargeted: …». До этого LIVEKIT_URL и PUBLIC_URL
# оставались старыми — SFU звал клиентов на meet.nikg.tech, служба интеграций отказывала по Origin (выправлено руками 08.11).
node scripts/configure.mjs --refresh --app=cordcam.ru --rtc=rtc-fra.cordcam.ru --turn=turn-fra.cordcam.ru --ip=108.165.32.23
grep -E '^(DEPLOY_MODE|APP_HOST|RTC_HOST|TURN_HOST|PUBLIC_URL|LIVEKIT_URL)=' .env   # все — cordcam.ru / rtc-fra / turn-fra
# core, gateway и services читают .env — пересоздаются `up`; edge и livekit читают порождённые файлы только при старте.
docker compose up -d edge gateway core services livekit && docker compose restart edge livekit
for n in cordcam.ru rtc-fra.cordcam.ru turn-fra.cordcam.ru; do
  echo | openssl s_client -connect 108.165.32.23:443 -servername $n 2>/dev/null | openssl x509 -noout -subject -issuer
done                                         # Let's Encrypt у всех
```
`www.cordcam.ru` установка не обслуживает (генератор знает три имени: сайт, медиа, TURN) — владелец удаляет эту запись
из DNS; конфигурацию руками не дописывать.

**2.4. Админ-пароль ядра** (для будущей админ-панели на `admin.callcord.ru` и дренажа): если `ADMIN_PASSWORD` в `.env`
пуст — задать длинный случайный (`openssl rand -base64 33`) и `docker compose up -d --no-deps --force-recreate core`.
Сам пароль — **не** в отчёт; владельцу — «задан».

**2.5. Проверки** — `RELEASE.md` §6 «После обновления» с доменом `cordcam.ru` и `--turn=turn-fra.cordcam.ru:443`:
```bash
curl -s https://cordcam.ru/ | grep -o 'name="cord-build" content="[^"]*"'
curl -fsS https://cordcam.ru/api/v1/ping
node scripts/smoke.mjs
node scripts/turn-relay-check.mjs --env=.env --signal=ws://127.0.0.1:7880 --turn=turn-fra.cordcam.ru:443 --transport=tls
```
Живая проверка — две вкладки на `https://cordcam.ru`: встреча, звук, камера, показ экрана.

**2.6. Избранное старой установки cordcam (по желанию владельца).** Бэкап `/root/<cordcam>-cord-<дата>.sql.gz` из «Сейчас»
не восстанавливать целиком: он затёр бы базу meet. Таблицы избранного переносит главная сессия по отдельной просьбе.

**2.7. Отчёт** владельцу: `cord-build`, итог `smoke.mjs` и `turn-relay-check.mjs`, вывод `openssl` по трём именам,
результат 2.1 (кто держит 443), «ADMIN_PASSWORD задан», что не сошлось.

Откат шага 2: `.env` из `.local/env.before-<дата>-cordcam`, `infra/generated.before-<дата>-cordcam` на место,
`docker compose up -d edge gateway core services livekit && docker compose restart edge livekit` — установка снова на `meet.nikg.tech`
(в DNS `meet.nikg.tech` пока есть).

Старую установку cordcam (157.22.241.114) **не останавливать** до шага «узел msk»: её база — для переноса избранного.

**2.8. YouTube на meet (по просьбе владельца 08.11).** Кинозал качает YouTube с машины ядра — то есть с meet:
```bash
cd /opt/meet/ModernStreamingSystem
docker compose exec -T services python -m yt_dlp -f 'bv*[height<=1080]' --newline -o /dev/null 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' 2>&1 | tail -5
```
Скорость > 1 МиБ/с и без «Sign in to confirm you're not a bot» — ничего не делать. Иначе — запасной выход через Хельсинки
(адрес meet на B разрешён): на meet `PSK='<содержимое /opt/cord/youtube-proxy/tunnel.psk на B — взять у главной сессии>'
sudo -E bash infra/youtube-proxy/client.sh 152.234.227.199`, в `.env` — `CINEMA_PROXY_YOUTUBE=http://cord:<пароль из
/opt/cord/youtube-proxy/.password на B>@127.0.0.1:3128`, `docker compose up -d --no-deps --force-recreate services`, замер
ещё раз. Ключ и пароль — от главной сессии, не в отчёт.

**2.9. Пропуски, найденные при первом прогоне (08.11, GPT):** после смены имён обновить в `.env` прежний `LIVEKIT_URL`
(на `wss://rtc-fra.cordcam.ru`) и пересоздать службу интеграций (`docker compose up -d --no-deps --force-recreate
services`), чтобы она приняла новый Origin.


---

## 0. Что получится

```
cordcam.ru (люди, API, WS)  ──►  A 108.165.32.75  Франкфурт   узел управления + медиаузел fra   fra./rtc-fra./turn-fra.cordcam.ru
                                  │ магистраль TCP 7443 mTLS (только управление; медиа между узлами не ходит)
                ┌─────────────────┼──────────────────────┐
                ▼                 ▼                      ▼
   B 152.234.227.199      cordcam 157.22.241.114    meet 108.165.32.23
   Хельсинки  hel         Москва   msk              Франкфурт  fra2
   hel./rtc-hel./turn-hel msk./rtc-msk./turn-msk    fra2./rtc-fra2./turn-fra2
```

Встреча живёт целиком на одном узле; узел выбирает ядро по замеру пути создателя и загрузке узлов; люди видят узел и
флаг и могут перевести встречу вручную. Старые имена: `cord.nikg.tech` → 301 на `cordcam.ru` 7 дней (пока выходят
клиенты с новым адресом), затем удаляются; `meet.nikg.tech` и прочие имена `nikg.tech` на 108.165.32.23 удаляются в
момент переезда; `callcord.ru` не используется.

## 1. Серверы, доступ, роли

| Сервер | Адрес | Доступ | Сейчас | Становится | Раздел |
|---|---|---|---|---|---|
| A | 108.165.32.75 | root, `/opt/ModernStreamingSystem` — единственная копия для выкатки | прод `cord.nikg.tech` 1.2.1 | управление + `fra` на `cordcam.ru` | 4 |
| B | 152.234.227.199 | с A: `ssh -i /root/.ssh/cord_fi root@152.234.227.199`; `backlog/bin/node.sh hel …` | узел `hel` в режиме `ip` | узел `hel` в `strict` | 3 |
| cordcam | 157.22.241.114 | у исполнителя свой доступ; на A ключа нет | отдельный Cord (своя база, канал клиента `deploy/cordcam`) | узел `msk` + прокси YouTube по Р-99 | 5 |
| meet | 108.165.32.23 | у исполнителя свой доступ | отдельный старый Cord `meet.nikg.tech` | 301 → затем узел `fra2` | 6 |

Все команды `node.sh`/`node-config.mjs` выполняются **на A** из `/opt/ModernStreamingSystem`; на узлы они ходят по SSH.
Для cordcam и meet исполнителю нужно положить на A свой ключ к ним (`/root/.ssh/cord_msk`, `/root/.ssh/cord_fra2`, 0600) —
`node.sh` берёт ключ из реестра (`--ssh-key=`).

## 2. Жёсткие правила (те же, что `rollout.md` §2, плюс)

1. Никогда: `docker compose down -v`, `docker volume rm`, `git push --force`, правка применённой миграции, `reset --hard`.
2. Ничего не перезапускать и не выкатывать при идущих встречах: на A `backlog/bin/active-meetings.sh` (код 0),
   для узла `--node <id>`; на cordcam/meet — их собственный `backlog/bin/active-meetings.sh` из каталога установки.
3. Секреты (`.env`, `node.env`, `.local/backbone/`, `.password`, `tunnel.psk`) — не в git, не в чат, не в отчёт.
4. Документы и журналы — по-русски. Отчёт о каждом разделе — строкой в `backlog/journal/<дата>-r200-cordcam.md`.
5. DNS меняет только владелец (`server-selection.md` §7); исполнитель **проверяет** `dig` перед шагом, который от него
   зависит, и ждёт, если записи нет.
6. На cordcam и meet **до** раздела 5/6 ничего не менять (позиция владельца 01.11: «раскатывать на другие — снято»;
   отменяется только этой инструкцией в её порядке).

## 3. Узел B → `strict` на `hel.cordcam.ru`

Условие: владелец добавил `hel`, `rtc-hel`, `turn-hel` → 152.234.227.199 (`server-selection.md` §7.3 пп. 6–8).

```bash
for h in hel rtc-hel turn-hel; do printf '%-10s %s\n' $h "$(dig +short A $h.cordcam.ru @earl.ns.cloudflare.com)"; done
# все три — 152.234.227.199; иначе ждать владельца
cd /opt/ModernStreamingSystem
backlog/bin/active-meetings.sh --node hel                      # 0
node scripts/node-config.mjs --node=hel --app=hel.cordcam.ru --rtc=rtc-hel.cordcam.ru --turn=turn-hel.cordcam.ru \
  --country=FI --title-ru=Хельсинки --title-en=Helsinki        # --country появится с кодом 8.1; без него — опустить
backlog/bin/node.sh hel deploy
sleep 60; backlog/bin/node.sh hel check                        # livekit 200, edge 443, ping через edge 200 (сертификат LE)
node scripts/turn-relay-check.mjs --host turn-hel.cordcam.ru --transport=tls   # релей только на SFU узла
```

Это тот же шаг, что `rollout.md` §4.3, с именами `cordcam.ru` **[не проверено: нет DNS]**. Откат: `node-config.mjs
--node=hel --mode=ip` и `node.sh hel deploy`.

## 4. Узел управления A: `cordcam.ru` рядом с `cord.nikg.tech`, затем переключение

### 4.1 Включение реестра и магистрали — `rollout.md` §5.1–5.2 без изменений

(`NODE_ID=fra`, реестр, `ufw allow from 152.234.227.199 … 7443`, `docker compose up -d backbone`, `deploy.sh core
gateway`, проверка `cord_node_up{node="hel"} 1`.) Реестр, отложенный как `registry.json.until-dns`, возвращается на
место командой `node-config.mjs --node=hel --refresh --write-env` **после** шага 3.

### 4.2 A обслуживает два продуктовых имени **[код фазы 2: `--redirect-hosts`]**

```bash
cd /opt/ModernStreamingSystem && backlog/bin/active-meetings.sh      # 0
TAG=cord-rollback-$(date +%Y%m%d-%H%M%S); for s in core gateway; do docker tag modern-streaming-$s:latest $TAG-$s:latest; done
node scripts/configure.mjs --refresh --app=cordcam.ru --rtc=rtc-fra.cordcam.ru --turn=turn-fra.cordcam.ru \
  --redirect-hosts=cord.nikg.tech --legacy-media-hosts=rtc.cord.nikg.tech,turn.cord.nikg.tech   # имена флагов — по §8.6, уточнить по --help
grep -E '^(PUBLIC_URL|APP_HOST|RTC_HOST|TURN_HOST)=' .env            # cordcam.ru, rtc-fra…, turn-fra…
docker compose up -d edge livekit && backlog/bin/deploy.sh gateway core
# Проверка до смены DNS (имя ещё указывает на cordcam-сервер, поэтому --resolve):
curl -sk --resolve cordcam.ru:443:108.165.32.75 https://cordcam.ru/api/v1/ping -o /dev/null -w '%{http_code}\n'   # 200
curl -sI https://cord.nikg.tech/api/v1/ping | head -1                                                           # 200 — старое имя живо
```

Сертификат для `cordcam.ru` Caddy получит только когда DNS укажет на A (шаг 4.3) — до этого `--resolve`-проверка даёт
ошибку TLS с самоподписанным/отсутствующим сертификатом: это ожидаемо, проверять код ответа с `-k`.

### 4.3 Переключение DNS (владелец, ночью) и проверка

Владелец: `cordcam.ru` и `www` → 108.165.32.75 (TTL 1 min поставлен заранее). Исполнитель через 2 минуты:

```bash
dig +short A cordcam.ru; dig +short A www.cordcam.ru                     # 108.165.32.75
sleep 90; curl -sI https://cordcam.ru/ | grep -iE 'HTTP/|strict-transport' # 200/301 и HSTS; сертификат LE: openssl s_client -connect cordcam.ru:443 -servername cordcam.ru </dev/null 2>/dev/null | openssl x509 -noout -issuer
curl -sI https://cord.nikg.tech/r/TEST | grep -i location                 # https://cordcam.ru/r/TEST…  (редирект с переносом настроек)
curl -s https://cordcam.ru/api/v1/capabilities | python3 -c 'import json,sys;print([n["id"] for n in json.load(sys.stdin)["nodes"]])'  # ['fra','hel']
docker compose logs --since 5m core | grep -ciE 'origin|403'               # нет всплеска отказов по Origin
```

Живая проверка: две вкладки на `https://cordcam.ru` — встреча, звук, камера, показ; в настройках — узлы с флагами
(после кода 8.2). Клиент Windows и Android выпускаются с `cordcam.ru` (`server-selection.md` §8.6) — отдельный шаг
главной сессии, не этой инструкции.

Откат: владелец возвращает `cordcam.ru` → 157.22.241.114 (минута); на A `docker tag $TAG-… && docker compose up -d
--no-deps core gateway`, `configure.mjs --refresh --app=cord.nikg.tech …` — `cord.nikg.tech` при этом не прерывался.

## 5. Сервер cordcam → медиаузел `msk`

Условие: шаг 4.3 выполнен (продукт уже на A, старая установка cordcam трафика людей больше не получает — апекс указывает
на A), владелец добавил `msk`, `rtc-msk`, `turn-msk` → 157.22.241.114.

### 5.1 Сначала замер YouTube (Р-99) — пока старая установка ещё стоит

На cordcam, из каталога установки (той же библиотекой, которой кинозал достаёт ролики, без прокси):

```bash
docker compose exec -T -e CINEMA_PROXY= -e CINEMA_PROXY_YOUTUBE= services \
  python -m yt_dlp -f 'bv*[height<=1080]' --newline -o /dev/null 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' 2>&1 | tail -5
```

Скорость стабильно **> 1 МиБ/с** и без обрывов — YouTube не режут, прокси на `msk` **не нужен**, записать результат в
журнал. Ниже 0,5 МиБ/с, обрывы, `HTTP Error 403` на `googlevideo` — режут: после 5.3 поставить клиент туннеля к B
(`rollout.md` §9 п. 2; на B адрес cordcam на 8443 уже разрешён) — он нужен **ядру на A**, а не узлу: `CINEMA_PROXY_YOUTUBE`
читает служба кинозала на A, поэтому туннель ставится на A (`infra/youtube-proxy/client.sh 152.234.227.199` на A) — и
только если замер **с A** тоже плох, чего во Франкфурте не бывает. Итог: для единого Cord с управлением на A прокси
YouTube нужен **только если режут на A**; замер на cordcam нужен владельцу как факт о российской сети (для узла `msk`
кинозал не важен — медиа кинозала идёт с A). Если владелец позже перенесёт управление в Москву (Р-108 пересмотр) —
тогда туннель с msk к B.

### 5.2 Бэкап и остановка старой установки

```bash
cd <каталог установки cordcam>
backlog/bin/active-meetings.sh                              # 0; иначе ждать
docker compose exec -T postgres pg_dump -U streaming streaming | gzip > /root/cordcam-$(date +%F).sql.gz
docker compose exec -T postgres pg_dump -U streaming --data-only -t favorites -t favorite_groups streaming > /root/cordcam-favorites-$(date +%F).sql  # имена таблиц сверить: \dt
cp .env /root/cordcam.env.bak && chmod 600 /root/cordcam.env.bak; docker compose ps > /root/cordcam-ps.txt
docker compose stop                                          # не down -v: тома остаются для отката
ss -ltnup | grep -E ':443 |:80 |:7881 |:7882 |:3478 '        # пусто — порты свободны
```

Избранное: файл `/root/cordcam-favorites-*.sql` передать главной сессии — она решит про импорт на A (UUID не
сталкиваются; пользователи на origin `cordcam.ru` сохранили свои секреты устройства, поэтому строки «оживут»)
**[не проверено]**.

### 5.3 Узел `msk` — `rollout.md` §7 с параметрами

```bash
cd /opt/ModernStreamingSystem
node scripts/node-config.mjs --node=msk --ip=157.22.241.114 --app=msk.cordcam.ru --rtc=rtc-msk.cordcam.ru --turn=turn-msk.cordcam.ru \
  --title-ru=Москва --title-en=Moscow --country=RU --max-rooms=<по ядрам: 2 на 2 vCPU, 4 на 4> --ssh=root@157.22.241.114 --ssh-key=/root/.ssh/cord_msk
backlog/bin/node.sh msk bootstrap && backlog/bin/node.sh msk deploy
sudo ufw allow from 157.22.241.114 to any port 7443 proto tcp comment 'cord backbone msk'
docker compose up -d backbone
sleep 60; backlog/bin/node.sh msk check; node scripts/turn-relay-check.mjs --host turn-msk.cordcam.ru --transport=tls
curl -s https://cordcam.ru/api/v1/capabilities | grep -o '"id":"msk"'
```

Проверка с устройства в России (владелец): «Создать встречу» → в настройках «Узел встречи: 🇷🇺 Москва · N мс»; в журнале
ядра `room … on node msk (preferred; …)`.

Клиент Windows ветки `deploy/cordcam`: **до** этого шага главная сессия выпускает последнюю сборку канала с
`CORD_DEFAULT_SERVER=https://cordcam.ru/` и ключами основной установки (`rollout.md` §8 п. 4) — иначе его пользователи
останутся без обновлений. После шага канал `https://cordcam.ru/downloads/windows/desktop/` отдаёт A — основной.

Владелец после проверки: удалить `rtc.cordcam.ru`, `turn.cordcam.ru` (старые имена).

Откат: на A удалить `msk` из реестра (`rollout.md` §7 п. 4), на cordcam `docker compose start` — старая установка со
своей базой (но апекс уже на A; откат апекса — отдельное решение владельца).

## 6. Сервер meet → узел `fra2`

Условие: шаг 4.3 выполнен; владелец удалил из `nikg.tech` имена `meet`, `app`, `media`, `remote`, `rtc`, `turn` (все —
108.165.32.23) и добавил в `cordcam.ru` `fra2`, `rtc-fra2`, `turn-fra2` → 108.165.32.23.

На meet, без встреч (`active-meetings.sh` там): бэкап как в «Сейчас» п. 3 (свежий), `docker compose stop` (не `down -v`,
тома остаются для отката), порты 80/443/3478/7881/7882 свободны. Затем на A — `rollout.md` §7 с
`--node=fra2 --ip=108.165.32.23 --app=fra2.cordcam.ru --rtc=rtc-fra2.cordcam.ru --turn=turn-fra2.cordcam.ru
--title-ru=Франкфурт-2 --title-en=Frankfurt-2 --country=DE --ssh=root@108.165.32.23 --ssh-key=/root/.ssh/cord_fra2`,
`node.sh fra2 bootstrap && node.sh fra2 deploy`, `ufw allow from 108.165.32.23 to any port 7443 proto tcp comment 'cord
backbone fra2'`, `node.sh fra2 check`. Смысл `fra2`: резерв Франкфурта на время работ на A и место для горячего
резерва базы позже. Откат: убрать `fra2` из реестра, на meet `docker compose start`.

## 7. Проверки после всего

1. `curl -s https://cordcam.ru/api/v1/capabilities` — узлы `fra, hel, msk[, fra2]`, у каждого `country`.
2. `curl -s http://127.0.0.1:8080/actuator/prometheus | grep '^cord_node_up'` — все 1.
3. Отказ: `node.sh hel ssh 'cd /opt/cord/node && docker compose stop livekit'` при тестовой встрече на `hel` → звук у
   всех ≤ 8 с (после кода 8.5; до него — ≤ 20 с) → `start livekit`.
4. Ручной перевод (после кода 8.4): создатель переводит встречу `fra → hel` — пауза звука ≤ 0,5 с.
5. Алерты: `curl -s http://127.0.0.1:8880/api/v1/rules | grep -o 'NodeDown\|NodeUnreachable\|NodeSaturated\|NodeSingle'`.
6. DNS-итог: `for h in cordcam.ru www.cordcam.ru fra rtc-fra turn-fra hel rtc-hel turn-hel msk rtc-msk turn-msk fra2 rtc-fra2 turn-fra2; do …dig…; done`
   совпадает с таблицей §7.3 проекта; `dig +short A cord.nikg.tech` через 7 дней после переезда — пусто.

## 8. Откат всего

Как `rollout.md` §10 (магистраль, реестр, образы по тегу) плюс DNS: апекс `cordcam.ru` обратно на 157.22.241.114 и
`docker compose start` на cordcam — старая установка. Узлы `hel`/`msk`/`fra2` без ядра просто простаивают.
