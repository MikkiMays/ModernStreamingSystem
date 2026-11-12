-- Аналитика Cord, вторая версия (R239, docs/architecture/analytics-v2.md §7). Схема `insight` базы продукта:
-- таблицы ядра (Flyway, схема public) службе не видны, её таблицы — ядру.
--
-- Слова в столбцах — латиницей, как в контракте (`contracts/insight.md`, `contracts/insight-reports.md`):
-- класс человека `engaged` | `confirmed`, класс сети `home` | `mobile` | `hosting` | `unknown`, класс устройства
-- `desktop` | `phone` | `tablet` | `tv`. Адреса нет ни в одной таблице (Р-139).

-- Человек. Строка появляется только у сессии класса «человек» (§5). Склейка «по отпечатку» (§4.5, 3а) не
-- сливает строки: узнанный по отпечатку получает свою строку и ссылку `merged_into` на прежнего человека.
-- Обычный счёт идёт по `coalesce(merged_into, id)`, строгий — по `id`: переключатель «строго» ничего не теряет.
CREATE TABLE an_persons (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merged_into    bigint REFERENCES an_persons (id) ON DELETE SET NULL,
    first_at       timestamptz NOT NULL,
    first_day      date        NOT NULL,
    -- Первый день, когда человек соединился с медиаузлом («подтверждён»).
    first_call_day date,
    -- Когда впервые стал собеседником: был во встрече не один дольше минуты.
    first_peer_at  timestamptz,
    last_day       date        NOT NULL,
    -- Откуда пришёл впервые.
    landing        text        NOT NULL DEFAULT '',
    source         text        NOT NULL DEFAULT '',
    utm_source     text        NOT NULL DEFAULT '',
    utm_medium     text        NOT NULL DEFAULT '',
    utm_campaign   text        NOT NULL DEFAULT '',
    client         text        NOT NULL DEFAULT '',
    os             text        NOT NULL DEFAULT '',
    country        text        NOT NULL DEFAULT ''
);
CREATE INDEX an_persons_first_day ON an_persons (first_day);
CREATE INDEX an_persons_last_day ON an_persons (last_day);
CREATE INDEX an_persons_merged ON an_persons (merged_into) WHERE merged_into IS NOT NULL;

-- Устройство: браузер или приложение с кукой `__Host-cord-did`; ключ — id из куки.
CREATE TABLE an_devices (
    id          text PRIMARY KEY,
    person_id   bigint      NOT NULL REFERENCES an_persons (id) ON DELETE CASCADE,
    client      text        NOT NULL,
    os          text        NOT NULL,
    browser     text        NOT NULL,
    class       text        NOT NULL,
    fp          text,
    fp_strength smallint    NOT NULL DEFAULT 0,
    -- Как привязано к человеку: `cookie`, `profile` (кука терялась, узнан по профилю), `fingerprint`.
    link        text        NOT NULL,
    created_at  timestamptz NOT NULL,
    last_at     timestamptz NOT NULL,
    -- Когда кука выдана или продлена в последний раз: продление — раз в 30 дней.
    cookie_at   timestamptz NOT NULL,
    -- Где устройство видели в последний раз — для правила 3а: отпечаток подсети, ASN, страна, пояс.
    net         text        NOT NULL DEFAULT '',
    asn         bigint,
    country     text        NOT NULL DEFAULT '',
    tz          text        NOT NULL DEFAULT ''
);
CREATE INDEX an_devices_person ON an_devices (person_id);
CREATE INDEX an_devices_fp ON an_devices (fp, last_at DESC) WHERE fp IS NOT NULL;

-- Псевдоним профиля → устройство.
CREATE TABLE an_profiles (
    profile    text PRIMARY KEY,
    device_id  text        NOT NULL REFERENCES an_devices (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL
);
CREATE INDEX an_profiles_device ON an_profiles (device_id);

-- Сессия человека: вкладка или запуск приложения до 30 минут тишины.
CREATE TABLE an_sessions (
    sid          text PRIMARY KEY,
    person_id    bigint      NOT NULL REFERENCES an_persons (id) ON DELETE CASCADE,
    device_id    text        NOT NULL,
    started_at   timestamptz NOT NULL,
    last_at      timestamptz NOT NULL,
    day          date        NOT NULL,
    client       text        NOT NULL DEFAULT '',
    version      text        NOT NULL DEFAULT '',
    os           text        NOT NULL DEFAULT '',
    browser      text        NOT NULL DEFAULT '',
    class        text        NOT NULL DEFAULT '',
    country      text        NOT NULL DEFAULT '',
    asn          bigint,
    net          text        NOT NULL DEFAULT 'unknown',
    vpn          boolean     NOT NULL DEFAULT false,
    landing      text        NOT NULL DEFAULT '',
    source       text        NOT NULL DEFAULT '',
    utm_source   text        NOT NULL DEFAULT '',
    utm_medium   text        NOT NULL DEFAULT '',
    utm_campaign text        NOT NULL DEFAULT '',
    -- `engaged` | `confirmed` и чем это доказано (`engaged`, `media`).
    human        text        NOT NULL,
    reason       text        NOT NULL DEFAULT '',
    -- Как узнали человека: `cookie`, `profile`, `fingerprint`, `new`.
    via          text        NOT NULL,
    -- Дальний шаг воронки: 1 открыл, 2 вовлечён, 3 предвход, 4 дал микрофон или камеру, 5 вошёл,
    -- 6 соединился с медиаузлом, 7 стал собеседником.
    step         smallint    NOT NULL DEFAULT 1,
    errors       integer     NOT NULL DEFAULT 0
);
CREATE INDEX an_sessions_day ON an_sessions (day);
CREATE INDEX an_sessions_person ON an_sessions (person_id, started_at);

-- События людей, разделы по месяцам. Разделы заводит служба: при записи и заранее на два месяца.
CREATE TABLE an_events (
    at        timestamptz NOT NULL,
    day       date        NOT NULL,
    sid       text,
    person_id bigint,
    name      text        NOT NULL,
    -- Псевдоним встречи: по аналитике встречу не открыть.
    room      text,
    props     jsonb       NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (day);
CREATE INDEX an_events_name_day ON an_events (name, day);
CREATE INDEX an_events_person ON an_events (person_id, at);

-- Человек × день.
CREATE TABLE an_person_days (
    person_id      bigint  NOT NULL REFERENCES an_persons (id) ON DELETE CASCADE,
    day            date    NOT NULL,
    sessions       integer NOT NULL DEFAULT 0,
    joins          integer NOT NULL DEFAULT 0,
    -- Секунды на связи с медиаузлом; из них — не один во встрече.
    talk_s         integer NOT NULL DEFAULT 0,
    together_s     integer NOT NULL DEFAULT 0,
    -- Собеседник дня: был во встрече не один дольше минуты.
    with_peer      boolean GENERATED ALWAYS AS (together_s >= 60) STORED,
    confirmed      boolean NOT NULL DEFAULT false,
    cinema_s       integer NOT NULL DEFAULT 0,
    music_s        integer NOT NULL DEFAULT 0,
    game_s         integer NOT NULL DEFAULT 0,
    board_s        integer NOT NULL DEFAULT 0,
    mic_s          integer NOT NULL DEFAULT 0,
    cam_s          integer NOT NULL DEFAULT 0,
    screen_s       integer NOT NULL DEFAULT 0,
    errors         integer NOT NULL DEFAULT 0,
    error_sessions integer NOT NULL DEFAULT 0,
    vpn_sessions   integer NOT NULL DEFAULT 0,
    invites        integer NOT NULL DEFAULT 0,
    PRIMARY KEY (person_id, day)
);
CREATE INDEX an_person_days_day ON an_person_days (day);

-- Встреча: от открытия до закрытия комнаты; сохранённая комната, открытая снова, — новая строка.
CREATE TABLE an_meetings (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room         text        NOT NULL,
    node         text        NOT NULL DEFAULT '',
    opened_at    timestamptz NOT NULL,
    day          date        NOT NULL,
    closed_at    timestamptz,
    creator      bigint REFERENCES an_persons (id) ON DELETE SET NULL,
    peak         integer     NOT NULL DEFAULT 0,
    joins        integer     NOT NULL DEFAULT 0,
    person_s     bigint      NOT NULL DEFAULT 0,
    together_s   bigint      NOT NULL DEFAULT 0,
    mic_s        bigint      NOT NULL DEFAULT 0,
    cam_s        bigint      NOT NULL DEFAULT 0,
    screen_s     bigint      NOT NULL DEFAULT 0,
    bytes_up     bigint      NOT NULL DEFAULT 0,
    bytes_down   bigint      NOT NULL DEFAULT 0,
    -- Сводки качества: сколько их, сколько из них через TURN, суммы потерь и оборота для средних.
    summaries    integer     NOT NULL DEFAULT 0,
    relay        integer     NOT NULL DEFAULT 0,
    loss_sum     double precision NOT NULL DEFAULT 0,
    rtt_sum      double precision NOT NULL DEFAULT 0,
    freezes      integer     NOT NULL DEFAULT 0,
    reconnects   integer     NOT NULL DEFAULT 0,
    moves        integer     NOT NULL DEFAULT 0,
    close_reason text        NOT NULL DEFAULT ''
);
CREATE INDEX an_meetings_day ON an_meetings (day);
CREATE INDEX an_meetings_open ON an_meetings (room) WHERE closed_at IS NULL;

-- Запуск интеграции.
CREATE TABLE an_integration_runs (
    run          text PRIMARY KEY,
    room         text        NOT NULL,
    kind         text        NOT NULL,
    variant      text        NOT NULL DEFAULT '',
    opener       bigint REFERENCES an_persons (id) ON DELETE SET NULL,
    opened_at    timestamptz NOT NULL,
    day          date        NOT NULL,
    closed_at    timestamptz,
    peak         integer     NOT NULL DEFAULT 0,
    person_s     bigint      NOT NULL DEFAULT 0,
    bytes        bigint      NOT NULL DEFAULT 0,
    stream_s     bigint      NOT NULL DEFAULT 0,
    errors       integer     NOT NULL DEFAULT 0,
    stalls       integer     NOT NULL DEFAULT 0,
    stall_ms     bigint      NOT NULL DEFAULT 0,
    close_reason text        NOT NULL DEFAULT ''
);
CREATE INDEX an_integration_runs_day ON an_integration_runs (day);
CREATE INDEX an_integration_runs_open ON an_integration_runs (room, kind) WHERE closed_at IS NULL;

-- Кто и сколько смотрел: человек × день × вид × площадка. Из неё «людей» по площадкам за любой период.
CREATE TABLE an_integration_days (
    day       date    NOT NULL,
    kind      text    NOT NULL,
    variant   text    NOT NULL,
    person_id bigint  NOT NULL REFERENCES an_persons (id) ON DELETE CASCADE,
    seconds   integer NOT NULL DEFAULT 0,
    stalls    integer NOT NULL DEFAULT 0,
    stall_ms  bigint  NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind, variant, person_id)
);

-- Группа ошибок: ключ — код + область + версия (первые два числа; у фактов ядра и служб — их имя).
CREATE TABLE an_errors (
    key      text PRIMARY KEY,
    code     text        NOT NULL,
    scope    text        NOT NULL,
    version  text        NOT NULL,
    -- Кто сообщил: `client`, `core`, `services`.
    source   text        NOT NULL,
    cause    text        NOT NULL,
    first_at timestamptz NOT NULL,
    last_at  timestamptz NOT NULL,
    count    bigint      NOT NULL DEFAULT 0,
    sessions bigint      NOT NULL DEFAULT 0,
    persons  bigint      NOT NULL DEFAULT 0,
    sample   jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX an_errors_last ON an_errors (last_at);

-- Группа × день × срезы: ряд по дням и разбивки за любой период.
CREATE TABLE an_error_days (
    key      text   NOT NULL,
    day      date   NOT NULL,
    client   text   NOT NULL DEFAULT '',
    os       text   NOT NULL DEFAULT '',
    browser  text   NOT NULL DEFAULT '',
    version  text   NOT NULL DEFAULT '',
    node     text   NOT NULL DEFAULT '',
    count    bigint NOT NULL DEFAULT 0,
    sessions bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day, client, os, browser, version, node)
);
CREATE INDEX an_error_days_day ON an_error_days (day);

-- Группа × день × человек: «сколько людей затронуто» за любой период без двойного счёта.
CREATE TABLE an_error_people (
    key       text    NOT NULL,
    day       date    NOT NULL,
    person_id bigint  NOT NULL REFERENCES an_persons (id) ON DELETE CASCADE,
    count     integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day, person_id)
);
CREATE INDEX an_error_people_day ON an_error_people (day);

-- Суточный трафик: заходы всех классов без строки на заход. `class`: `human`, `unclear`, `bot`,
-- `automation`, `own`; `bot` — имя робота или пусто.
CREATE TABLE an_traffic_days (
    day     date   NOT NULL,
    class   text   NOT NULL,
    bot     text   NOT NULL DEFAULT '',
    client  text   NOT NULL DEFAULT '',
    os      text   NOT NULL DEFAULT '',
    country text   NOT NULL DEFAULT '',
    net     text   NOT NULL DEFAULT 'unknown',
    visits  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, class, bot, client, os, country, net)
);

-- Суточные счётчики фактов, у которых нет человека или он не нужен: входы и отказы по способу и узлу,
-- отказы защиты, причины разрыва, итоги разрешений, возможности. `a`, `b` — срезы счётчика (см. код).
CREATE TABLE an_counts (
    day    date   NOT NULL,
    metric text   NOT NULL,
    a      text   NOT NULL DEFAULT '',
    b      text   NOT NULL DEFAULT '',
    n      bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, metric, a, b)
);

-- Принятые факты: повтор пачки с тем же `id` ничего не удваивает. Строки живут несколько дней.
CREATE TABLE an_fact_ids (
    id text PRIMARY KEY,
    at timestamptz NOT NULL
);
CREATE INDEX an_fact_ids_at ON an_fact_ids (at);

-- Принятые ответы на задачу «не робот»: ответ годится один раз. Строка живёт до срока задачи.
CREATE TABLE an_proofs (
    signature  text PRIMARY KEY,
    expires_at timestamptz NOT NULL
);
