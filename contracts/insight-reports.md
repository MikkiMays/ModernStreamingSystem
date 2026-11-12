# Отчёты службы `insight`: формы ответов (R239)

Контракт службы — `contracts/insight.md` (§3 — как спросить отчёт), проект — `docs/architecture/analytics-v2.md` (§8 —
что значит каждая метрика). Здесь — что служба отвечает: типы TypeScript для пульта. Образцы настоящих ответов —
`contracts/fixtures/insight/*.json`: их строит тест службы из синтетического набора (60 дней, несколько сотен людей, роботы,
свои проверки, встречи, интеграции, ошибки) и сверяет с файлами байт в байт — изменилась форма, изменится и образец.

Файл ведёт служба: правка формы — здесь, в `rust/insight/src/reports/sql.rs` и в образцах одним коммитом.

## 1. Запрос

`GET /internal/reports/{раздел}?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД[&view=period|cohort][&strict=0|1][&compare=0|1]`,
заголовок `X-Insight-Key`. Разделы: `pulse`, `audience`, `acquisition`, `activation`, `retention`, `engagement`,
`integrations`, `quality`, `errors`, `errors/{key}`, `traffic`.

| Параметр | Что значит |
| --- | --- |
| `from`, `to` | дни по поясу `ANALYTICS_ZONE`, включительно; период не длиннее 400 дней |
| `view=period` (по умолчанию) | **«За период»**: всё, что произошло в выбранные дни, у всех людей |
| `view=cohort` | **«Когорты»**: люди, пришедшие впервые в выбранные дни, и вся их дальнейшая жизнь до сегодня |
| `strict=1` | строгий счёт: узнанные по отпечатку устройства считаются отдельными людьми |
| `compare=1` | приложить тот же расчёт за прошлый период той же длины (`previous`) |

Ответы об ошибке — `{ "error": "<текст>" }`: `400` — нет или не разобрать `from`/`to`/`view`/`strict`/`compare`, `from`
позже `to`, период длиннее 400 дней; `401` — нет верного `X-Insight-Key`; `404` — нет такого раздела или такой группы
ошибок; `503` — база не ответила, спросить позже.

### Что меняет вид

У каждого расчёта есть **горизонт** — последний день, до которого смотрят события: у «За период» это `to`, у «Когорт» —
сегодня. И **люди отчёта**: у «За период» — все, кто был в днях `from…to`; у «Когорт» — пришедшие впервые в `from…to`.

Блоки бывают двух родов, у каждого поля ниже это сказано:

- **по людям** — считаются по людям отчёта и их дням от `from` до горизонта; меняются и от вида, и от `strict`;
- **по календарю** — встречи, запуски интеграций, счётчики фактов ядра, трафик: у них нет человека, они берутся за дни от
  `from` до горизонта и от `strict` не зависят.

Сессии и события хранятся 90 дней: разрезы по сессиям (клиент, ОС, браузер, сеть), время входа и образцы ошибок за
более давние дни пусты. Строки «человек × день», встречи, запуски и ошибки — 400 дней.

## 2. Оболочка

```ts
interface Report<T> {
  section: string;              // раздел; у отчёта об одной группе ошибок — "errors/{key}"
  range: Range;                 // запрошенный период
  view: 'period' | 'cohort';    // вид: «За период» или «Когорты»
  strict: boolean;              // строгий счёт — без склейки по отпечатку
  zone: string;                 // пояс суток аналитики, например "Europe/Moscow"
  generated_at: string;         // когда построен отчёт, ISO 8601
  data: T;                      // сам отчёт
  previous?: {                  // только при compare=1: тот же расчёт за прошлый период той же длины
    range: Range;
    data: T;
  };
}

interface Range {
  from: string;                 // первый день, "ГГГГ-ММ-ДД"
  to: string;                   // последний день, включительно
  days: number;                 // дней в периоде
}
```

Общие правила значений:

- доля — число от 0 до 1 с четырьмя знаками; `null` — делить не на что (пустой знаменатель);
- часы — с двумя знаками, минуты — с одним; байты, секунды, мс — целые;
- день — `"ГГГГ-ММ-ДД"`, момент — ISO 8601 со смещением (`"2026-11-10T17:07:40+00:00"`);
- ряды по дням идут от `from` до горизонта без пропусков: день без событий — строка с нулями;
- списки-разрезы отсортированы по убыванию главного числа и обрезаны (обычно 50 строк, группы ошибок — 200).

## 3. Слова

| Где | Слова |
| --- | --- |
| класс трафика (`class`) | `human` — люди, `unclear` — неясно, `bot` — робот по агенту, `automation` — браузер под управлением, `own` — свои проверки |
| вид клиента (`client`) | `web`, `desktop`, `android`, `telegram`, `other` |
| система (`os`) | `windows`, `macos`, `linux`, `android`, `ios`, `other` |
| браузер (`browser`) | `chrome`, `safari`, `firefox`, `edge`, `opera`, `yandex`, `samsung`, `webview`, `electron` (приложение Cord), `other` |
| класс устройства (`device`) | `desktop`, `phone`, `tablet`, `tv` |
| класс сети (`net`) | `home`, `mobile`, `hosting` (дата-центр или выход VPN), `unknown` |
| страна (`country`) | код ISO 3166-1 (`RU`) или пустая строка — неизвестно |
| как узнан человек (`via`) | `cookie` — по куке, `profile` — по профилю (кука терялась), `fingerprint` — по отпечатку, `new` — новый |
| вход (`landing`) | `home`, `invite`, `room`, `app`, `tg`, `download`, `support`, `other`; пустая строка — клиент не сказал |
| шаг воронки (`step`) | `open` (1), `engaged` (2), `prejoin` (3), `permission` (4), `join` (5), `media` (6), `talk` (7) |
| вид интеграции (`kind`) | `cinema`, `music`, `game`, `board` |
| кто сообщил об ошибке (`source`) | `client`, `core`, `services` |
| класс причины ошибки (`cause`) | `permission` — разрешение, `device` — устройство, `network` — сеть, `server` — сервер, `platform` — площадка, `limit` — предел или отказ двери по правилу (неверный код, встречи нет), `version` — версия, `crash` — сбой и всё, для чего нет правила |

Имена роботов (`bot`): `google`, `yandex`, `bing`, `duckduckgo`, `baidu`, `mailru`, `apple`, `yahoo`, `petal`, `seznam`,
`naver`, `sogou`, `search-other`, `openai`, `anthropic`, `perplexity`, `bytedance`, `commoncrawl`, `meta-ai`, `ai-other`,
`telegram`, `whatsapp`, `facebook`, `vk`, `twitter`, `discord`, `slack`, `linkedin`, `preview-other`, `ahrefs`, `semrush`,
`majestic`, `moz`, `seo-other`, `archive`, `scanner`, `monitor`, `curl`, `wget`, `python`, `go`, `java`, `node`,
`http-other`, `other`, `no-agent`. Список растёт: незнакомое имя пульт показывает как есть.

Ключ группы ошибок — `код~область~версия`: версия клиента по двум старшим номерам (`ROOM_FULL~join~1.4`), у ошибок,
которые вернул сервер, на её месте — кто сообщил (`ROOM_FULL~join~core`). В адресе `errors/{key}` ключ идёт как есть.

## 4. Имена метрик пульта → поля

| Имя в пульте (§8 проекта) | Раздел и поле |
| --- | --- |
| Люди за день, неделю, месяц | `audience.series[].dau`, `.wau`, `.mau` |
| Новые | `pulse.tiles.new_people`, `audience.totals.new_people` |
| Вернувшиеся | `pulse.tiles.returning` |
| Воскресшие | `pulse.tiles.resurrected` |
| Собеседники | `pulse.tiles.interlocutors` |
| Недельные собеседники | `pulse.tiles.weekly_interlocutors`, ряд — `pulse.series[].weekly_interlocutors` |
| Доля собеседников | `pulse.tiles.interlocutor_share` |
| Активация | `activation.share_24h`, `activation.share_7d` |
| Липкость | `pulse.tiles.stickiness`, по дням — `audience.series[].stickiness` |
| Частота | `audience.frequency`, `engagement.frequency` |
| Удержание D1, D7, D30 | `retention.total.d1`, `.d7`, `.d30` (и «вернулся и разговаривал» — `talked`), по когортам — `retention.cohorts` |
| Разговорное время | `engagement.totals.talk_hours`, `.minutes_per_interlocutor_day`, `engagement.meetings.median_minutes` |
| Приглашения | `acquisition.totals.by_invite`, `.k_factor` |
| Успешность входа | `quality.join.success`, причины — `quality.join.failures` |
| Время входа | `quality.join_time.total.p50_ms`, `.p95_ms` |
| Сессии без ошибок | `quality.sessions.error_free_share` |
| Интеграции | `integrations.by_kind`, `integrations.by_variant` |
| Трафик | `traffic.totals`, роботы по именам — `traffic.bots` |
| Через VPN | `quality.sessions.vpn_share`, `pulse.tiles.vpn_share` |
| Подтверждённые и вовлечённые раздельно | `pulse.tiles.confirmed`, `pulse.tiles.engaged_only` |
| Из вернувшихся узнаны по отпечатку | `audience.totals.recognised_by_fingerprint`, `audience.recognised` |

## 5. `pulse` — пульс

Плитки главного экрана с изменением к прошлому периоду и ряды по дням. Прошлый период у плиток есть всегда, без
`compare`. Образец — `fixtures/insight/pulse.json`.

```ts
interface Pulse {
  tiles: Record<PulseTile, Tile>;  // плитки: число, оно же за прошлый период и изменение
  series: PulseDay[];              // ряды по дням
}

interface Tile {
  value: number | null;     // значение за период
  previous: number | null;  // значение за прошлый период той же длины
  change: number | null;    // изменение долей: (value − previous) / previous; null — сравнить не с чем
}

type PulseTile =
  | 'people'                // по людям: разные люди, бывшие в периоде
  | 'new_people'            // по людям: из них пришли впервые в периоде
  | 'returning'             // по людям: из них были и до периода
  | 'resurrected'           // по людям: вернулись после 14 и более дней тишины
  | 'interlocutors'         // по людям: собеседники — были во встрече не одни дольше минуты за день
  | 'weekly_interlocutors'  // по людям: собеседники за 7 дней до горизонта — путеводная метрика
  | 'interlocutor_share'    // по людям: собеседники ÷ люди
  | 'confirmed'             // по людям: соединялись с медиаузлом в периоде («подтверждены»)
  | 'engaged_only'          // по людям: только «вовлечены» — без звонка; люди = confirmed + engaged_only
  | 'talk_hours'            // по людям: человеко-часы на связи с медиаузлом
  | 'join_success'          // по календарю: входы ÷ (входы + отказы двери)
  | 'join_p50_ms'           // по людям: медиана времени входа от нажатия до звука, мс (события 90 дней)
  | 'error_free_sessions'   // по людям: доля сессий, где человек не увидел ошибки
  | 'vpn_share'             // по людям: доля сессий с признаком VPN
  | 'stickiness';           // по людям: средние люди за день ÷ люди за 30 дней до горизонта

interface PulseDay {
  day: string;                   // день
  people: number;                // люди за день
  new_people: number;            // из них пришли впервые в этот день
  interlocutors: number;         // собеседники дня
  talk_hours: number;            // человеко-часы на связи
  weekly_interlocutors: number;  // собеседники за 7 дней, кончающихся этим днём
}
```

## 6. `audience` — аудитория

Образец — `fixtures/insight/audience.json`.

```ts
interface Audience {
  totals: {
    people: number;                     // по людям: разные люди периода
    new_people: number;                 // пришли впервые в периоде
    returning: number;                  // были и до периода
    resurrected: number;                // вернулись после 14 и более дней тишины
    recognised_by_fingerprint: number;  // устройств, впервые пришедших в from…to и узнанных по отпечатку как прежний человек
    confirmed: number;                  // соединялись с медиаузлом
    engaged_only: number;               // только вовлечены
    sessions: number;                   // сессий людей
    sessions_per_person: number | null; // сессий на человека
    vpn_sessions: number;               // сессий с признаком VPN
    vpn_share: number | null;           // их доля
    stickiness: number | null;          // средние люди за день ÷ люди за 30 дней до горизонта
  };
  series: AudienceDay[];        // люди за день, неделю, месяц — по дням
  frequency: Frequency[];       // сколько дней из последних семи (до горизонта) человек был активен
  recognised: {                 // сессии по тому, как узнан человек (сессии хранятся 90 дней)
    cookie: number;             // по куке устройства
    profile: number;            // по профилю: кука терялась
    fingerprint: number;        // по отпечатку: потеряны и кука, и профиль
    new: number;                // новый человек
  };
  by_client: Breakdown[];       // по виду клиента
  by_os: Breakdown[];           // по системе
  by_browser: Breakdown[];      // по семейству браузера
  by_device: Breakdown[];       // по классу устройства
  by_country: Breakdown[];      // по стране адреса
  by_network: Breakdown[];      // по классу сети
}

interface AudienceDay {
  day: string;                // день
  dau: number;                // люди за день
  wau: number;                // люди за 7 дней, кончающихся этим днём
  mau: number;                // люди за 30 дней, кончающихся этим днём
  new_people: number;         // пришли впервые в этот день
  returning: number;          // были в этот день и раньше него
  resurrected: number;        // вернулись в этот день после 14 и более дней тишины
  stickiness: number | null;  // dau ÷ mau
}

interface Frequency {
  active_days: number;  // 1…7 — сколько дней из семи
  people: number;       // сколько таких людей
}

interface Breakdown {
  key: string;       // слово разреза (§3)
  people: number;    // разные люди с такими сессиями
  sessions: number;  // сессий
}
```

## 7. `acquisition` — привлечение

Люди отчёта — пришедшие впервые в `from…to`, в обоих видах. «Стал собеседником»: у «За период» — за 7 дней от первого
дня и в пределах периода; у «Когорт» — когда-либо до сегодня. Образец — `fixtures/insight/acquisition.json`.

```ts
interface Acquisition {
  totals: {
    new_people: number;           // пришли впервые в периоде
    by_invite: number;            // из них по ссылке-приглашению (landing = "invite")
    invite_share: number | null;  // их доля
    interlocutors: number;        // из новых стали собеседниками
    invites_sent: number;         // по календарю (from…to): сколько раз ссылку копировали или отправляли
    inviters: number;             // сколько людей это делали
    k_factor: number | null;      // новые собеседники по приглашению ÷ собеседники периода (from…to, все люди)
  };
  by_landing: Source[];   // по входу
  by_source: Source[];    // по домену источника; key "" — прямой заход
  by_campaign: Source[];  // по меткам utm: "source / medium / campaign"; только пришедшие с метками
  by_client: Source[];    // по виду клиента первого захода
  by_os: Source[];        // по системе
  by_country: Source[];   // по стране
  invites: { how: 'copy' | 'share' | 'qr'; count: number }[];  // по календарю: приглашения по способу
  series: { day: string; new_people: number; by_invite: number }[];  // по дням from…to
}

interface Source {
  key: string;            // слово разреза
  new_people: number;     // пришли впервые
  interlocutors: number;  // из них стали собеседниками
  share: number | null;   // их доля
}
```

## 8. `activation` — активация

Люди отчёта — пришедшие впервые в `from…to`. Активация — новый стал собеседником за 24 часа и за 7 дней от первого
захода. Доля считается среди «зрелых» — тех, у кого срок уже вышел к горизонту. Образец —
`fixtures/insight/activation.json`.

```ts
interface Activation {
  new_people: number;          // пришли впервые в периоде
  activated_24h: number;       // стали собеседниками за 24 часа (и до горизонта)
  activated_7d: number;        // за 7 дней
  mature_24h: number;          // у скольких 24 часа от первого захода уже прошли
  mature_7d: number;           // у скольких прошли 7 дней
  share_24h: number | null;    // активированные за 24 часа ÷ зрелые
  share_7d: number | null;     // активированные за 7 дней ÷ зрелые
  funnel: {                    // докуда дошли новые: дальний шаг их сессий (сессии хранятся 90 дней)
    step: 'open' | 'engaged' | 'prejoin' | 'permission' | 'join' | 'media' | 'talk';
    people: number;            // дошли до шага или дальше
    share: number | null;      // доля от новых
  }[];
  time_to_talk: {              // сколько прошло от первого захода до «стал собеседником»
    bucket: '10m' | '1h' | '24h' | '7d' | 'later' | 'never';  // до 10 минут, до часа, до суток, до 7 дней, позже, не стал
    people: number;
  }[];
  permissions: {               // по календарю: итоги запросов микрофона, камеры и показа
    device: 'mic' | 'cam' | 'screen';
    result: 'granted' | 'denied' | 'dismissed' | 'error';
    count: number;
  }[];
  series: { day: string; new_people: number; activated_24h: number; activated_7d: number }[];  // по дню прихода
}
```

## 9. `retention` — удержание

Люди отчёта — пришедшие впервые в `from…to`. **D-N — вернулся в течение N дней от первого дня**: был хотя бы в один
из дней с первого+1 по первый+N; отдельно — «вернулся и разговаривал» (в такой день был собеседником). Считаются только
«зрелые» — те, у кого первый день + N не позже горизонта: у «За период» это `to` (видно то, что случилось в периоде), у
«Когорт» — сегодня. Образец — `fixtures/insight/retention.json` (вид «Когорты»).

```ts
interface Retention {
  bucket: 'day' | 'week' | 'month';  // шаг когорт: день (период до 31 дня), неделя (до 182), месяц
  total: Cohort;                     // все пришедшие в периоде
  cohorts: (Cohort & { cohort: string })[];  // по шагам; cohort — первый день шага (неделя — с понедельника)
  curve: {                // кривая: кто был ровно на N-й день после первого
    age: number;          // 0…30
    eligible: number;     // у скольких этот день уже наступил к горизонту
    active: number;       // сколько из них были в этот день
    share: number | null;
    talked: number;       // сколько были собеседниками в этот день
    talked_share: number | null;
  }[];
  carried: {                  // удержание период к периоду (не зависит от вида)
    previous_people: number;  // люди прошлого периода той же длины
    stayed: number;           // из них были и в from…to
    share: number | null;
  };
}

interface Cohort {
  size: number;  // пришли впервые
  d1: Kept;      // вернулись на следующий день
  d7: Kept;      // в течение 7 дней
  d30: Kept;     // в течение 30 дней
}

interface Kept {
  eligible: number;             // у скольких срок уже вышел
  returned: number;             // из них вернулись
  share: number | null;         // returned ÷ eligible
  talked: number;               // вернулись и разговаривали
  talked_share: number | null;  // talked ÷ eligible
}
```

## 10. `engagement` — вовлечённость

Образец — `fixtures/insight/engagement.json`.

```ts
interface Engagement {
  totals: {                                       // по людям
    people: number;                               // люди
    interlocutors: number;                        // собеседники
    talk_hours: number;                           // человеко-часы на связи с медиаузлом
    together_hours: number;                       // из них не в одиночку
    minutes_per_interlocutor_day: number | null;  // минут на связи на собеседника в день
    sessions: number;                             // сессий
    sessions_per_person: number | null;
    joins: number;                                // входов во встречи
    mic_hours: number;                            // часы с включённым микрофоном (из сводок качества)
    cam_hours: number;                            // с камерой
    screen_hours: number;                         // с показом экрана
    integration_hours: { cinema: number; music: number; game: number; board: number };  // часы за интеграциями
  };
  meetings: {                        // по календарю: встречи, открытые в днях отчёта
    count: number;                   // встреч
    with_peers: number;              // из них не в одиночку (пик людей ≥ 2)
    median_minutes: number | null;   // медиана длительности оконченных встреч
    p90_minutes: number | null;      // 90-й процентиль
    peak_avg: number | null;         // средний пик людей
    person_hours: number;            // человеко-часы
  };
  series: {
    day: string;
    talk_hours: number;                       // человеко-часы за день
    interlocutors: number;                    // собеседники дня
    minutes_per_interlocutor: number | null;  // минут на собеседника
    meetings: number;                         // встреч, открытых в этот день
  }[];
  frequency: Frequency[];            // сколько дней из семи (§6)
  meeting_sizes: { bucket: '1' | '2' | '3-5' | '6-10' | '11+'; meetings: number }[];  // по пику людей
  meeting_lengths: { bucket: '<1m' | '1-5m' | '5-15m' | '15-60m' | '1-3h' | '3h+'; meetings: number }[];  // по длительности
  features: { name: string; count: number; sessions: number }[];  // по календарю: возможности — раз и сессий
  screens: { name: string; count: number }[];                     // по календарю: показы экранов
  leave_reasons: { reason: string; count: number }[];  // по календарю: почему вышли, со слов клиента (user, closed, network, removed, ended)
  drop_reasons: { reason: string; count: number }[];   // по календарю: почему разорвано, со слов ядра (left, lost, removed, ended, moved)
}
```

## 11. `integrations` — интеграции

Запуски, байты и ошибки — по календарю (факты ядра и служб); люди и часы просмотра — по людям (события клиента).
Образец — `fixtures/insight/integrations.json`.

```ts
interface Integrations {
  totals: IntegrationRow;                                         // всё вместе
  by_kind: (IntegrationRow & { kind: string })[];                 // по видам
  by_variant: (IntegrationRow & { kind: string; variant: string })[];  // по площадкам и играм
  series: { day: string; cinema: number; music: number; game: number; board: number; watch_hours: number }[];  // запусков по видам и часы просмотра
  errors: { kind: string; variant: string; code: string; count: number }[];  // ошибки интеграций по кодам
  close_reasons: { kind: string; reason: string; runs: number }[];           // чем кончались запуски (closed, replaced, ended, error, unknown)
}

interface IntegrationRow {
  runs: number;                    // запусков
  people: number;                  // разных людей, у кого интеграция была на экране
  meetings: number;                // встреч с запуском
  meeting_share: number | null;    // их доля среди встреч
  watch_hours: number;             // человеко-часы просмотра
  avg_minutes: number | null;      // средняя длительность оконченного запуска
  median_minutes: number | null;   // медиана длительности
  peak_avg: number | null;         // средний пик смотрящих
  bytes: number;                   // байты: кинозал и музыка — отчёт служб; доска и игры — что прислало ядро
  stream_hours: number;            // часы потока по отчётам служб
  bytes_per_hour: number | null;   // байт на час потока — сколько стоит час
  errors: number;                  // ошибок
  stalls: number;                  // застоев у зрителей
  stall_seconds: number;           // секунд застоев
}
```

## 12. `quality` — качество

Образец — `fixtures/insight/quality.json`.

```ts
interface Quality {
  join: {                           // по календарю: входы и отказы двери — факты ядра
    attempts: number;               // входы + отказы
    joined: number;                 // входов
    failed: number;                 // отказов
    success: number | null;         // успешность входа
    by_how: { how: string; count: number }[];        // входы по способу (create, link, code, saved, rejoin)
    by_node: { node: string; joined: number }[];     // входы по узлам
    failures: { code: string; count: number; share: number | null }[];  // причины отказов и их доля
  };
  join_time: {                      // по людям: время входа из событий клиента (90 дней)
    total: Timing;
    by_node: (Timing & { node: string })[];
  };
  sessions: {                       // по людям
    total: number;                  // сессий
    without_errors: number;         // без единой увиденной ошибки
    error_free_share: number | null;
    vpn: number;                    // с признаком VPN
    vpn_share: number | null;
  };
  media: {                          // по календарю: встречи и сводки качества
    total: Media;
    by_node: (Media & { node: string })[];
  };
  drops: { reason: string; count: number }[];    // по календарю: причины разрыва соединения с медиаузлом
  refusals: { code: string; count: number }[];   // по календарю: отказы защиты (RATE_LIMITED, PROOF_INVALID, BLOCKED…)
  networks: {                       // по людям: сессии по классу сети (90 дней)
    net: string;
    sessions: number;
    people: number;
    vpn_share: number | null;
    error_free_share: number | null;
  }[];
  series: {
    day: string;
    joined: number;                   // входов
    failed: number;                   // отказов
    success: number | null;           // успешность входа
    error_free_share: number | null;  // доля сессий без ошибок
    vpn_share: number | null;         // доля сессий через VPN
  }[];
}

interface Timing {
  samples: number;               // замеров
  p50_ms: number | null;         // медиана от нажатия до звука
  p95_ms: number | null;         // 95-й процентиль
  signal_p50_ms: number | null;  // медиана сигнальной части
  media_p50_ms: number | null;   // медиана медиа-части
}

interface Media {
  meetings: number;                    // встреч
  person_hours: number;                // человеко-часы
  summaries: number;                   // сводок качества (каждая — 10 секунд одного участника)
  loss_avg: number | null;             // средние потери — как прислало ядро (доля 0…1)
  rtt_avg_ms: number | null;           // средний оборот, мс
  relay_share: number | null;          // доля сводок через TURN
  freezes: number;                     // замираний
  freezes_per_hour: number | null;     // на человеко-час
  reconnects: number;                  // переподключений
  reconnects_per_hour: number | null;
  node_moves: number;                  // переездов между узлами
}
```

## 13. `errors` — ошибки

Счёт событий и сессий — по календарю; «людей затронуто» — по людям. Доли — от сессий и людей отчёта. Сессии здесь —
и людей, и «неясно» (сбой при открытии страницы случается раньше любого действия); ошибки роботов и своих проверок не
считаются. Образец — `fixtures/insight/errors.json`.

```ts
interface Errors {
  totals: {
    events: number;                 // сколько раз ошибки случились
    groups: number;                 // сколько разных групп
    new_groups: number;             // из них впервые появились в периоде
    sessions_affected: number;      // сессий, увидевших ошибку
    sessions_share: number | null;  // их доля от сессий людей
    people_affected: number;        // затронуто людей
    people_share: number | null;    // их доля
  };
  by_cause: { cause: Cause; events: number; groups: number; sessions: number; people: number }[];  // по классам причин
  groups: ErrorGroup[];             // группы периода, до 200, по убыванию числа событий
  series: { day: string; events: number; sessions: number; people: number }[];
}

type Cause = 'permission' | 'device' | 'network' | 'server' | 'platform' | 'limit' | 'version' | 'crash';

interface ErrorGroup {
  key: string;                    // ключ группы — для errors/{key}
  code: string;                   // код из contracts/errors.json или имя исключения
  scope: string;                  // область: join, media, device, cinema, music, game, board, chat, update, app, guard
  version: string;                // версия клиента по двум старшим номерам или кто сообщил (core, services)
  source: 'client' | 'core' | 'services';
  cause: Cause;                   // класс причины
  events: number;                 // событий в периоде
  sessions: number;               // сессий в периоде
  people: number;                 // людей в периоде
  sessions_share: number | null;
  people_share: number | null;
  first_at: string;               // первый раз за всё время
  last_at: string;                // последний раз
  is_new: boolean;                // до периода группы не было
}
```

## 14. `errors/{key}` — одна группа ошибок

`404`, если группы нет. Разрезы — за дни отчёта; образцы и шаги — из событий (90 дней). Образец —
`fixtures/insight/errors-detail.json`.

```ts
interface ErrorDetail {
  group: {
    key: string; code: string; scope: string; version: string;
    source: 'client' | 'core' | 'services';
    cause: Cause;
    first_at: string;        // первая встреча ошибки
    last_at: string;         // последняя
    events_total: number;    // событий за всё время
    sessions_total: number;  // сессий за всё время
    people_total: number;    // людей за всё время
  };
  period: { events: number; sessions: number; people: number; sessions_share: number | null; people_share: number | null };
  series: { day: string; events: number; sessions: number; people: number }[];
  versions: Slice[];   // по полной версии клиента
  os: Slice[];         // по системе
  browsers: Slice[];   // по браузеру
  clients: Slice[];    // по виду клиента; у фактов ядра и служб — их имя
  nodes: Slice[];      // по узлу; "" — узел неизвестен
  steps: { step: number; events: number }[];  // на каком шаге воронки (1…7, §3) сессия увидела ошибку
  samples: {           // последние 20 случаев — без ключей людей
    at: string;              // когда
    screen: string | null;   // экран
    fatal: boolean;          // фатальна ли
    detail: string | null;   // машинный текст: имя ошибки, код ответа
    step: number | null;     // шаг воронки
    how: string | null;      // способ входа — у отказов двери
    client: string | null; version: string | null; os: string | null; browser: string | null;  // из сессии
  }[];
}

interface Slice {
  key: string;
  events: number;
  sessions: number;
}
```

## 15. `traffic` — трафик

Все заходы по классам — люди, неясно, роботы по именам, автоматика, свои. По календарю; от вида и `strict` не
зависит. Заход человека считается один раз: сессия, проявившая себя, переносится из «неясно» в «люди». Образец —
`fixtures/insight/traffic.json` (с `compare=1`).

```ts
interface Traffic {
  totals: Visits & {
    visits: number;              // всего заходов
    human_share: number | null;  // доля людей
  };
  by_class: { class: 'human' | 'unclear' | 'bot' | 'automation' | 'own'; visits: number; share: number | null }[];
  bots: { bot: string; visits: number }[];   // роботы по именам, до 100
  series: (Visits & { day: string })[];
  by_client: (Visits & { key: string })[];   // по виду клиента
  by_os: (Visits & { key: string })[];       // по системе
  by_country: (Visits & { key: string })[];  // по стране
  by_network: (Visits & { key: string })[];  // по классу сети
}

interface Visits {
  human: number;       // люди: сессии классов «вовлечён» и «подтверждён»
  unclear: number;     // неясно: открыл и ушёл
  bot: number;         // роботы по агенту
  automation: number;  // браузеры под управлением
  own: number;         // свои проверки с X-Cord-Probe
}
```

## 16. Об образцах

Набор для образцов живёт в `rust/insight/tests/db/fixtures.rs`. Он похож на жизнь, но в двух местах упрощён: сводка
качества в нём одна на участника в минуту (в жизни — раз в 10 секунд), поэтому часы микрофона и камеры в образцах
вшестеро меньше часов на связи; адреса и базы адресов не участвуют — страна и сеть заданы набором.

Записать образцы заново после правки отчётов:

```bash
DATABASE_URL=postgres://… INSIGHT_WRITE_FIXTURES=1 rust/cargo.sh test --test db fixtures
```
