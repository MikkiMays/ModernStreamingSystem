# Переезд всей сети Cord на `cordcam.ru`: инструкция для исполнителя с доступом ко всем серверам (R200)

Для кого: человек или ИИ-агент (GPT владельца), у которого есть SSH ко всем четырём серверам, но **нет контекста**
проекта. Делать ровно по порядку, после каждого шага — проверка; не сошлось — остановиться и написать владельцу.
Проект — `docs/architecture/server-selection.md` (§6–§7), база — `docs/architecture/rollout.md` (R198: узлы, магистраль,
реестр; **читать его разделы 2, 3, 7 обязательно** — здесь они не повторяются).

Пометки: **[проверено]** — выполнялось 08.11.2026; **[код фазы 2]** — требует кода, которого на 08.11.2026 нет
(`server-selection.md` §8.6); до его выкатки шаг не делать; **[не проверено]** — по коду и документации.

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
флаг и могут (создатель) перевести встречу вручную. Старые имена: `cord.nikg.tech` → 301 на `cordcam.ru` 30 дней,
`meet.nikg.tech` → 301, `callcord.ru` → 301 правилом Cloudflare.

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

## 6. Сервер meet: редирект, затем узел `fra2`

### 6.1 Редирект (сразу после 4.3)

На meet, без встреч (`active-meetings.sh` там): самый простой путь без кода — заменить конфигурацию шлюза редиректом.
В каталоге установки meet: в `infra/Caddyfile` блок сайта `meet.nikg.tech` → `redir https://cordcam.ru{uri} 301` (для
`/r/<код>` комнаты другой базы — всё равно на главную: `redir https://cordcam.ru/ 301`), `docker compose up -d gateway`.
Проверка: `curl -sI https://meet.nikg.tech/ | grep -i location` → `https://cordcam.ru/`. Остальные контейнеры meet
можно остановить через 7 дней (`docker compose stop`, тома не удалять).

### 6.2 Узел `fra2` (через 30 дней, когда владелец удалил `meet.nikg.tech` из DNS и добавил `fra2`, `rtc-fra2`, `turn-fra2`)

Бэкап как в 5.2; `docker compose stop`; затем `rollout.md` §7 с `--node=fra2 --ip=108.165.32.23 --title-ru=Франкфурт-2
--title-en=Frankfurt-2 --country=DE`. Смысл `fra2`: резерв Франкфурта на время работ на A (дренаж `fra` без потери региона)
и место для горячего резерва Postgres позже (R195 фаза 4). Выбор между `fra` и `fra2` при равном замере — по ступени
нагрузки (ядро, §3.4 проекта).

## 7. Проверки после всего

1. `curl -s https://cordcam.ru/api/v1/capabilities` — узлы `fra, hel, msk[, fra2]`, у каждого `country`.
2. `curl -s http://127.0.0.1:8080/actuator/prometheus | grep '^cord_node_up'` — все 1.
3. Отказ: `node.sh hel ssh 'cd /opt/cord/node && docker compose stop livekit'` при тестовой встрече на `hel` → звук у
   всех ≤ 8 с (после кода 8.5; до него — ≤ 20 с) → `start livekit`.
4. Ручной перевод (после кода 8.4): создатель переводит встречу `fra → hel` — пауза звука ≤ 0,5 с.
5. Алерты: `curl -s http://127.0.0.1:8880/api/v1/rules | grep -o 'NodeDown\|NodeUnreachable\|NodeSaturated\|NodeSingle'`.
6. DNS-итог: `for h in cordcam.ru www.cordcam.ru fra rtc-fra turn-fra hel rtc-hel turn-hel msk rtc-msk turn-msk; do …dig…; done`
   совпадает с таблицей §7.3 проекта; `dig +short A cord.nikg.tech` через 30 дней — пусто.

## 8. Откат всего

Как `rollout.md` §10 (магистраль, реестр, образы по тегу) плюс DNS: апекс `cordcam.ru` обратно на 157.22.241.114 и
`docker compose start` на cordcam — старая установка. Узлы `hel`/`msk`/`fra2` без ядра просто простаивают.
