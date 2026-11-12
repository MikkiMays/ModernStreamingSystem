//! Запросы отчётов. Каждый возвращает одно значение JSON: форму ответа собирает PostgreSQL, служба только
//! складывает части. Формы описаны в `contracts/insight-reports.md`.
//!
//! Параметры у всех запросов одни: `$1` — строгий счёт, `$2` и `$3` — первый и последний день периода,
//! `$4` — вид «Когорты», `$5` — горизонт (последний день периода, а у когорт — сегодня). Дополнительные —
//! с `$6`, у каждого запроса свои.

/// Общее начало: человек отчёта, его дни и человеко-дни, попавшие в отчёт.
///
/// - `m` — строка человека → человек отчёта: в обычном счёте узнанные по отпечатку считаются одним
///   человеком (`merged_into`), в строгом каждый сам по себе;
/// - `people` — человек отчёта: первый день, первый звонок, когда стал собеседником;
/// - `days` — человек × день;
/// - `life` — дни людей отчёта до горизонта: у вида «За период» — все люди, у «Когорт» — пришедшие в период;
/// - `scope` — то же, но не раньше начала периода.
pub const BASE: &str = "
WITH m AS (
  SELECT id, CASE WHEN $1 THEN id ELSE COALESCE(merged_into, id) END AS pid FROM an_persons
),
people AS (
  SELECT m.pid, min(p.first_day) AS first_day, min(p.first_at) AS first_at,
         min(p.first_call_day) AS first_call_day, min(p.first_peer_at) AS first_peer_at
  FROM an_persons p JOIN m USING (id) GROUP BY m.pid
),
days AS (
  SELECT m.pid, d.day, sum(d.sessions) AS sessions, sum(d.joins) AS joins, sum(d.talk_s) AS talk_s,
         sum(d.together_s) AS together_s, sum(d.together_s) >= 60 AS with_peer, bool_or(d.confirmed) AS confirmed,
         sum(d.cinema_s) AS cinema_s, sum(d.music_s) AS music_s, sum(d.game_s) AS game_s, sum(d.board_s) AS board_s,
         sum(d.mic_s) AS mic_s, sum(d.cam_s) AS cam_s, sum(d.screen_s) AS screen_s, sum(d.errors) AS errors,
         sum(d.error_sessions) AS error_sessions, sum(d.vpn_sessions) AS vpn_sessions, sum(d.invites) AS invites
  FROM an_person_days d JOIN m ON m.id = d.person_id GROUP BY m.pid, d.day
),
life AS (
  SELECT d.*, p.first_day FROM days d JOIN people p USING (pid)
  WHERE d.day <= $5 AND (NOT $4 OR p.first_day BETWEEN $2 AND $3)
),
scope AS (SELECT * FROM life WHERE day >= $2),
calendar AS (SELECT generate_series($2::date, $5::date, '1 day')::date AS day)";

/// Сессии людей отчёта в его днях (сессии хранятся 90 дней).
const SESSIONS: &str = "
sess AS (
  SELECT s.*, m.pid FROM an_sessions s JOIN m ON m.id = s.person_id JOIN people p ON p.pid = m.pid
  WHERE s.day BETWEEN $2 AND $5 AND (NOT $4 OR p.first_day BETWEEN $2 AND $3)
)";

/// Пришедшие в период — с тем, откуда они пришли впервые, и стали ли собеседниками. У вида «За период»
/// собеседник — за 7 дней от первого дня и в пределах периода, у «Когорт» — когда-либо.
const FRESH: &str = "
fresh AS (
  SELECT p.*, r.landing, r.source, r.utm_source, r.utm_medium, r.utm_campaign, r.client, r.os, r.country,
         EXISTS (SELECT 1 FROM scope s WHERE s.pid = p.pid AND s.with_peer AND ($4 OR s.day <= p.first_day + 7)) AS talked
  FROM people p JOIN an_persons r ON r.id = p.pid WHERE p.first_day BETWEEN $2 AND $3
)";

/// Доля: `a / b`, четыре знака; деление на ноль — `null`.
fn ratio(a: &str, b: &str) -> String {
    format!("round(({a})::numeric / NULLIF(({b})::numeric, 0), 4)")
}

/// Секунды в часы, два знака.
fn hours(seconds: &str) -> String {
    format!("round(COALESCE(({seconds}), 0)::numeric / 3600, 2)")
}

/// Список строк JSON из подзапроса с готовым порядком.
fn list(row: &str, from: &str) -> String {
    format!("(SELECT COALESCE(json_agg({row}), '[]'::json) FROM ({from}) t)")
}

/// Разрез суточного счётчика `an_counts` за дни отчёта: `[{<a>, <b>?, count}]`.
fn counts(metric: &str, a: &str, b: Option<&str>) -> String {
    let (fields, group, order) = match b {
        Some(b) => (
            format!("'{a}', a, '{b}', b, 'count', n"),
            "a, b",
            "n DESC, a, b",
        ),
        None => (format!("'{a}', a, 'count', n"), "a", "n DESC, a"),
    };
    list(
        &format!("json_build_object({fields})"),
        &format!(
            "SELECT {group}, sum(n) AS n FROM an_counts WHERE metric = '{metric}' AND day BETWEEN $2 AND $5 \
             GROUP BY {group} ORDER BY {order}"
        ),
    )
}

/// Числа плиток пульса за период.
pub fn pulse_numbers() -> String {
    let share = ratio(
        "(SELECT count(*) FROM active WHERE peer)",
        "(SELECT count(*) FROM active)",
    );
    let success = ratio("ok", "ok + failed");
    let clean = ratio("sum(sessions) - sum(error_sessions)", "sum(sessions)");
    let vpn = ratio("sum(vpn_sessions)", "sum(sessions)");
    let sticky = ratio("count(*)::numeric / 30", "count(DISTINCT pid)");
    let talk = hours("SELECT sum(talk_s) FROM active");
    format!(
        "{BASE},
active AS (
  SELECT pid, min(first_day) AS first_day, bool_or(with_peer) AS peer, bool_or(confirmed) AS confirmed,
         sum(talk_s) AS talk_s, sum(sessions) AS sessions, sum(error_sessions) AS error_sessions,
         sum(vpn_sessions) AS vpn_sessions
  FROM scope GROUP BY pid
),
gaps AS (SELECT pid, day, lag(day) OVER (PARTITION BY pid ORDER BY day) AS prev FROM life),
joins AS (
  SELECT COALESCE(sum(n) FILTER (WHERE metric = 'join'), 0) AS ok,
         COALESCE(sum(n) FILTER (WHERE metric = 'join_fail'), 0) AS failed
  FROM an_counts WHERE day BETWEEN $2 AND $5 AND metric IN ('join', 'join_fail')
)
SELECT json_build_object(
  'people', (SELECT count(*) FROM active),
  'new_people', (SELECT count(*) FROM active WHERE first_day >= $2),
  'returning', (SELECT count(*) FROM active WHERE first_day < $2),
  'resurrected', (SELECT count(DISTINCT pid) FROM gaps WHERE day >= $2 AND day - prev > 14),
  'interlocutors', (SELECT count(*) FROM active WHERE peer),
  'weekly_interlocutors', (SELECT count(DISTINCT pid) FROM life WHERE with_peer AND day > $5 - 7),
  'interlocutor_share', {share},
  'confirmed', (SELECT count(*) FROM active WHERE confirmed),
  'engaged_only', (SELECT count(*) FROM active WHERE NOT confirmed),
  'talk_hours', {talk},
  'join_success', (SELECT {success} FROM joins),
  'join_p50_ms', (
    SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.props->>'ms')::numeric))
    FROM an_events e JOIN m ON m.id = e.person_id JOIN active a ON a.pid = m.pid
    WHERE e.name = 'join_timing' AND e.day BETWEEN $2 AND $5 AND e.props ? 'ms'),
  'error_free_sessions', (SELECT {clean} FROM active),
  'vpn_share', (SELECT {vpn} FROM active),
  'stickiness', (SELECT {sticky} FROM life WHERE day > $5 - 30)
)"
    )
}

/// Ряды пульса по дням.
pub fn pulse_series() -> String {
    let talk = hours("d.talk_s");
    format!(
        "{BASE},
daily AS (
  SELECT day, count(*) AS people, count(*) FILTER (WHERE first_day = day) AS new_people,
         count(*) FILTER (WHERE with_peer) AS interlocutors, sum(talk_s) AS talk_s
  FROM scope GROUP BY day
),
weekly AS (
  SELECT c.day, count(DISTINCT l.pid) AS n FROM calendar c
  JOIN life l ON l.day BETWEEN c.day - 6 AND c.day AND l.with_peer GROUP BY c.day
)
SELECT COALESCE(json_agg(json_build_object(
  'day', c.day, 'people', COALESCE(d.people, 0), 'new_people', COALESCE(d.new_people, 0),
  'interlocutors', COALESCE(d.interlocutors, 0), 'talk_hours', {talk},
  'weekly_interlocutors', COALESCE(w.n, 0)) ORDER BY c.day), '[]'::json)
FROM calendar c LEFT JOIN daily d USING (day) LEFT JOIN weekly w USING (day)"
    )
}

/// Разрез сессий по столбцу: `[{key, people, sessions}]`.
fn session_breakdown(column: &str) -> String {
    list(
        "json_build_object('key', k, 'people', people, 'sessions', sessions)",
        &format!(
            "SELECT {column} AS k, count(DISTINCT pid) AS people, count(*) AS sessions FROM sess \
             GROUP BY 1 ORDER BY 2 DESC, 3 DESC, 1 LIMIT 50"
        ),
    )
}

/// Сколько дней из последних семи человек был активен: `[{active_days, people}]`.
fn frequency() -> String {
    list(
        "json_build_object('active_days', k, 'people', people)",
        "SELECT k, count(f.pid) AS people FROM generate_series(1, 7) k \
         LEFT JOIN (SELECT pid, count(*) AS n FROM life WHERE day > $5 - 7 GROUP BY pid) f ON f.n = k \
         GROUP BY k ORDER BY k",
    )
}

pub fn audience() -> String {
    let per_person = ratio("sum(sessions)", "count(DISTINCT pid)");
    let vpn = ratio("sum(vpn_sessions)", "sum(sessions)");
    let sticky = ratio("count(*)::numeric / 30", "count(DISTINCT pid)");
    let day_sticky = ratio("r.dau", "r.mau");
    let frequency = frequency();
    let by = |column: &str| session_breakdown(column);
    let (client, os, browser, device, country, network) = (
        by("client"),
        by("os"),
        by("browser"),
        by("class"),
        by("country"),
        by("net"),
    );
    format!(
        "{BASE},{SESSIONS},
active AS (SELECT pid, min(first_day) AS first_day, bool_or(confirmed) AS confirmed FROM scope GROUP BY pid),
gaps AS (SELECT pid, day, lag(day) OVER (PARTITION BY pid ORDER BY day) AS prev FROM life),
roll AS (
  SELECT c.day, count(DISTINCT l.pid) FILTER (WHERE l.day = c.day) AS dau,
         count(DISTINCT l.pid) FILTER (WHERE l.day > c.day - 7) AS wau, count(DISTINCT l.pid) AS mau
  FROM calendar c LEFT JOIN life l ON l.day BETWEEN c.day - 29 AND c.day GROUP BY c.day
),
daily AS (
  SELECT day, count(*) FILTER (WHERE first_day = day) AS new_people,
         count(*) FILTER (WHERE first_day < day) AS returning
  FROM scope GROUP BY day
),
risen AS (SELECT day, count(*) AS n FROM gaps WHERE day >= $2 AND day - prev > 14 GROUP BY day)
SELECT json_build_object(
  'totals', json_build_object(
    'people', (SELECT count(*) FROM active),
    'new_people', (SELECT count(*) FROM active WHERE first_day >= $2),
    'returning', (SELECT count(*) FROM active WHERE first_day < $2),
    'resurrected', (SELECT count(DISTINCT pid) FROM gaps WHERE day >= $2 AND day - prev > 14),
    'recognised_by_fingerprint', (
      SELECT count(*) FROM an_persons WHERE merged_into IS NOT NULL AND first_day BETWEEN $2 AND $3),
    'confirmed', (SELECT count(*) FROM active WHERE confirmed),
    'engaged_only', (SELECT count(*) FROM active WHERE NOT confirmed),
    'sessions', (SELECT COALESCE(sum(sessions), 0) FROM scope),
    'sessions_per_person', (SELECT {per_person} FROM scope),
    'vpn_sessions', (SELECT COALESCE(sum(vpn_sessions), 0) FROM scope),
    'vpn_share', (SELECT {vpn} FROM scope),
    'stickiness', (SELECT {sticky} FROM life WHERE day > $5 - 30)),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', r.day, 'dau', r.dau, 'wau', r.wau, 'mau', r.mau, 'new_people', COALESCE(d.new_people, 0),
      'returning', COALESCE(d.returning, 0), 'resurrected', COALESCE(z.n, 0), 'stickiness', {day_sticky})
      ORDER BY r.day), '[]'::json)
    FROM roll r LEFT JOIN daily d USING (day) LEFT JOIN risen z USING (day)),
  'frequency', {frequency},
  'recognised', (
    SELECT json_build_object(
      'cookie', count(*) FILTER (WHERE via = 'cookie'), 'profile', count(*) FILTER (WHERE via = 'profile'),
      'fingerprint', count(*) FILTER (WHERE via = 'fingerprint'), 'new', count(*) FILTER (WHERE via = 'new'))
    FROM sess),
  'by_client', {client}, 'by_os', {os}, 'by_browser', {browser}, 'by_device', {device},
  'by_country', {country}, 'by_network', {network}
)"
    )
}

/// Разрез пришедших по выражению: `[{key, new_people, interlocutors, share}]`.
fn source_breakdown(key: &str, filter: &str) -> String {
    let share = ratio("count(*) FILTER (WHERE talked)", "count(*)");
    list(
        "json_build_object('key', k, 'new_people', new_people, 'interlocutors', interlocutors, 'share', share)",
        &format!(
            "SELECT {key} AS k, count(*) AS new_people, count(*) FILTER (WHERE talked) AS interlocutors, \
             {share} AS share FROM fresh WHERE {filter} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50"
        ),
    )
}

pub fn acquisition() -> String {
    let invite_share = ratio("count(*) FILTER (WHERE landing = 'invite')", "count(*)");
    let k = ratio(
        "(SELECT count(*) FROM fresh WHERE landing = 'invite' AND talked)",
        "(SELECT count(DISTINCT pid) FROM days WHERE day BETWEEN $2 AND $3 AND with_peer)",
    );
    let by = |key: &str| source_breakdown(key, "true");
    let (landing, source, client, os, country) = (
        by("landing"),
        by("source"),
        by("client"),
        by("os"),
        by("country"),
    );
    let campaign = source_breakdown(
        "concat_ws(' / ', NULLIF(utm_source, ''), NULLIF(utm_medium, ''), NULLIF(utm_campaign, ''))",
        "utm_source <> '' OR utm_medium <> '' OR utm_campaign <> ''",
    );
    let invites = counts("invite", "how", None);
    format!(
        "{BASE},{FRESH}
SELECT json_build_object(
  'totals', (
    SELECT json_build_object(
      'new_people', count(*), 'by_invite', count(*) FILTER (WHERE landing = 'invite'),
      'invite_share', {invite_share}, 'interlocutors', count(*) FILTER (WHERE talked),
      'invites_sent', (SELECT COALESCE(sum(invites), 0) FROM days WHERE day BETWEEN $2 AND $3),
      'inviters', (SELECT count(DISTINCT pid) FROM days WHERE day BETWEEN $2 AND $3 AND invites > 0),
      'k_factor', {k})
    FROM fresh),
  'by_landing', {landing}, 'by_source', {source}, 'by_campaign', {campaign},
  'by_client', {client}, 'by_os', {os}, 'by_country', {country},
  'invites', {invites},
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'new_people', COALESCE(f.n, 0), 'by_invite', COALESCE(f.invited, 0)) ORDER BY c.day), '[]'::json)
    FROM (SELECT * FROM calendar WHERE day <= $3) c
    LEFT JOIN (SELECT first_day AS day, count(*) AS n, count(*) FILTER (WHERE landing = 'invite') AS invited
               FROM fresh GROUP BY 1) f USING (day))
)"
    )
}

/// Активация. `$6` — конец горизонта моментом времени.
pub fn activation() -> String {
    let share_day = ratio(
        "count(*) FILTER (WHERE first_at + interval '24 hours' <= $6 AND peer_at < first_at + interval '24 hours')",
        "count(*) FILTER (WHERE first_at + interval '24 hours' <= $6)",
    );
    let share_week = ratio(
        "count(*) FILTER (WHERE first_at + interval '7 days' <= $6 AND peer_at < first_at + interval '7 days')",
        "count(*) FILTER (WHERE first_at + interval '7 days' <= $6)",
    );
    let step_share = ratio("count(f.pid) FILTER (WHERE f.step >= s.k)", "count(f.pid)");
    let permissions = counts("permission", "device", Some("result"));
    format!(
        "{BASE},
fresh AS (
  SELECT p.pid, p.first_day, p.first_at, CASE WHEN p.first_peer_at < $6::timestamptz THEN p.first_peer_at END AS peer_at,
         COALESCE((SELECT max(s.step) FROM an_sessions s JOIN m ON m.id = s.person_id
                   WHERE m.pid = p.pid AND s.day BETWEEN $2 AND $5), 2) AS step
  FROM people p WHERE p.first_day BETWEEN $2 AND $3
),
steps(k, name) AS (VALUES (1, 'open'), (2, 'engaged'), (3, 'prejoin'), (4, 'permission'), (5, 'join'), (6, 'media'), (7, 'talk')),
waits(k, bucket, lo, hi) AS (VALUES
  (1, '10m', interval '0', interval '10 minutes'), (2, '1h', interval '10 minutes', interval '1 hour'),
  (3, '24h', interval '1 hour', interval '24 hours'), (4, '7d', interval '24 hours', interval '7 days'),
  (5, 'later', interval '7 days', interval '100 years'))
SELECT json_build_object(
  'new_people', (SELECT count(*) FROM fresh),
  'activated_24h', (SELECT count(*) FROM fresh WHERE peer_at < first_at + interval '24 hours'),
  'activated_7d', (SELECT count(*) FROM fresh WHERE peer_at < first_at + interval '7 days'),
  'mature_24h', (SELECT count(*) FROM fresh WHERE first_at + interval '24 hours' <= $6),
  'mature_7d', (SELECT count(*) FROM fresh WHERE first_at + interval '7 days' <= $6),
  'share_24h', (SELECT {share_day} FROM fresh),
  'share_7d', (SELECT {share_week} FROM fresh),
  'funnel', (
    SELECT json_agg(json_build_object('step', name, 'people', people, 'share', share) ORDER BY k)
    FROM (SELECT s.k, s.name, count(f.pid) FILTER (WHERE f.step >= s.k) AS people, {step_share} AS share
          FROM steps s LEFT JOIN fresh f ON true GROUP BY s.k, s.name) t),
  'time_to_talk', (
    SELECT json_agg(json_build_object('bucket', bucket, 'people', people) ORDER BY k)
    FROM (SELECT w.k, w.bucket, count(f.pid) AS people FROM waits w
          LEFT JOIN fresh f ON f.peer_at - f.first_at >= w.lo AND f.peer_at - f.first_at < w.hi
          GROUP BY w.k, w.bucket
          UNION ALL SELECT 6, 'never', count(*) FROM fresh WHERE peer_at IS NULL) t),
  'permissions', {permissions},
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'new_people', COALESCE(f.n, 0), 'activated_24h', COALESCE(f.day1, 0),
      'activated_7d', COALESCE(f.day7, 0)) ORDER BY c.day), '[]'::json)
    FROM (SELECT * FROM calendar WHERE day <= $3) c
    LEFT JOIN (SELECT first_day AS day, count(*) AS n,
                      count(*) FILTER (WHERE peer_at < first_at + interval '24 hours') AS day1,
                      count(*) FILTER (WHERE peer_at < first_at + interval '7 days') AS day7
               FROM fresh GROUP BY 1) f USING (day))
)"
    )
}

/// Удержание за N дней: `{eligible, returned, share, talked, talked_share}`.
fn retained(n: u32) -> String {
    let ripe = format!("first_day + {n} <= $5");
    let share = ratio(
        &format!("count(*) FILTER (WHERE {ripe} AND r{n})"),
        &format!("count(*) FILTER (WHERE {ripe})"),
    );
    let talked = ratio(
        &format!("count(*) FILTER (WHERE {ripe} AND t{n})"),
        &format!("count(*) FILTER (WHERE {ripe})"),
    );
    format!(
        "json_build_object('eligible', count(*) FILTER (WHERE {ripe}), \
         'returned', count(*) FILTER (WHERE {ripe} AND r{n}), 'share', {share}, \
         'talked', count(*) FILTER (WHERE {ripe} AND t{n}), 'talked_share', {talked})"
    )
}

/// Удержание. `$6` — шаг когорт (`day`, `week`, `month`), `$7` — первый день прошлого периода той же длины.
pub fn retention() -> String {
    let (d1, d7, d30) = (retained(1), retained(7), retained(30));
    let curve_share = ratio("active", "eligible");
    let curve_talked = ratio("talked", "eligible");
    let kept = ratio("count(*) FILTER (WHERE stayed)", "count(*)");
    format!(
        "{BASE},
fresh AS (SELECT pid, first_day FROM people WHERE first_day BETWEEN $2 AND $3),
back AS (
  SELECT f.pid, d.day - f.first_day AS age, d.with_peer FROM fresh f
  JOIN days d ON d.pid = f.pid AND d.day > f.first_day AND d.day <= LEAST(f.first_day + 30, $5)
),
per AS (
  SELECT f.pid, f.first_day, date_trunc($6::text, f.first_day::timestamp)::date AS cohort,
         COALESCE(bool_or(b.age <= 1), false) AS r1, COALESCE(bool_or(b.age <= 7), false) AS r7,
         COALESCE(bool_or(b.age <= 30), false) AS r30,
         COALESCE(bool_or(b.age <= 1 AND b.with_peer), false) AS t1,
         COALESCE(bool_or(b.age <= 7 AND b.with_peer), false) AS t7,
         COALESCE(bool_or(b.age <= 30 AND b.with_peer), false) AS t30
  FROM fresh f LEFT JOIN back b USING (pid) GROUP BY f.pid, f.first_day
),
before AS (
  SELECT d.pid, EXISTS (SELECT 1 FROM days x WHERE x.pid = d.pid AND x.day BETWEEN $2 AND $3) AS stayed
  FROM days d WHERE d.day >= $7::date AND d.day < $2 GROUP BY d.pid
)
SELECT json_build_object(
  'bucket', $6::text,
  'total', (SELECT json_build_object('size', count(*), 'd1', {d1}, 'd7', {d7}, 'd30', {d30}) FROM per),
  'cohorts', (
    SELECT COALESCE(json_agg(item ORDER BY cohort), '[]'::json)
    FROM (SELECT cohort, json_build_object('cohort', cohort, 'size', count(*), 'd1', {d1}, 'd7', {d7}, 'd30', {d30}) AS item
          FROM per GROUP BY cohort) t),
  'curve', (
    SELECT json_agg(json_build_object('age', age, 'eligible', eligible, 'active', active, 'share', {curve_share},
                                      'talked', talked, 'talked_share', {curve_talked}) ORDER BY age)
    FROM (SELECT k AS age,
                 (SELECT count(*) FROM fresh WHERE first_day + k <= $5) AS eligible,
                 CASE WHEN k = 0 THEN (SELECT count(*) FROM fresh WHERE first_day <= $5)
                      ELSE (SELECT count(DISTINCT pid) FROM back WHERE age = k) END AS active,
                 CASE WHEN k = 0 THEN (SELECT count(*) FROM fresh f JOIN days d ON d.pid = f.pid AND d.day = f.first_day
                                       WHERE d.with_peer AND f.first_day <= $5)
                      ELSE (SELECT count(DISTINCT pid) FROM back WHERE age = k AND with_peer) END AS talked
          FROM generate_series(0, 30) k) t),
  'carried', (
    SELECT json_build_object('previous_people', count(*), 'stayed', count(*) FILTER (WHERE stayed), 'share', {kept})
    FROM before)
)"
    )
}

pub fn engagement() -> String {
    let per_person = ratio("sum(sessions)", "count(DISTINCT pid)");
    let per_day = ratio(
        "sum(talk_s) FILTER (WHERE with_peer)",
        "60 * count(*) FILTER (WHERE with_peer)",
    );
    let daily_minutes = ratio("d.peer_s", "60 * d.interlocutors");
    let frequency = frequency();
    let h = |column: &str| hours(&format!("sum({column})"));
    let (talk, together, mic, cam, screen) = (
        h("talk_s"),
        h("together_s"),
        h("mic_s"),
        h("cam_s"),
        h("screen_s"),
    );
    let (cinema, music, game, board) = (h("cinema_s"), h("music_s"), h("game_s"), h("board_s"));
    let daily_talk = hours("d.talk_s");
    let person_hours = hours("sum(person_s)");
    let features = list(
        "json_build_object('name', a, 'count', uses, 'sessions', sessions)",
        "SELECT a, sum(n) FILTER (WHERE metric = 'feature') AS uses, \
                COALESCE(sum(n) FILTER (WHERE metric = 'feature_sessions'), 0) AS sessions \
         FROM an_counts WHERE metric IN ('feature', 'feature_sessions') AND day BETWEEN $2 AND $5 \
         GROUP BY a ORDER BY 2 DESC NULLS LAST, 1",
    );
    let screens = counts("screen", "name", None);
    let left = counts("leave", "reason", None);
    let dropped = counts("media_down", "reason", None);
    format!(
        "{BASE},
met AS (
  SELECT *, EXTRACT(epoch FROM closed_at - opened_at) / 60 AS minutes FROM an_meetings WHERE day BETWEEN $2 AND $5
),
sizes(k, bucket, lo, hi) AS (VALUES (1, '1', 0, 1), (2, '2', 2, 2), (3, '3-5', 3, 5), (4, '6-10', 6, 10), (5, '11+', 11, 100000)),
lengths(k, bucket, lo, hi) AS (VALUES (1, '<1m', 0, 1), (2, '1-5m', 1, 5), (3, '5-15m', 5, 15), (4, '15-60m', 15, 60),
                                        (5, '1-3h', 60, 180), (6, '3h+', 180, 100000000)),
daily AS (
  SELECT day, sum(talk_s) AS talk_s, count(*) FILTER (WHERE with_peer) AS interlocutors,
         sum(talk_s) FILTER (WHERE with_peer) AS peer_s
  FROM scope GROUP BY day
)
SELECT json_build_object(
  'totals', (
    SELECT json_build_object(
      'people', count(DISTINCT pid), 'interlocutors', count(DISTINCT pid) FILTER (WHERE with_peer),
      'talk_hours', {talk}, 'together_hours', {together}, 'minutes_per_interlocutor_day', {per_day},
      'sessions', COALESCE(sum(sessions), 0), 'sessions_per_person', {per_person},
      'joins', COALESCE(sum(joins), 0),
      'mic_hours', {mic}, 'cam_hours', {cam}, 'screen_hours', {screen},
      'integration_hours', json_build_object('cinema', {cinema}, 'music', {music}, 'game', {game}, 'board', {board}))
    FROM scope),
  'meetings', (
    SELECT json_build_object(
      'count', count(*), 'with_peers', count(*) FILTER (WHERE peak >= 2),
      'median_minutes', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1),
      'p90_minutes', round((percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes))::numeric, 1),
      'peak_avg', round(avg(peak), 2), 'person_hours', {person_hours})
    FROM met),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'talk_hours', {daily_talk}, 'interlocutors', COALESCE(d.interlocutors, 0),
      'minutes_per_interlocutor', {daily_minutes},
      'meetings', (SELECT count(*) FROM met WHERE met.day = c.day)) ORDER BY c.day), '[]'::json)
    FROM calendar c LEFT JOIN daily d USING (day)),
  'frequency', {frequency},
  'meeting_sizes', (
    SELECT json_agg(json_build_object('bucket', bucket, 'meetings', n) ORDER BY k)
    FROM (SELECT z.k, z.bucket, count(met.id) AS n FROM sizes z LEFT JOIN met ON met.peak BETWEEN z.lo AND z.hi
          GROUP BY z.k, z.bucket) t),
  'meeting_lengths', (
    SELECT json_agg(json_build_object('bucket', bucket, 'meetings', n) ORDER BY k)
    FROM (SELECT z.k, z.bucket, count(met.id) AS n FROM lengths z
          LEFT JOIN met ON met.minutes >= z.lo AND met.minutes < z.hi GROUP BY z.k, z.bucket) t),
  'features', {features},
  'screens', {screens},
  'leave_reasons', {left},
  'drop_reasons', {dropped}
)"
    )
}

/// Строка интеграции: запуски из `an_integration_runs`, зрители из `an_integration_days`.
fn integration_row(keys: &str) -> String {
    let watch = hours("v.seconds");
    let stream = hours("r.stream_s");
    let share = ratio(
        "r.meetings",
        "(SELECT count(*) FROM an_meetings WHERE day BETWEEN $2 AND $5)",
    );
    let rate = ratio("r.bytes * 3600", "r.stream_s");
    format!(
        "json_build_object({keys} 'runs', COALESCE(r.runs, 0), 'people', COALESCE(v.people, 0), \
         'meetings', COALESCE(r.meetings, 0), 'meeting_share', {share}, 'watch_hours', {watch}, \
         'avg_minutes', r.avg_minutes, 'median_minutes', r.median_minutes, 'peak_avg', r.peak_avg, \
         'bytes', COALESCE(r.bytes, 0), 'stream_hours', {stream}, 'bytes_per_hour', round({rate}), \
         'errors', COALESCE(r.errors, 0), 'stalls', COALESCE(v.stalls, 0), \
         'stall_seconds', round(COALESCE(v.stall_ms, 0) / 1000.0))"
    )
}

/// Сводки запусков и зрителей по ключу группировки (пусто — всё вместе).
fn integration_sides(group: &str) -> (String, String) {
    let (select, by) = if group.is_empty() {
        (String::new(), String::new())
    } else {
        (format!("{group}, "), format!(" GROUP BY {group}"))
    };
    (
        format!(
            "SELECT {select}count(*) AS runs, count(DISTINCT meeting_id) AS meetings, sum(bytes) AS bytes, \
             sum(stream_s) AS stream_s, sum(errors) AS errors, round(avg(peak), 2) AS peak_avg, \
             round(avg(minutes)::numeric, 1) AS avg_minutes, \
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1) AS median_minutes \
             FROM runs{by}"
        ),
        format!(
            "SELECT {select}count(DISTINCT pid) AS people, sum(seconds) AS seconds, sum(stalls) AS stalls, \
             sum(stall_ms) AS stall_ms FROM views{by}"
        ),
    )
}

pub fn integrations() -> String {
    let (all_runs, all_views) = integration_sides("");
    let (kind_runs, kind_views) = integration_sides("kind");
    let (variant_runs, variant_views) = integration_sides("kind, variant");
    let total = integration_row("");
    let by_kind = integration_row("'kind', kind,");
    let by_variant = integration_row("'kind', kind, 'variant', variant,");
    let watch = hours("v.seconds");
    let errors = list(
        "json_build_object('kind', split_part(a, '/', 1), 'variant', split_part(a, '/', 2), 'code', b, 'count', n)",
        "SELECT a, b, sum(n) AS n FROM an_counts WHERE metric = 'integration_error' AND day BETWEEN $2 AND $5 \
         GROUP BY a, b ORDER BY 3 DESC, 1, 2",
    );
    format!(
        "{BASE},
runs AS (
  SELECT r.*, EXTRACT(epoch FROM r.closed_at - r.opened_at) / 60 AS minutes,
         (SELECT mt.id FROM an_meetings mt WHERE mt.room = r.room AND mt.opened_at <= r.opened_at
          ORDER BY mt.opened_at DESC LIMIT 1) AS meeting_id
  FROM an_integration_runs r WHERE r.day BETWEEN $2 AND $5
),
views AS (
  SELECT v.day, v.kind, v.variant, m.pid, v.seconds, v.stalls, v.stall_ms
  FROM an_integration_days v JOIN m ON m.id = v.person_id JOIN people p ON p.pid = m.pid
  WHERE v.day BETWEEN $2 AND $5 AND (NOT $4 OR p.first_day BETWEEN $2 AND $3)
)
SELECT json_build_object(
  'totals', (SELECT {total} FROM ({all_runs}) r, ({all_views}) v),
  'by_kind', (
    SELECT COALESCE(json_agg({by_kind} ORDER BY COALESCE(r.runs, 0) DESC, kind), '[]'::json)
    FROM ({kind_runs}) r FULL JOIN ({kind_views}) v USING (kind)),
  'by_variant', (
    SELECT COALESCE(json_agg({by_variant} ORDER BY COALESCE(r.runs, 0) DESC, kind, variant), '[]'::json)
    FROM ({variant_runs}) r FULL JOIN ({variant_views}) v USING (kind, variant)),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'cinema', COALESCE(r.cinema, 0), 'music', COALESCE(r.music, 0), 'game', COALESCE(r.game, 0),
      'board', COALESCE(r.board, 0), 'watch_hours', {watch}) ORDER BY c.day), '[]'::json)
    FROM calendar c
    LEFT JOIN (SELECT day, count(*) FILTER (WHERE kind = 'cinema') AS cinema, count(*) FILTER (WHERE kind = 'music') AS music,
                      count(*) FILTER (WHERE kind = 'game') AS game, count(*) FILTER (WHERE kind = 'board') AS board
               FROM runs GROUP BY day) r USING (day)
    LEFT JOIN (SELECT day, sum(seconds) AS seconds FROM views GROUP BY day) v USING (day)),
  'errors', {errors},
  'close_reasons', (
    SELECT COALESCE(json_agg(json_build_object('kind', kind, 'reason', close_reason, 'runs', n) ORDER BY n DESC, kind, close_reason), '[]'::json)
    FROM (SELECT kind, close_reason, count(*) AS n FROM runs WHERE closed_at IS NOT NULL GROUP BY 1, 2) t)
)"
    )
}

pub fn quality() -> String {
    let success = ratio("ok", "ok + failed");
    let clean = ratio("sum(sessions) - sum(error_sessions)", "sum(sessions)");
    let vpn = ratio("sum(vpn_sessions)", "sum(sessions)");
    let fail_share = ratio("n", "sum(n) OVER ()");
    let loss = ratio("sum(loss_sum)", "sum(summaries)");
    let relay = ratio("sum(relay)", "sum(summaries)");
    let freezes = ratio("sum(freezes) * 3600", "sum(person_s)");
    let reconnects = ratio("sum(reconnects) * 3600", "sum(person_s)");
    let net_vpn = ratio("count(*) FILTER (WHERE vpn)", "count(*)");
    let net_clean = ratio("count(*) FILTER (WHERE errors = 0)", "count(*)");
    let day_success = ratio("j.ok", "j.ok + j.failed");
    let day_clean = ratio("d.sessions - d.error_sessions", "d.sessions");
    let day_vpn = ratio("d.vpn_sessions", "d.sessions");
    let person_hours = hours("sum(person_s)");
    let how = counts("join", "how", None);
    let drops = counts("media_down", "reason", None);
    let refusals = counts("refusal", "code", None);
    let media = |extra: &str| {
        format!(
            "json_build_object({extra} 'meetings', count(*), 'person_hours', {person_hours}, 'summaries', COALESCE(sum(summaries), 0), \
             'loss_avg', {loss}, 'rtt_avg_ms', round((sum(rtt_sum) / NULLIF(sum(summaries), 0))::numeric, 1), \
             'relay_share', {relay}, 'freezes', COALESCE(sum(freezes), 0), 'freezes_per_hour', {freezes}, \
             'reconnects', COALESCE(sum(reconnects), 0), 'reconnects_per_hour', {reconnects}, \
             'node_moves', COALESCE(sum(moves), 0))"
        )
    };
    let (media_total, media_node) = (media(""), media("'node', node,"));
    let percentile = |p: &str, field: &str| {
        format!(
            "round(percentile_cont({p}) WITHIN GROUP (ORDER BY (props->>'{field}')::numeric) FILTER (WHERE props ? '{field}'))"
        )
    };
    let timing = |extra: &str| {
        format!(
            "json_build_object({extra} 'samples', count(*), 'p50_ms', {}, 'p95_ms', {}, 'signal_p50_ms', {}, 'media_p50_ms', {})",
            percentile("0.5", "ms"),
            percentile("0.95", "ms"),
            percentile("0.5", "signal_ms"),
            percentile("0.5", "media_ms")
        )
    };
    let (timing_total, timing_node) = (timing(""), timing("'node', node,"));
    format!(
        "{BASE},{SESSIONS},
joins AS (
  SELECT COALESCE(sum(n) FILTER (WHERE metric = 'join'), 0) AS ok,
         COALESCE(sum(n) FILTER (WHERE metric = 'join_fail'), 0) AS failed
  FROM an_counts WHERE day BETWEEN $2 AND $5 AND metric IN ('join', 'join_fail')
),
timings AS (
  SELECT e.props, COALESCE(e.props->>'node', '') AS node FROM an_events e JOIN m ON m.id = e.person_id
  JOIN people p ON p.pid = m.pid
  WHERE e.name = 'join_timing' AND e.day BETWEEN $2 AND $5 AND e.props ? 'ms'
    AND (NOT $4 OR p.first_day BETWEEN $2 AND $3)
),
met AS (SELECT * FROM an_meetings WHERE day BETWEEN $2 AND $5),
day_joins AS (
  SELECT day, COALESCE(sum(n) FILTER (WHERE metric = 'join'), 0) AS ok,
         COALESCE(sum(n) FILTER (WHERE metric = 'join_fail'), 0) AS failed
  FROM an_counts WHERE day BETWEEN $2 AND $5 AND metric IN ('join', 'join_fail') GROUP BY day
),
day_sessions AS (
  SELECT day, sum(sessions) AS sessions, sum(error_sessions) AS error_sessions, sum(vpn_sessions) AS vpn_sessions
  FROM scope GROUP BY day
)
SELECT json_build_object(
  'join', (
    SELECT json_build_object(
      'attempts', ok + failed, 'joined', ok, 'failed', failed, 'success', {success},
      'by_how', {how},
      'by_node', (SELECT COALESCE(json_agg(json_build_object('node', b, 'joined', n) ORDER BY n DESC, b), '[]'::json)
                  FROM (SELECT b, sum(n) AS n FROM an_counts WHERE metric = 'join' AND day BETWEEN $2 AND $5 GROUP BY b) t),
      'failures', (SELECT COALESCE(json_agg(json_build_object('code', a, 'count', n, 'share', share) ORDER BY n DESC, a), '[]'::json)
                   FROM (SELECT a, n, {fail_share} AS share
                         FROM (SELECT a, sum(n) AS n FROM an_counts WHERE metric = 'join_fail' AND day BETWEEN $2 AND $5 GROUP BY a) f) t))
    FROM joins),
  'join_time', (
    SELECT json_build_object(
      'total', (SELECT {timing_total} FROM timings),
      'by_node', (SELECT COALESCE(json_agg(item ORDER BY node), '[]'::json)
                  FROM (SELECT node, {timing_node} AS item FROM timings GROUP BY node) t))),
  'sessions', (
    SELECT json_build_object(
      'total', COALESCE(sum(sessions), 0), 'without_errors', COALESCE(sum(sessions) - sum(error_sessions), 0),
      'error_free_share', {clean}, 'vpn', COALESCE(sum(vpn_sessions), 0), 'vpn_share', {vpn})
    FROM scope),
  'media', (
    SELECT json_build_object(
      'total', (SELECT {media_total} FROM met),
      'by_node', (SELECT COALESCE(json_agg(item ORDER BY node), '[]'::json)
                  FROM (SELECT node, {media_node} AS item FROM met GROUP BY node) t))),
  'drops', {drops},
  'refusals', {refusals},
  'networks', (
    SELECT COALESCE(json_agg(json_build_object('net', net, 'sessions', sessions, 'people', people,
                                               'vpn_share', vpn_share, 'error_free_share', clean) ORDER BY sessions DESC, net), '[]'::json)
    FROM (SELECT net, count(*) AS sessions, count(DISTINCT pid) AS people, {net_vpn} AS vpn_share, {net_clean} AS clean
          FROM sess GROUP BY net) t),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'joined', COALESCE(j.ok, 0), 'failed', COALESCE(j.failed, 0), 'success', {day_success},
      'error_free_share', {day_clean}, 'vpn_share', {day_vpn}) ORDER BY c.day), '[]'::json)
    FROM calendar c LEFT JOIN day_joins j USING (day) LEFT JOIN day_sessions d USING (day))
)"
    )
}

/// Общие части отчётов об ошибках: ошибки по дням и затронутые люди отчёта.
const ERRORS: &str = "
hits AS (SELECT * FROM an_error_days WHERE day BETWEEN $2 AND $5),
hurt AS (
  SELECT e.key, e.day, m.pid FROM an_error_people e JOIN m ON m.id = e.person_id JOIN people p ON p.pid = m.pid
  WHERE e.day BETWEEN $2 AND $5 AND (NOT $4 OR p.first_day BETWEEN $2 AND $3)
),
base AS (
  SELECT (SELECT COALESCE(sum(sessions), 0) FROM scope) AS sessions, (SELECT count(DISTINCT pid) FROM scope) AS people
)";

pub fn errors() -> String {
    let session_share = ratio("sum(h.sessions)", "(SELECT sessions FROM base)");
    let people_share = ratio(
        "(SELECT count(DISTINCT pid) FROM hurt)",
        "(SELECT people FROM base)",
    );
    let group_sessions = ratio("g.sessions", "(SELECT sessions FROM base)");
    let group_people = ratio("g.people", "(SELECT people FROM base)");
    format!(
        "{BASE},{ERRORS},
groups AS (
  SELECT e.key, e.code, e.scope, e.version, e.source, e.cause, e.first_at, e.last_at,
         h.events, h.sessions, COALESCE(u.people, 0) AS people,
         NOT EXISTS (SELECT 1 FROM an_error_days x WHERE x.key = e.key AND x.day < $2) AS is_new
  FROM (SELECT key, sum(count) AS events, sum(sessions) AS sessions FROM hits GROUP BY key) h
  JOIN an_errors e USING (key)
  LEFT JOIN (SELECT key, count(DISTINCT pid) AS people FROM hurt GROUP BY key) u USING (key)
)
SELECT json_build_object(
  'totals', (
    SELECT json_build_object(
      'events', COALESCE(sum(h.count), 0), 'groups', count(DISTINCT h.key),
      'new_groups', (SELECT count(*) FROM groups WHERE is_new),
      'sessions_affected', COALESCE(sum(h.sessions), 0), 'sessions_share', {session_share},
      'people_affected', (SELECT count(DISTINCT pid) FROM hurt), 'people_share', {people_share})
    FROM hits h),
  'by_cause', (
    SELECT COALESCE(json_agg(json_build_object('cause', cause, 'events', events, 'groups', groups, 'sessions', sessions,
                                               'people', people) ORDER BY events DESC, cause), '[]'::json)
    FROM (SELECT g.cause, sum(g.events) AS events, count(*) AS groups, sum(g.sessions) AS sessions,
                 (SELECT count(DISTINCT u.pid) FROM hurt u JOIN an_errors e ON e.key = u.key WHERE e.cause = g.cause) AS people
          FROM groups g GROUP BY g.cause) t),
  'groups', (
    SELECT COALESCE(json_agg(item ORDER BY events DESC, key), '[]'::json)
    FROM (SELECT g.events, g.key, json_build_object(
                   'key', g.key, 'code', g.code, 'scope', g.scope, 'version', g.version, 'source', g.source,
                   'cause', g.cause, 'events', g.events, 'sessions', g.sessions, 'people', g.people,
                   'sessions_share', {group_sessions}, 'people_share', {group_people},
                   'first_at', g.first_at, 'last_at', g.last_at, 'is_new', g.is_new) AS item
          FROM groups g ORDER BY g.events DESC, g.key LIMIT 200) t),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'events', COALESCE(h.events, 0), 'sessions', COALESCE(h.sessions, 0),
      'people', COALESCE(u.people, 0)) ORDER BY c.day), '[]'::json)
    FROM calendar c
    LEFT JOIN (SELECT day, sum(count) AS events, sum(sessions) AS sessions FROM hits GROUP BY day) h USING (day)
    LEFT JOIN (SELECT day, count(DISTINCT pid) AS people FROM hurt GROUP BY day) u USING (day))
)"
    )
}

/// Разрез одной группы ошибок по столбцу `an_error_days`.
fn error_breakdown(column: &str) -> String {
    list(
        "json_build_object('key', k, 'events', events, 'sessions', sessions)",
        &format!(
            "SELECT {column} AS k, sum(count) AS events, sum(sessions) AS sessions FROM mine \
             GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50"
        ),
    )
}

/// Одна группа ошибок. `$6` — её ключ. Нет группы — `null`.
pub fn error_detail() -> String {
    let session_share = ratio("COALESCE(sum(sessions), 0)", "(SELECT sessions FROM base)");
    let people_share = ratio(
        "(SELECT count(DISTINCT pid) FROM hurt WHERE key = $6)",
        "(SELECT people FROM base)",
    );
    let by = |column: &str| error_breakdown(column);
    let (versions, os, browsers, clients, nodes) = (
        by("version"),
        by("os"),
        by("browser"),
        by("client"),
        by("node"),
    );
    format!(
        "{BASE},{ERRORS},
mine AS (SELECT * FROM hits WHERE key = $6),
seen AS (
  SELECT e.at, e.sid, e.props FROM an_events e
  WHERE e.name IN ('error', 'join_fail') AND e.day BETWEEN $2 AND $5 AND e.props->>'key' = $6
)
SELECT (
  SELECT json_build_object(
    'group', json_build_object(
      'key', g.key, 'code', g.code, 'scope', g.scope, 'version', g.version, 'source', g.source, 'cause', g.cause,
      'first_at', g.first_at, 'last_at', g.last_at, 'events_total', g.count, 'sessions_total', g.sessions,
      'people_total', g.persons),
    'period', (
      SELECT json_build_object(
        'events', COALESCE(sum(count), 0), 'sessions', COALESCE(sum(sessions), 0),
        'people', (SELECT count(DISTINCT pid) FROM hurt WHERE key = $6),
        'sessions_share', {session_share}, 'people_share', {people_share})
      FROM mine),
    'series', (
      SELECT COALESCE(json_agg(json_build_object(
        'day', c.day, 'events', COALESCE(h.events, 0), 'sessions', COALESCE(h.sessions, 0),
        'people', COALESCE(u.people, 0)) ORDER BY c.day), '[]'::json)
      FROM calendar c
      LEFT JOIN (SELECT day, sum(count) AS events, sum(sessions) AS sessions FROM mine GROUP BY day) h USING (day)
      LEFT JOIN (SELECT day, count(DISTINCT pid) AS people FROM hurt WHERE key = $6 GROUP BY day) u USING (day)),
    'versions', {versions}, 'os', {os}, 'browsers', {browsers}, 'clients', {clients}, 'nodes', {nodes},
    'steps', (
      SELECT COALESCE(json_agg(json_build_object('step', step, 'events', n) ORDER BY step), '[]'::json)
      FROM (SELECT (props->>'step')::int AS step, count(*) AS n FROM seen WHERE props ? 'step' GROUP BY 1) t),
    'samples', (
      SELECT COALESCE(json_agg(item ORDER BY at DESC), '[]'::json)
      FROM (SELECT x.at, json_build_object(
                     'at', x.at, 'screen', x.props->>'screen', 'fatal', COALESCE((x.props->>'fatal')::boolean, false),
                     'detail', x.props->>'detail', 'step', (x.props->>'step')::int, 'how', x.props->>'how',
                     'client', s.client, 'version', s.version, 'os', s.os, 'browser', s.browser) AS item
            FROM seen x LEFT JOIN an_sessions s ON s.sid = x.sid ORDER BY x.at DESC LIMIT 20) t))
  FROM an_errors g WHERE g.key = $6
)"
    )
}

/// Разрез трафика по столбцу: заходы каждого класса.
fn traffic_breakdown(column: &str) -> String {
    list(
        "json_build_object('key', k, 'human', human, 'unclear', unclear, 'bot', bot, 'automation', automation, 'own', own)",
        &format!(
            "SELECT {column} AS k, {TRAFFIC_CLASSES}, sum(visits) AS total FROM hits GROUP BY 1 \
             HAVING sum(visits) <> 0 ORDER BY total DESC, 1 LIMIT 50"
        ),
    )
}

const TRAFFIC_CLASSES: &str = "COALESCE(sum(visits) FILTER (WHERE class = 'human'), 0) AS human, \
     COALESCE(sum(visits) FILTER (WHERE class = 'unclear'), 0) AS unclear, \
     COALESCE(sum(visits) FILTER (WHERE class = 'bot'), 0) AS bot, \
     COALESCE(sum(visits) FILTER (WHERE class = 'automation'), 0) AS automation, \
     COALESCE(sum(visits) FILTER (WHERE class = 'own'), 0) AS own";

pub fn traffic() -> String {
    let human_share = ratio("human", "human + unclear + bot + automation + own");
    let class_share = ratio("visits", "sum(visits) OVER ()");
    let by = |column: &str| traffic_breakdown(column);
    let (client, os, country, network) = (by("client"), by("os"), by("country"), by("net"));
    format!(
        "{BASE},
hits AS (SELECT * FROM an_traffic_days WHERE day BETWEEN $2 AND $5)
SELECT json_build_object(
  'totals', (
    SELECT json_build_object('visits', human + unclear + bot + automation + own, 'human', human, 'unclear', unclear,
                             'bot', bot, 'automation', automation, 'own', own, 'human_share', {human_share})
    FROM (SELECT {TRAFFIC_CLASSES} FROM hits) t),
  'by_class', (
    SELECT COALESCE(json_agg(json_build_object('class', class, 'visits', visits, 'share', share) ORDER BY visits DESC, class), '[]'::json)
    FROM (SELECT class, visits, {class_share} AS share
          FROM (SELECT class, sum(visits) AS visits FROM hits GROUP BY class HAVING sum(visits) <> 0) c) t),
  'bots', (
    SELECT COALESCE(json_agg(json_build_object('bot', bot, 'visits', visits) ORDER BY visits DESC, bot), '[]'::json)
    FROM (SELECT bot, sum(visits) AS visits FROM hits WHERE class = 'bot' GROUP BY bot
          HAVING sum(visits) <> 0 ORDER BY 2 DESC, 1 LIMIT 100) t),
  'series', (
    SELECT COALESCE(json_agg(json_build_object(
      'day', c.day, 'human', COALESCE(h.human, 0), 'unclear', COALESCE(h.unclear, 0), 'bot', COALESCE(h.bot, 0),
      'automation', COALESCE(h.automation, 0), 'own', COALESCE(h.own, 0)) ORDER BY c.day), '[]'::json)
    FROM calendar c LEFT JOIN (SELECT day, {TRAFFIC_CLASSES} FROM hits GROUP BY day) h USING (day)),
  'by_client', {client}, 'by_os', {os}, 'by_country', {country}, 'by_network', {network}
)"
    )
}
