//! Запись пачками. Движок ничего не пишет по событию: он копит прибавки к суточным строкам и строки
//! событий, а `flush` раз в пару секунд отдаёт их базе одной транзакцией. Не удалась транзакция — прибавки
//! остаются в памяти до следующей попытки.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::{AssertSqlSafe, PgConnection};

/// Больше строк событий в памяти не держим: при долгом отказе базы старые выбрасываются со счётчиком.
pub const MAX_EVENT_ROWS: usize = 50_000;

/// Столбец пачки: массив значений одного типа.
pub enum Col {
    Text(Vec<String>),
    OptText(Vec<Option<String>>),
    Date(Vec<NaiveDate>),
    Time(Vec<DateTime<Utc>>),
    Big(Vec<i64>),
    OptBig(Vec<Option<i64>>),
    Bool(Vec<bool>),
    Json(Vec<Value>),
}

impl Col {
    fn cast(&self) -> &'static str {
        match self {
            Col::Text(_) | Col::OptText(_) => "text[]",
            Col::Date(_) => "date[]",
            Col::Time(_) => "timestamptz[]",
            Col::Big(_) | Col::OptBig(_) => "bigint[]",
            Col::Bool(_) => "boolean[]",
            Col::Json(_) => "jsonb[]",
        }
    }

    fn len(&self) -> usize {
        match self {
            Col::Text(v) => v.len(),
            Col::OptText(v) => v.len(),
            Col::Date(v) => v.len(),
            Col::Time(v) => v.len(),
            Col::Big(v) => v.len(),
            Col::OptBig(v) => v.len(),
            Col::Bool(v) => v.len(),
            Col::Json(v) => v.len(),
        }
    }
}

/// Что делать со строкой, которая уже есть.
pub enum Conflict<'a> {
    /// Просто вставка.
    None,
    /// Ничего: строка уже есть.
    Skip(&'a [&'a str]),
    /// Ключ и правила обновления (`столбец = выражение`, новая строка — `EXCLUDED`).
    Update(&'a [&'a str], String),
}

/// Сложить столбцы-счётчики: `a = t.a + EXCLUDED.a, …`.
pub fn sum(table: &str, columns: &[&str]) -> String {
    columns.iter().map(|c| format!("{c} = {table}.{c} + EXCLUDED.{c}")).collect::<Vec<_>>().join(", ")
}

/// Вставить пачку строк одним запросом: `INSERT … SELECT * FROM UNNEST(…)`. Имена таблиц и столбцов —
/// только из кода службы, значения — параметрами.
pub async fn write(
    conn: &mut PgConnection,
    table: &str,
    columns: &[(&str, Col)],
    conflict: Conflict<'_>,
) -> Result<u64, sqlx::Error> {
    if columns.first().is_none_or(|(_, col)| col.len() == 0) {
        return Ok(0);
    }
    let names: Vec<&str> = columns.iter().map(|(name, _)| *name).collect();
    let params: Vec<String> = columns.iter().enumerate().map(|(i, (_, col))| format!("${}::{}", i + 1, col.cast())).collect();
    let tail = match conflict {
        Conflict::None => String::new(),
        Conflict::Skip(key) => format!(" ON CONFLICT ({}) DO NOTHING", key.join(", ")),
        Conflict::Update(key, set) => format!(" ON CONFLICT ({}) DO UPDATE SET {set}", key.join(", ")),
    };
    let sql = format!("INSERT INTO {table} ({}) SELECT * FROM UNNEST({}){tail}", names.join(", "), params.join(", "));
    let mut query = sqlx::query(AssertSqlSafe(sql));
    for (_, col) in columns {
        query = match col {
            Col::Text(v) => query.bind(v),
            Col::OptText(v) => query.bind(v),
            Col::Date(v) => query.bind(v),
            Col::Time(v) => query.bind(v),
            Col::Big(v) => query.bind(v),
            Col::OptBig(v) => query.bind(v),
            Col::Bool(v) => query.bind(v),
            Col::Json(v) => query.bind(v),
        };
    }
    Ok(query.execute(conn).await?.rows_affected())
}

/// Строка события для `an_events`.
pub struct EventRow {
    pub at: DateTime<Utc>,
    pub day: NaiveDate,
    pub sid: Option<String>,
    pub person: Option<i64>,
    pub name: &'static str,
    pub room: Option<String>,
    pub props: Value,
}

/// Столбцы-счётчики строки «человек × день» — в порядке `DayDelta::v`.
pub const DAY_COLUMNS: [&str; 15] = [
    "sessions", "joins", "talk_s", "together_s", "cinema_s", "music_s", "game_s", "board_s", "mic_s", "cam_s",
    "screen_s", "errors", "error_sessions", "vpn_sessions", "invites",
];

/// Прибавка к строке «человек × день».
#[derive(Default, Clone)]
pub struct DayDelta {
    pub v: [i64; 15],
    pub confirmed: bool,
}

impl DayDelta {
    /// Прибавить к столбцу по имени. Имя — из `DAY_COLUMNS`; чужое имя — ошибка в коде, а не в данных.
    pub fn add(&mut self, column: &str, by: i64) {
        if let Some(index) = DAY_COLUMNS.iter().position(|c| *c == column) {
            self.v[index] += by;
        } else {
            debug_assert!(false, "нет столбца {column}");
        }
    }
}

/// Прибавка к группе ошибок.
pub struct ErrorDelta {
    pub code: String,
    pub scope: String,
    pub version: String,
    pub source: &'static str,
    pub cause: &'static str,
    pub first_at: DateTime<Utc>,
    pub last_at: DateTime<Utc>,
    pub count: i64,
    pub sessions: i64,
    pub sample: Value,
}

/// Срезы ошибки за день: клиент, система, браузер, версия, узел.
#[derive(Default, Clone, PartialEq, Eq, Hash)]
pub struct ErrorDims {
    pub client: String,
    pub os: String,
    pub browser: String,
    pub version: String,
    pub node: String,
}

/// Ключ суточного трафика.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct TrafficKey {
    pub day: NaiveDate,
    pub class: &'static str,
    pub bot: &'static str,
    pub client: &'static str,
    pub os: &'static str,
    pub country: String,
    pub net: &'static str,
}

/// Что изменилось у строки сессии.
pub struct SessionUpdate {
    pub last_at: DateTime<Utc>,
    pub human: &'static str,
    pub reason: &'static str,
    pub step: i16,
    pub errors: i32,
}

/// Всё, что накоплено с прошлой записи.
#[derive(Default)]
pub struct Pending {
    pub events: Vec<EventRow>,
    pub traffic: HashMap<TrafficKey, i64>,
    pub days: HashMap<(i64, NaiveDate), DayDelta>,
    /// Человек → последний день, когда его видели.
    pub seen: HashMap<i64, NaiveDate>,
    /// Человек → день, когда он соединился с медиаузлом.
    pub called: HashMap<i64, NaiveDate>,
    /// Человек → момент, когда он пробыл во встрече не один минуту.
    pub peers: HashMap<i64, DateTime<Utc>>,
    pub counts: HashMap<(NaiveDate, &'static str, String, String), i64>,
    pub errors: HashMap<String, ErrorDelta>,
    pub error_days: HashMap<(String, NaiveDate, ErrorDims), (i64, i64)>,
    pub error_people: HashMap<(String, NaiveDate, i64), i64>,
    /// (день, вид, площадка, человек) → секунды, застои, мс застоев.
    pub integration_days: HashMap<(NaiveDate, String, String, i64), [i64; 3]>,
    pub sessions: HashMap<String, SessionUpdate>,
    pub fact_ids: Vec<(String, DateTime<Utc>)>,
    /// Сколько строк событий выброшено из-за переполнения памяти.
    pub lost_events: u64,
}

impl Pending {
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
            && self.traffic.is_empty()
            && self.days.is_empty()
            && self.seen.is_empty()
            && self.called.is_empty()
            && self.counts.is_empty()
            && self.errors.is_empty()
            && self.integration_days.is_empty()
            && self.sessions.is_empty()
            && self.fact_ids.is_empty()
    }

    pub fn event(&mut self, row: EventRow) {
        if self.events.len() >= MAX_EVENT_ROWS {
            self.events.remove(0);
            self.lost_events += 1;
        }
        self.events.push(row);
    }

    pub fn traffic(&mut self, key: TrafficKey, by: i64) {
        *self.traffic.entry(key).or_default() += by;
    }

    /// Строка «человек × день»: сам факт обращения к ней значит, что человек в этот день был.
    pub fn day(&mut self, person: i64, day: NaiveDate) -> &mut DayDelta {
        let seen = self.seen.entry(person).or_insert(day);
        *seen = (*seen).max(day);
        self.days.entry((person, day)).or_default()
    }

    pub fn count(&mut self, day: NaiveDate, metric: &'static str, a: &str, b: &str, by: i64) {
        *self.counts.entry((day, metric, a.to_owned(), b.to_owned())).or_default() += by;
    }

    /// Записать накопленное в открытую транзакцию.
    pub async fn write(&self, conn: &mut PgConnection, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        self.write_events(conn).await?;
        self.write_days(conn, now).await?;
        self.write_errors(conn).await?;
        self.write_rest(conn).await
    }

    async fn write_events(&self, conn: &mut PgConnection) -> Result<(), sqlx::Error> {
        let e = &self.events;
        let columns = [
            ("at", Col::Time(e.iter().map(|r| r.at).collect())),
            ("day", Col::Date(e.iter().map(|r| r.day).collect())),
            ("sid", Col::OptText(e.iter().map(|r| r.sid.clone()).collect())),
            ("person_id", Col::OptBig(e.iter().map(|r| r.person).collect())),
            ("name", Col::Text(e.iter().map(|r| r.name.to_owned()).collect())),
            ("room", Col::OptText(e.iter().map(|r| r.room.clone()).collect())),
            ("props", Col::Json(e.iter().map(|r| r.props.clone()).collect())),
        ];
        write(conn, "an_events", &columns, Conflict::None).await?;
        Ok(())
    }

    async fn write_days(&self, conn: &mut PgConnection, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        let rows: Vec<_> = self.days.iter().collect();
        let mut columns = vec![
            ("person_id", Col::Big(rows.iter().map(|((p, _), _)| *p).collect())),
            ("day", Col::Date(rows.iter().map(|((_, d), _)| *d).collect())),
            ("confirmed", Col::Bool(rows.iter().map(|(_, delta)| delta.confirmed).collect())),
        ];
        for (index, name) in DAY_COLUMNS.iter().enumerate() {
            columns.push((name, Col::Big(rows.iter().map(|(_, delta)| delta.v[index]).collect())));
        }
        let set = format!(
            "confirmed = an_person_days.confirmed OR EXCLUDED.confirmed, {}",
            sum("an_person_days", &DAY_COLUMNS)
        );
        write(conn, "an_person_days", &columns, Conflict::Update(&["person_id", "day"], set)).await?;

        let people: Vec<i64> = self.seen.keys().copied().collect();
        let last: Vec<NaiveDate> = self.seen.values().copied().collect();
        sqlx::query(
            "UPDATE an_persons p SET last_day = GREATEST(p.last_day, v.day) \
             FROM UNNEST($1::bigint[], $2::date[]) AS v(id, day) WHERE p.id = v.id",
        )
        .bind(&people)
        .bind(&last)
        .execute(&mut *conn)
        .await?;
        let callers: Vec<i64> = self.called.keys().copied().collect();
        let days: Vec<NaiveDate> = self.called.values().copied().collect();
        sqlx::query(
            "UPDATE an_persons p SET first_call_day = LEAST(COALESCE(p.first_call_day, v.day), v.day) \
             FROM UNNEST($1::bigint[], $2::date[]) AS v(id, day) WHERE p.id = v.id",
        )
        .bind(&callers)
        .bind(&days)
        .execute(&mut *conn)
        .await?;
        // Стал собеседником: был во встрече не один дольше минуты. Момент известен, когда минута набралась за
        // одно присутствие; набралась по кускам — моментом считается эта запись.
        let peers: Vec<i64> = self.peers.keys().copied().collect();
        let since: Vec<DateTime<Utc>> = self.peers.values().copied().collect();
        sqlx::query(
            "UPDATE an_persons p SET first_peer_at = v.at FROM UNNEST($1::bigint[], $2::timestamptz[]) AS v(id, at) \
             WHERE p.id = v.id AND p.first_peer_at IS NULL",
        )
        .bind(&peers)
        .bind(&since)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "UPDATE an_persons p SET first_peer_at = $2 WHERE p.id = ANY($1) AND p.first_peer_at IS NULL \
             AND EXISTS (SELECT 1 FROM an_person_days d WHERE d.person_id = p.id AND d.with_peer)",
        )
        .bind(&people)
        .bind(now)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    async fn write_errors(&self, conn: &mut PgConnection) -> Result<(), sqlx::Error> {
        let groups: Vec<_> = self.errors.iter().collect();
        let text = |f: fn(&ErrorDelta) -> String| Col::Text(groups.iter().map(|(_, g)| f(g)).collect());
        let columns = [
            ("key", Col::Text(groups.iter().map(|(key, _)| (*key).clone()).collect())),
            ("code", text(|g| g.code.clone())),
            ("scope", text(|g| g.scope.clone())),
            ("version", text(|g| g.version.clone())),
            ("source", text(|g| g.source.to_owned())),
            ("cause", text(|g| g.cause.to_owned())),
            ("first_at", Col::Time(groups.iter().map(|(_, g)| g.first_at).collect())),
            ("last_at", Col::Time(groups.iter().map(|(_, g)| g.last_at).collect())),
            ("count", Col::Big(groups.iter().map(|(_, g)| g.count).collect())),
            ("sessions", Col::Big(groups.iter().map(|(_, g)| g.sessions).collect())),
            ("sample", Col::Json(groups.iter().map(|(_, g)| g.sample.clone()).collect())),
        ];
        let set = "first_at = LEAST(an_errors.first_at, EXCLUDED.first_at), \
                   last_at = GREATEST(an_errors.last_at, EXCLUDED.last_at), cause = EXCLUDED.cause, \
                   count = an_errors.count + EXCLUDED.count, sessions = an_errors.sessions + EXCLUDED.sessions, \
                   sample = CASE WHEN EXCLUDED.last_at >= an_errors.last_at THEN EXCLUDED.sample ELSE an_errors.sample END";
        write(conn, "an_errors", &columns, Conflict::Update(&["key"], set.to_owned())).await?;

        let days: Vec<_> = self.error_days.iter().collect();
        let dim = |f: fn(&ErrorDims) -> &String| Col::Text(days.iter().map(|((_, _, dims), _)| f(dims).clone()).collect());
        let columns = [
            ("key", Col::Text(days.iter().map(|((key, _, _), _)| key.clone()).collect())),
            ("day", Col::Date(days.iter().map(|((_, day, _), _)| *day).collect())),
            ("client", dim(|d| &d.client)),
            ("os", dim(|d| &d.os)),
            ("browser", dim(|d| &d.browser)),
            ("version", dim(|d| &d.version)),
            ("node", dim(|d| &d.node)),
            ("count", Col::Big(days.iter().map(|(_, (count, _))| *count).collect())),
            ("sessions", Col::Big(days.iter().map(|(_, (_, sessions))| *sessions).collect())),
        ];
        let key = ["key", "day", "client", "os", "browser", "version", "node"];
        write(conn, "an_error_days", &columns, Conflict::Update(&key, sum("an_error_days", &["count", "sessions"]))).await?;

        let people: Vec<_> = self.error_people.iter().collect();
        let columns = [
            ("key", Col::Text(people.iter().map(|((key, _, _), _)| key.clone()).collect())),
            ("day", Col::Date(people.iter().map(|((_, day, _), _)| *day).collect())),
            ("person_id", Col::Big(people.iter().map(|((_, _, person), _)| *person).collect())),
            ("count", Col::Big(people.iter().map(|(_, count)| **count).collect())),
        ];
        let key = ["key", "day", "person_id"];
        write(conn, "an_error_people", &columns, Conflict::Update(&key, sum("an_error_people", &["count"]))).await?;
        // «Сколько людей» у группы — разные люди за всё время: пересчитывается у тронутых групп.
        let mut touched: Vec<String> = self.errors.keys().cloned().collect();
        touched.extend(self.error_people.keys().map(|(key, _, _)| key.clone()));
        sqlx::query(
            "UPDATE an_errors e SET persons = (SELECT count(DISTINCT person_id) FROM an_error_people p WHERE p.key = e.key) \
             WHERE e.key = ANY($1)",
        )
        .bind(&touched)
        .execute(&mut *conn)
        .await?;
        Ok(())
    }

    async fn write_rest(&self, conn: &mut PgConnection) -> Result<(), sqlx::Error> {
        let traffic: Vec<_> = self.traffic.iter().filter(|(_, by)| **by != 0).collect();
        let word = |f: fn(&TrafficKey) -> &str| Col::Text(traffic.iter().map(|(key, _)| f(key).to_owned()).collect());
        let columns = [
            ("day", Col::Date(traffic.iter().map(|(key, _)| key.day).collect())),
            ("class", word(|k| k.class)),
            ("bot", word(|k| k.bot)),
            ("client", word(|k| k.client)),
            ("os", word(|k| k.os)),
            ("country", word(|k| &k.country)),
            ("net", word(|k| k.net)),
            ("visits", Col::Big(traffic.iter().map(|(_, by)| **by).collect())),
        ];
        let key = ["day", "class", "bot", "client", "os", "country", "net"];
        write(conn, "an_traffic_days", &columns, Conflict::Update(&key, sum("an_traffic_days", &["visits"]))).await?;

        let counts: Vec<_> = self.counts.iter().collect();
        let columns = [
            ("day", Col::Date(counts.iter().map(|((day, ..), _)| *day).collect())),
            ("metric", Col::Text(counts.iter().map(|((_, metric, ..), _)| (*metric).to_owned()).collect())),
            ("a", Col::Text(counts.iter().map(|((_, _, a, _), _)| a.clone()).collect())),
            ("b", Col::Text(counts.iter().map(|((_, _, _, b), _)| b.clone()).collect())),
            ("n", Col::Big(counts.iter().map(|(_, n)| **n).collect())),
        ];
        write(conn, "an_counts", &columns, Conflict::Update(&["day", "metric", "a", "b"], sum("an_counts", &["n"]))).await?;

        let views: Vec<_> = self.integration_days.iter().collect();
        let columns = [
            ("day", Col::Date(views.iter().map(|((day, ..), _)| *day).collect())),
            ("kind", Col::Text(views.iter().map(|((_, kind, ..), _)| kind.clone()).collect())),
            ("variant", Col::Text(views.iter().map(|((_, _, variant, _), _)| variant.clone()).collect())),
            ("person_id", Col::Big(views.iter().map(|((.., person), _)| *person).collect())),
            ("seconds", Col::Big(views.iter().map(|(_, v)| v[0]).collect())),
            ("stalls", Col::Big(views.iter().map(|(_, v)| v[1]).collect())),
            ("stall_ms", Col::Big(views.iter().map(|(_, v)| v[2]).collect())),
        ];
        let key = ["day", "kind", "variant", "person_id"];
        let set = sum("an_integration_days", &["seconds", "stalls", "stall_ms"]);
        write(conn, "an_integration_days", &columns, Conflict::Update(&key, set)).await?;

        let sessions: Vec<_> = self.sessions.iter().collect();
        sqlx::query(
            "UPDATE an_sessions s SET last_at = GREATEST(s.last_at, v.last_at), human = v.human, reason = v.reason, \
             step = GREATEST(s.step, v.step), errors = GREATEST(s.errors, v.errors) \
             FROM UNNEST($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::smallint[], $6::int[]) \
               AS v(sid, last_at, human, reason, step, errors) WHERE s.sid = v.sid",
        )
        .bind(sessions.iter().map(|(sid, _)| (*sid).clone()).collect::<Vec<_>>())
        .bind(sessions.iter().map(|(_, s)| s.last_at).collect::<Vec<_>>())
        .bind(sessions.iter().map(|(_, s)| s.human.to_owned()).collect::<Vec<_>>())
        .bind(sessions.iter().map(|(_, s)| s.reason.to_owned()).collect::<Vec<_>>())
        .bind(sessions.iter().map(|(_, s)| s.step).collect::<Vec<_>>())
        .bind(sessions.iter().map(|(_, s)| s.errors).collect::<Vec<_>>())
        .execute(&mut *conn)
        .await?;

        let columns = [
            ("id", Col::Text(self.fact_ids.iter().map(|(id, _)| id.clone()).collect())),
            ("at", Col::Time(self.fact_ids.iter().map(|(_, at)| *at).collect())),
        ];
        write(conn, "an_fact_ids", &columns, Conflict::Skip(&["id"])).await?;
        Ok(())
    }
}
