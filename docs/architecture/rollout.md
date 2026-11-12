# Выкатка распределённой медиасети Cord: инструкция для агента с доступом ко всем серверам (R198)

> **Имена — на дату документа.** С 12.11.2026 продукт — `cord.online` (вместо `cordcam.ru`), стенд и пульт —
> `callcord.ru`, узел `cordcam` зовётся `msk`; имён `nikg.tech` в системе нет. Действующая раскладка —
> `backlog/CONTEXT.md` и `docs/RELEASE.md` §6.

Эта инструкция написана для исполнителя (человека или ИИ-агента), у которого есть SSH-доступ ко всем серверам
владельца, но **нет контекста** проекта. Делайте ровно то, что написано, в этом порядке, и после каждого шага выполняйте
проверку. Если проверка не сходится — остановитесь и сообщите владельцу, не продолжайте. Проект устройства —
`docs/architecture/distributed-media.md` (прочитать «Поправку 08.11.2026» и §5.5′ обязательно, остальное — по желанию).

**Поправка R200 (08.11.2026):** продуктовый домен — **`cordcam.ru`**, не `callcord.ru` (владелец). Переезд всей сети на
`cordcam.ru`, роли серверов cordcam (`msk`) и meet (`fra2`), редиректы старых имён — отдельная инструкция
`docs/architecture/rollout-cordcam.md`; она ссылается на разделы этого документа. Где ниже `callcord.ru` — читать
`cordcam.ru`; `hel.callcord.ru` → `hel.cordcam.ru` и т. д.

Пометки: **[проверено]** — выполнено и измерено 08.11.2026 на узле B; **[не проверено]** — написано по коду и
документации, вживую не выполнялось (обычно потому, что требовало изменений на узле A, которые делает только владелец
или главная сессия).

---

## 0. Что получится в итоге

```
callcord.ru (люди) ──HTTPS/WSS──► A: Франкфурт, узел управления (fra)
                                   ядро, Postgres, Redis, веб, службы, tusd, мониторинг, SFU+TURN узла fra
                                   │ магистраль: TCP 7443, mTLS (caddy-l4)
                                   ▼
          B: Хельсинки, медиаузел (hel)       [C: Москва, медиаузел (msk) — когда решит владелец]
          SFU + TURN + edge + gateway-lite + backbone + node-exporter; базы и ядра здесь нет
```

- Встреча живёт **целиком на одном узле**; узел для новой встречи выбирает ядро по замеру пути с устройства создателя
  (`capabilities.nodes` → `preferredNode`). Входящие идут на узел комнаты. Люди сервер не выбирают.
- Между узлами ходит только управление (Twirp ядро→узел, вебхуки и `forward_auth` узел→ядро, метрики) — по TCP 7443
  в mTLS-туннеле. **Медиа и сигнал участников между узлами не ходят. UDP между узлами не используется** (фильтр хостера
  A режет его — замеры 07–08.11.2026).
- Узел умер → ядро за ≈ 15 с переселяет его встречи на живой узел, клиенты переподключаются сами (**[проверено]**:
  15,5 с от остановки SFU до звука у обоих участников).

## 1. Серверы и роли

| Сервер | Адрес | Сейчас | Становится | Кто делает |
| --- | --- | --- | --- | --- |
| A, `callcord.ru` | 108.165.32.75 | стенд = прод Cord 1.2.x | **узел управления `fra`** + медиаузел `fra` | владелец / главная сессия (раздел 5) |
| B, `hel.callcord.ru` | 152.234.227.199 | медиаузел `hel` в режиме `ip` (без DNS), прокси YouTube | медиаузел `hel` в режиме `strict` (с DNS) | эта инструкция (раздел 4) |
| `cordcam.ru` | 157.22.241.114 | **отдельная установка** Cord (своя база, свой каталог, клиент Windows — ветка `deploy/cordcam`) | **решение владельца** (п. 17 `backlog/OWNER-ACTIONS.md`): по умолчанию — **медиаузел `msk`** единого Cord (раздел 7) | только после ответа владельца |
| `meet.nikg.tech` | 108.165.32.23 | отдельная установка (старый прод) | **решение владельца**: по умолчанию — вывести: редирект на `callcord.ru` | только после ответа владельца |

Текущая роль `cordcam.ru` и `meet.nikg.tech` как **независимых** установок описана в `backlog/README.md` (таблица «Стенды»)
и `docs/RELEASE.md` §6. До решения владельца **ничего на них не выкатывать**.

## 2. Жёсткие правила (нарушение = потеря данных или звонков у людей)

1. **Никогда** `docker compose down -v`, `docker volume rm`, `git push --force`, правка уже применённой миграции
   `server/src/main/resources/db/migration/V*.sql`.
2. **Ничего не перезапускать на A и не выкатывать**, пока идут встречи: из `/opt/ModernStreamingSystem` выполнить
   `backlog/bin/active-meetings.sh` — код выхода `0` («Живых встреч нет») разрешает; `1` — ждать; `2` — выяснить, почему
   не отвечает база. Для узла: `backlog/bin/active-meetings.sh --node hel` (код 0 — на узле встреч нет).
3. **Секреты не попадают ни в git, ни в чат, ни в журнал.** Все секреты лежат в `.env` (A, `0600`), в
   `infra/generated/nodes/<узел>/node.env` (A, `0600`, уезжает на узел как `/opt/cord/node/.env`), в `.local/backbone/`
   (A, внутренний ЦС магистрали). В ответах и отчётах — только имена переменных, не значения.
4. Контракты API (`contracts/openapi.json`, `web/src/api/generated.ts`) — только `backlog/bin/gen-contracts.sh`.
5. Документы, коммиты, журналы — по-русски.
6. Файлы в `infra/generated/` и `.local/` — вне git (так и должно быть); не пытайтесь их закоммитить.

## 3. Где что лежит (на A, в `/opt/ModernStreamingSystem` — единственная рабочая копия для выкатки)

| Что | Где | Как создаётся |
| --- | --- | --- |
| Общие секреты (`LIVEKIT_API_KEY/SECRET`, `INTERNAL_SECRET`, `LIVEKIT_METRICS_PASSWORD`, пароли базы и Redis) | `.env` | `scripts/configure.mjs` при установке; **не менять** |
| Реестр узлов | `infra/generated/nodes/registry.json` | `node scripts/node-config.mjs …` (раздел 4.2) |
| Файлы медиаузла | `infra/generated/nodes/<узел>/{node.env,edge.json,livekit.json,backbone.json,pki/,tls/}` | то же |
| Магистраль A | `infra/generated/backbone.json`, `infra/generated/backbone-pki/` | то же |
| Внутренний ЦС магистрали | `.local/backbone/ca.key` (0600), `ca.crt`, `<узел>.crt/.key` | то же, один раз; срок ЦС 10 лет, сертификатов узлов 825 дней (`--renew`) |
| Цели метрик узлов | `infra/generated/scrape-nodes/<узел>.json` | то же |
| SSH-ключ к узлу B | `/root/.ssh/cord_fi` (только на A) | владелец |
| На узле | `/opt/cord/node/` (`compose.yaml`, `.env`, `edge.json`, `livekit.json`, `backbone.json`, `Caddyfile`, `pki/`, `tls/`) | `backlog/bin/node.sh <узел> deploy` |
| Прокси YouTube на B | `/opt/cord/youtube-proxy/` (`.password`, `tunnel.psk` — 0600) | `infra/youtube-proxy/install.sh` (уже стоит) |

Порты магистрали на A: узел с номером N (поле `index` в реестре) виден ядру как `127.0.0.1:2N000` (Twirp), `2N001`
(метрики SFU), `2N002` (node-exporter), `2N003` (шлюз-лайт), `2N004` (куратор). На узле: `127.0.0.1:18080` → ядро A,
`127.0.0.1:18090` → крюки A.

## 4. Медиаузел B (Хельсинки) — состояние и перевод в `strict`

### 4.1 Что уже сделано **[проверено]**

- B подготовлен (`node.sh hel bootstrap`): Docker 29, ufw (22, 80, 443/tcp, 7881/tcp, 7882/udp, 3478/udp; 7443/tcp только
  с A; 8443/tcp только с A и cordcam — прокси YouTube), sysctl под SFU, fail2ban.
- На B работает `cord-node`: `edge`, `gateway`, `livekit`, `backbone`, `node-exporter` (режим `ip`, самоподписанный
  сертификат на 152.234.227.199). Проверка: `backlog/bin/node.sh hel check` с A.
- На B сквозная проверка с двумя браузерами и временной плоскостью управления (ядро + база на самом B, файлы —
  `/opt/cord/ctl/`, контейнеры остановлены, можно удалить): создание встречи по замеру → узел `hel`; вход ведущего — медиа
  подключено через **2,1 с** после нажатия, гостя — **1,3 с**; остановка SFU узла → переезд на второй SFU и звук у обоих
  через **15,5 с**. Числа — `backlog/journal/2026-11-08-r195-nodes.md`.

### 4.2 Записи DNS (делает владелец в Cloudflare; все — **DNS only / серое облако**, прокси выключен)

Проверка перед началом (с любой машины):

```bash
for h in callcord.ru www.callcord.ru rtc-fra.callcord.ru turn-fra.callcord.ru hel.callcord.ru rtc-hel.callcord.ru turn-hel.callcord.ru; do
  printf '%-22s %s\n' "$h" "$(dig +short A "$h" @earl.ns.cloudflare.com | tr '\n' ' ')"
done
```

Ожидаемое (пока нет — попросить владельца; **на 08.11.2026 `callcord.ru` и `www` указывали на 152.234.227.199, это
неверно** — апекс должен указывать на A):

| Имя | Тип | Значение | Облако |
| --- | --- | --- | --- |
| `callcord.ru`, `www.callcord.ru` | A | 108.165.32.75 | серое |
| `rtc-fra.callcord.ru`, `turn-fra.callcord.ru` | A | 108.165.32.75 | серое |
| `hel.callcord.ru`, `rtc-hel.callcord.ru`, `turn-hel.callcord.ru` | A | 152.234.227.199 | серое |

AAAA не создавать. Пока апекс не переведён на A, переезд продукта на `callcord.ru` (раздел 5.3) **не начинать**.

### 4.3 Перевод B в `strict` **[не проверено: нет DNS; механизм тот же, что у стенда A]**

На A, из `/opt/ModernStreamingSystem`, когда `hel.*` резолвятся в 152.234.227.199:

```bash
cd /opt/ModernStreamingSystem
node scripts/node-config.mjs --node=hel --app=hel.callcord.ru --rtc=rtc-hel.callcord.ru --turn=turn-hel.callcord.ru
# ожидаемо: "Nodes: fra (control), hel" и "Node hel: strict · wss://rtc-hel.callcord.ru · twirp via http://127.0.0.1:21000"
backlog/bin/active-meetings.sh --node hel     # ожидаемо: код 0
backlog/bin/node.sh hel deploy
```

Проверка (команда `node.sh hel check` печатает её сама): `livekit 7880: 200`, `backbone 7443: слушает`, `edge 443:
слушает`, `ping через edge (hel.callcord.ru): 200`. Сертификат Let's Encrypt edge получает сам по HTTP-01 (80/tcp открыт)
в течение минуты; до этого `ping через edge` может отвечать ошибкой TLS — повторить `check` через минуту. Строка
`магистраль A→hel … нет ответа` — нормальна, пока на A не поднят `backbone` (раздел 5.1).

Дополнительно: `node scripts/turn-relay-check.mjs` против `turn-hel.callcord.ru` (см. скрипт) — релей TURN узла ведёт только
к его же SFU.

## 5. Узел управления A — включение узлов **[не проверено: выполняет владелец/главная сессия]**

Порядок важен: сначала файлы и брандмауэр, потом контейнеры, потом ядро, потом веб.

### 5.1 Магистраль и реестр

Реестр `infra/generated/nodes/registry.json` на A **убран в сторону** до появления DNS и сертификатов узла (главная
сессия, 08.11): ядро без файла живёт одним неявным узлом. Защита ядра: если в реестре узел управления (`control`) не
совпадает с `NODE_ID` из `.env` (или `NODE_ID` не задан), реестр **игнорируется** с ошибкой в журнале
(`registry IGNORED`), метрикой `cord_node_registry_ignored=1` и алертом `NodeRegistryIgnored`; ядро не падает и
продолжает одним узлом. Поэтому порядок: сначала `NODE_ID` в `.env`, потом файл реестра.

```bash
cd /opt/ModernStreamingSystem && git status -sb        # ветка main, чистое дерево, HEAD содержит R195
backlog/bin/active-meetings.sh                          # код 0
# Реестр вернуть на место или создать заново (это же и записывает NODE_ID=fra, CSP_NODES, профиль nodes в .env):
node scripts/node-config.mjs --node=hel --refresh --write-env   # если файлы hel уже есть (убраны в сторону — вернуть сначала их)
#   либо, с нуля, после DNS: node scripts/node-config.mjs --node=hel --ip=152.234.227.199 --app=hel.callcord.ru --rtc=rtc-hel.callcord.ru --turn=turn-hel.callcord.ru --write-env
grep -E '^(NODE_ID|CSP_NODES|COMPOSE_PROFILES)=' .env   # три строки; значений CSP_NODES — имена узлов, без секретов
python3 -c "import json;print(json.load(open('infra/generated/nodes/registry.json'))['nodes'][0]['id'])"   # fra — совпадает с NODE_ID
sudo ufw allow from 152.234.227.199 to any port 7443 proto tcp comment 'cord backbone hel'
sudo ufw status | grep 7443                             # ровно одна строка с адресом B
docker compose up -d backbone                           # контейнер modern-streaming-backbone-1
docker compose ps backbone --format '{{.Status}}'       # Up
curl -fsS -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:21000/   # 200 — это SFU узла hel через магистраль
```

Если последняя команда не отвечает: на B `ufw status | grep 7443` (должен пускать 108.165.32.75), на B
`docker compose -f /opt/cord/node/compose.yaml logs backbone | tail`, на A `docker compose logs backbone | tail`.

### 5.2 Ядро, шлюз, мониторинг

```bash
backlog/bin/active-meetings.sh                          # код 0 (иначе --drain)
TAG=cord-rollback-$(date +%Y%m%d-%H%M%S); for s in core gateway; do docker tag modern-streaming-$s:latest $TAG-$s:latest; done
backlog/bin/deploy.sh core gateway                      # сборка и подъём; ядро читает /nodes/registry.json
docker compose logs --since 2m core | grep -E 'Media nodes|registry IGNORED' # ожидаемо: Media nodes: [fra*, hel]; строки IGNORED быть не должно
curl -s http://127.0.0.1:8080/actuator/prometheus | grep '^cord_node_up'   # cord_node_up{node="fra"} 1, {node="hel"} 1
curl -s https://callcord.ru/api/v1/capabilities | python3 -c 'import json,sys; print([n["id"] for n in json.load(sys.stdin)["nodes"]])'  # ['fra', 'hel']
docker compose up -d victoriametrics vmalert            # профиль monitoring: цели узлов и алерты NodeDown…
```

Откат ядра/шлюза: `docker tag $TAG-<служба>:latest modern-streaming-<служба>:latest && docker compose up -d --no-deps <служба>`.
Комнаты, созданные новым ядром, несут поле `mediaNode`; прежний образ читает их с `ignoreUnknown` — откат безопасен.

### 5.3 Переезд продукта на `callcord.ru` **[не сделано в коде, план]**

Делается отдельным шагом после 5.2 и после правильного DNS (4.2): `node scripts/configure.mjs --refresh --app=callcord.ru
--rtc=rtc-fra.callcord.ru --turn=turn-fra.callcord.ru --legacy-hosts=…` сохраняет `callcord.ru` работающим рядом
(переходный период), `PUBLIC_URL` меняется на `https://callcord.ru`, затем `docker compose restart edge livekit` и
`deploy.sh gateway core` в окне без встреч. Редирект `callcord.ru → callcord.ru` с переносом настроек (`#cord-prefs`) и
новый каталог клиента Windows — в `distributed-media.md` §7.4; **кодом пока не реализованы** и в этой волне не делаются
без решения владельца о сроках. `callcord.ru` работает, пока владелец не разрешит его убрать.

## 6. Проверки после включения (A + B) **[не проверено на паре A–B; проверено на B с временным ядром]**

1. С домашнего компьютера владельца: `https://callcord.ru` → «Новая встреча» → в «Настройки → Сервер» строка
   «Узел встречи: Хельсинки · N мс, Франкфурт · M мс»; в «Диагностике» встречи — «Узел встречи».
2. На A: `docker compose logs --since 10m core | grep 'on node'` — строка `room … on node hel (preferred; asked hel;
   measured […])` для встречи, созданной из Финляндии/Прибалтики; из Германии — `fra`.
3. Отказ узла: на A `backlog/bin/active-meetings.sh --node hel` (есть тестовая встреча на hel) →
   `backlog/bin/node.sh hel ssh 'cd /opt/cord/node && docker compose stop livekit'` → в журнале ядра через ≈ 15 с
   `Media node hel did not answer 3 times in a row` и `room … moved from dead node hel to fra`; участники слышат друг друга
   снова ≤ 20 с → `node.sh hel ssh 'cd /opt/cord/node && docker compose start livekit'`; `cord_node_up{node="hel"}` = 1.
4. Алерты: `curl -s http://127.0.0.1:8880/api/v1/rules | grep -o 'NodeDown\|NodeScrapeDown\|NodeSingle'`.

## 7. Как добавить узел (3-й, 4-й, выделенный сервер) — одна команда плюс DNS

1. Владелец: ВМ с публичным IPv4 (Ubuntu 22.04/24.04), root по SSH ключом с A, три записи DNS `<id>.`, `rtc-<id>.`,
   `turn-<id>.callcord.ru` → IP узла (серые).
2. На A:
   ```bash
   cd /opt/ModernStreamingSystem
   node scripts/node-config.mjs --node=<id> --ip=<IP> --app=<id>.callcord.ru --rtc=rtc-<id>.callcord.ru --turn=turn-<id>.callcord.ru \
     --title-ru='<Город>' --title-en='<City>' --cores=<vCPU> --uplink-mbps=<Мбит/с> --ssh=root@<IP> --ssh-key=/root/.ssh/<ключ>
   backlog/bin/node.sh <id> bootstrap && backlog/bin/node.sh <id> deploy
   sudo ufw allow from <IP> to any port 7443 proto tcp comment "cord backbone <id>"
   docker compose up -d backbone          # перечитать backbone.json с новым узлом (пересоздаётся без встреч: ядро и SFU не трогаются)
   ```
3. Ядро подхватывает реестр само за ≤ 10 с (`Media nodes: […]` в журнале), клиенты получают узел в `capabilities` без выкатки.
   Предела числа встреч на узле нет (R228, Р-135): ядро ставит встречи по нагрузке (ЦП, канал к `--uplink-mbps`, память,
   диск), поэтому `--cores` и `--uplink-mbps` должны быть правдой; `--max-rooms` больше нет (ошибка).
4. Снять узел с размещения перед работами: `backlog/bin/node.sh <id> drain` (ждёт конца встреч на нём), после —
   `backlog/bin/node.sh <id> undrain`. Убрать узел навсегда: удалить его запись из `infra/generated/nodes/registry.json`,
   `node scripts/node-config.mjs --write-env`, `docker compose up -d backbone`, закрыть 7443 для его адреса.

**Выделенный сервер «для закрытого канала»** добавляется так же; когда он появится и UDP между ним и A будет чистым,
магистраль можно перевести на WireGuard: заменить `dial` клиентских маршрутов в `backbone.json` на адреса `wg0` без TLS
(`distributed-media.md` §5.5′) — службы и реестр не меняются.

## 8. `cordcam.ru` как узел `msk` **[не проверено; только после решения владельца]**

Сейчас `cordcam.ru` — отдельный Cord со своей базой: комнаты, избранное и недавние его пользователей там и останутся, в
единый Cord не переносятся (учётных записей нет, избранное — на устройствах). Шаги, если владелец выбрал узел:

1. **Бэкап** на cordcam: `cd <каталог установки> && docker compose exec -T postgres pg_dump -U streaming streaming | gzip > /root/cordcam-$(date +%F).sql.gz`;
   `cp .env /root/cordcam.env.bak && chmod 600 /root/cordcam.env.bak`; `docker compose ps > /root/cordcam-ps.txt`.
2. **Окно без встреч** на cordcam (`backlog/bin/active-meetings.sh` там, код 0). Остановить его Cord: `docker compose stop`
   (не `down -v`; тома остаются для отката).
3. На A — раздел 7 с `--node=msk --ip=157.22.241.114 --title-ru=Москва --title-en=Moscow --app=msk.callcord.ru …`
   (владелец — DNS `msk.`, `rtc-msk.`, `turn-msk.callcord.ru` → 157.22.241.114). `node.sh msk bootstrap` на машине с уже
   стоящим Docker только добавляет правила ufw и каталог; **порты 443/80/7881/7882/3478 должны быть свободны** —
   проверить `ss -ltnup | grep -E ':443|:80|:7881|:7882|:3478'` после `docker compose stop` прежнего Cord.
4. `cordcam.ru` (апекс) владелец переводит на 108.165.32.75 **или** оставляет на 157.22.241.114 — тогда gateway-lite узла
   ответит редиректом на `PUBLIC_URL` (так работает любое имя узла), а старые ссылки `cordcam.ru/r/<код>` вести никуда не
   будут (комнаты другой базы). Клиент Windows ветки `deploy/cordcam` получает обновления со **своего** канала
   (`https://cordcam.ru/downloads/windows/desktop/`), и этот канал перестанет существовать: пользователям cordcam нужен
   **один** выпуск с канала `deploy/cordcam`, собранный с `CORD_DEFAULT_SERVER=https://callcord.ru/` и ключами
   основной установки (`desktop/build/installations/cordcam.json` → сервер и ключи основной), который переведёт их на
   основной канал; после него ветку `deploy/cordcam` можно закрыть. Без этого выпуска клиенты cordcam останутся на
   старой версии навсегда.
5. **Откат**: на A убрать узел `msk` (раздел 7 п. 4); на cordcam `docker compose start` — прежний Cord поднимается со своей
   базой из нетронутых томов.

Альтернатива (отдельная российская ячейка) — `distributed-media.md` §7.5; тогда на cordcam ничего из этого документа не
делается, он обновляется как раньше (`docs/RELEASE.md` §6).

## 9. Прокси YouTube для сервера в России (R196, Р-99) **[узел проверен с Франкфурта; из России — нет]**

Порядок для `cordcam.ru` (или любого сервера Cord в России), строго такой:

1. **Сначала замер — режут ли YouTube вообще.** На cordcam, из каталога установки, той же библиотекой, которой кинозал
   достаёт ролики (без прокси, окружение `CINEMA_PROXY*` не передаётся):
   ```bash
   docker compose exec -T -e CINEMA_PROXY= -e CINEMA_PROXY_YOUTUBE= services \
     python -m yt_dlp -f 'bv*[height<=1080]' --newline -o /dev/null 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' 2>&1 | tail -5
   ```
   В последних строках — скорость (`at 7.80MiB/s`). Ролик 1080p — около 6 Мбит/с (0,75 МиБ/с): если скорость стабильно
   **выше 1 МиБ/с** и загрузка не обрывается — **ничего не делать**, прокси не нужен. Ниже 0,5 МиБ/с, обрывы или
   `HTTP Error 403` на `googlevideo` — режут. Если модуля `yt_dlp` в образе нет — открыть ролик YouTube в кинозале
   комнаты и смотреть «Диагностику» кинозала и `docker compose logs services | grep -i youtube`.
2. Если режут: **туннель**. На cordcam, из каталога установки (файлы `infra/youtube-proxy/` есть в репозитории):
   ```bash
   sudo PSK='cord:<ключ из /opt/cord/youtube-proxy/tunnel.psk на B>' bash infra/youtube-proxy/client.sh 152.234.227.199
   ```
   Ключ и пароль берутся с B (`/opt/cord/youtube-proxy/tunnel.psk`, `/opt/cord/youtube-proxy/.password`, читать root'ом по
   SSH) и **никуда не записываются**, кроме окружения команды и `.env` cordcam. На B адрес cordcam уже разрешён на 8443/tcp
   (`ufw status | grep 8443`). Затем в `.env` cordcam строка
   `CINEMA_PROXY_YOUTUBE=http://cord:<пароль из .password>@127.0.0.1:3128` (общий `CINEMA_PROXY` не задавать) и
   `docker compose up -d --no-deps --force-recreate services`. Проверка: ролик YouTube в кинозале идёт; в журнале служб
   нет `proxy`-ошибок; `docker compose logs services | grep -c 'youtube'`.
3. Если туннель у оператора не живёт (обрывы, скорость < 2 Мбит/с через час наблюдения) — запасной `bol-van/zapret`
   (nfqws) на cordcam, по его документации; это последняя мера, он стоит на той же машине, что SFU, и ломается при смене
   оборудования оператора молча.

## 10. Откат всего R195 (если что-то пошло не так на A)

1. `docker compose stop backbone` на A и правило `ufw delete allow from 152.234.227.199 to any port 7443 proto tcp` — узел B
   отваливается от ядра: встречи на нём ядро через ≈ 15 с переселит на `fra` (люди переподключатся), новых на него не будет.
2. Убрать `COMPOSE_PROFILES`-профиль `nodes` и `CSP_NODES`/`NODE_ID` из `.env` не обязательно: без реестра ядро работает как
   раньше. Чтобы ядро «забыло» узлы — переименовать `infra/generated/nodes/registry.json` (например, в `registry.off`): ядро
   перечитает за ≤ 10 с и останется с одним неявным узлом `fra`.
3. Образы ядра и шлюза — откат по тегу `cord-rollback-*` (раздел 5.2).
4. На B ничего откатывать не нужно: без ядра узел просто простаивает.

## 11. Что не проверено и чем это грозит

- Пара A–B вживую (магистраль между двумя машинами, `forward_auth` через туннель, вебхуки узла в ядро A): проверены
  механизм mTLS между контейнерами на B и вся логика ядра с реальным SFU на B через временное ядро **на самом B**. На
  паре A–B — шаги раздела 5 с их проверками. Риск: опечатка в правилах ufw или в `.env`; проверки раздела 5 это покажут.
- **UDP от людей к A**: фильтр хостера A режет UDP между A и B; режет ли он загрузку с домашнего интернета — покажет
  только звонок владельца с дома (п. 16 `OWNER-ACTIONS.md`). Если да — камера с дома на `fra` будет рваться, и это
  аргумент ставить встречи на `hel` даже для Германии; решение по замеру.
- Замер UDP с устройства без NAT (публичный адрес прямо на машине): Chrome не создаёт `srflx`-кандидата, равного
  `host`, и проба считает UDP «закрытым»; тогда выбор идёт по TCP-обороту — узел тот же, путь медиа всё равно UDP. У
  домашних пользователей за NAT такого нет.
- Let's Encrypt для имён узла (`strict`) — как у стенда, но на B не выполнялось (нет DNS).
- `cordcam.ru`, `meet.nikg.tech` — не трогались вовсе (правило владельца).
