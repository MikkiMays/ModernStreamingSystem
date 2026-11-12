//! Отчёты на маленьком наборе, посчитанном руками: определения метрик §8 проекта, оба вида, строгий счёт,
//! сравнение с прошлым периодом.

use chrono::NaiveDate;
use cord_insight::reports::{Query, ReportError, Reports};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::common::*;

/// Человек с первым днём; `merged_into` — к кому он привязан по отпечатку.
async fn person(pool: &PgPool, first_day: &str, landing: &str, merged_into: Option<i64>) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO an_persons (merged_into, first_at, first_day, last_day, landing, client, os, country) \
         VALUES ($1, $2::date + time '10:00', $2::date, $2::date, $3, 'web', 'windows', 'RU') RETURNING id",
    )
    .bind(merged_into)
    .bind(day(first_day))
    .bind(landing)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// День человека: одна сессия; `together` — секунды во встрече не одному (60 и больше — собеседник дня).
async fn active(pool: &PgPool, person: i64, on: &str, together: i32) {
    sqlx::query("INSERT INTO an_person_days (person_id, day, sessions, talk_s, together_s) VALUES ($1, $2, 1, $3, $3)")
        .bind(person)
        .bind(day(on))
        .bind(together)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE an_persons SET last_day = GREATEST(last_day, $2) WHERE id = $1")
        .bind(person)
        .bind(day(on))
        .execute(pool)
        .await
        .unwrap();
}

async fn became_interlocutor(pool: &PgPool, person: i64, when: &str) {
    sqlx::query("UPDATE an_persons SET first_peer_at = $2 WHERE id = $1")
        .bind(person)
        .bind(at(when))
        .execute(pool)
        .await
        .unwrap();
}

/// Набор, на котором проверяются определения. Первые дни — 1–3 ноября; до них — трое «старых».
///
/// ```text
/// P1  1.11  2.11 (говорил), 20.11            P5  2.11  3.11, 9.11 (говорил)
/// P2  1.11  5.11                             P6  3.11  —
/// P3  1.11  25.11 (говорил)                  P7  4.11  узнан по отпечатку как P1
/// P4  1.11  —
/// B1  25.10  3.11        B2  26.10  —        OLD  1.10  6.11 (вернулся после 35 дней тишины)
/// ```
async fn dataset() -> (PgPool, Reports) {
    let pool = fresh_pool().await;
    let p1 = person(&pool, "2026-11-01", "invite", None).await;
    for (on, together) in [("2026-11-01", 0), ("2026-11-02", 120), ("2026-11-20", 0)] {
        active(&pool, p1, on, together).await;
    }
    became_interlocutor(&pool, p1, "2026-11-02 09:00:00").await;
    let p2 = person(&pool, "2026-11-01", "home", None).await;
    for on in ["2026-11-01", "2026-11-05"] {
        active(&pool, p2, on, 0).await;
    }
    let p3 = person(&pool, "2026-11-01", "home", None).await;
    active(&pool, p3, "2026-11-01", 0).await;
    active(&pool, p3, "2026-11-25", 300).await;
    became_interlocutor(&pool, p3, "2026-11-25 12:00:00").await;
    let p4 = person(&pool, "2026-11-01", "invite", None).await;
    active(&pool, p4, "2026-11-01", 0).await;
    let p5 = person(&pool, "2026-11-02", "invite", None).await;
    for (on, together) in [("2026-11-02", 0), ("2026-11-03", 30), ("2026-11-09", 90)] {
        active(&pool, p5, on, together).await;
    }
    became_interlocutor(&pool, p5, "2026-11-09 12:00:00").await;
    let p6 = person(&pool, "2026-11-03", "home", None).await;
    active(&pool, p6, "2026-11-03", 0).await;
    let p7 = person(&pool, "2026-11-04", "home", Some(p1)).await;
    active(&pool, p7, "2026-11-04", 0).await;
    let b1 = person(&pool, "2026-10-25", "home", None).await;
    for on in ["2026-10-25", "2026-11-03"] {
        active(&pool, b1, on, 0).await;
    }
    let b2 = person(&pool, "2026-10-26", "home", None).await;
    active(&pool, b2, "2026-10-26", 0).await;
    let old = person(&pool, "2026-10-01", "home", None).await;
    for on in ["2026-10-01", "2026-11-06"] {
        active(&pool, old, on, 0).await;
    }
    let reports = Reports::new(pool.clone(), ZONE);
    (pool, reports)
}

fn query(from: &str, to: &str) -> Query {
    Query {
        from: day(from),
        to: day(to),
        cohort: false,
        strict: false,
        compare: false,
    }
}

/// «Сегодня» отчётов — 5 декабря.
async fn data(reports: &Reports, section: &str, query: Query) -> Value {
    reports
        .report(section, None, &query, at("2026-12-05 09:00:00"))
        .await
        .unwrap()["data"]
        .take()
}

fn ret(eligible: i64, returned: i64, talked: i64) -> Value {
    let share = |n: i64| {
        if eligible == 0 {
            Value::Null
        } else {
            json!((n as f64 / eligible as f64 * 10_000.0).round() / 10_000.0)
        }
    };
    json!({"eligible": eligible, "returned": returned, "share": share(returned), "talked": talked, "talked_share": share(talked)})
}

#[tokio::test]
async fn retention_is_returning_within_n_days_of_the_first_day_and_separately_returning_and_talking()
 {
    let (_pool, reports) = dataset().await;
    // «Когорты»: пришедшие 1–3 ноября и вся их дальнейшая жизнь до сегодня (5 декабря).
    let cohort = data(
        &reports,
        "retention",
        Query {
            cohort: true,
            ..query("2026-11-01", "2026-11-03")
        },
    )
    .await;
    assert_eq!(cohort["total"]["size"], 6);
    // D1 — был на следующий день: P1 (2.11) и P5 (3.11); из них говорил только P1 (у P5 3.11 — 30 секунд).
    assert_eq!(cohort["total"]["d1"], ret(6, 2, 1));
    // D7 — был в течение семи дней: P1, P2 (5.11), P5; седьмой день входит — P5 говорил ровно на седьмой.
    assert_eq!(cohort["total"]["d7"], ret(6, 3, 2));
    // D30 — в течение тридцати: ещё P3 (25.11).
    assert_eq!(cohort["total"]["d30"], ret(6, 4, 3));
    assert_eq!(cohort["bucket"], "day");
    let sizes: Vec<(String, i64)> = cohort["cohorts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["cohort"].as_str().unwrap().to_owned(),
                c["size"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        sizes,
        vec![
            ("2026-11-01".to_owned(), 4),
            ("2026-11-02".to_owned(), 1),
            ("2026-11-03".to_owned(), 1)
        ]
    );
    assert_eq!(cohort["cohorts"][0]["d7"], ret(4, 2, 1));
    assert_eq!(cohort["cohorts"][1]["d7"], ret(1, 1, 1));
    // Кривая: доля когорты, активная ровно на N-й день.
    let curve = |age: usize| {
        (
            cohort["curve"][age]["eligible"].as_i64().unwrap(),
            cohort["curve"][age]["active"].as_i64().unwrap(),
            cohort["curve"][age]["talked"].as_i64().unwrap(),
        )
    };
    assert_eq!(cohort["curve"].as_array().unwrap().len(), 31);
    assert_eq!(
        (
            curve(0),
            curve(1),
            curve(4),
            curve(7),
            curve(19),
            curve(24),
            curve(30)
        ),
        (
            (6, 6, 0),
            (6, 2, 1),
            (6, 1, 0),
            (6, 1, 1),
            (6, 1, 0),
            (6, 1, 1),
            (6, 0, 0)
        )
    );

    // «За период» 1–8 ноября: только то, что случилось в эти дни. Срок D7 к 8 ноября вышел лишь у пришедших
    // 1-го; D30 не вышел ни у кого.
    let period = data(&reports, "retention", query("2026-11-01", "2026-11-08")).await;
    assert_eq!(period["total"]["size"], 6);
    assert_eq!(period["total"]["d1"], ret(6, 2, 1));
    assert_eq!(period["total"]["d7"], ret(4, 2, 1));
    assert_eq!(period["total"]["d30"], ret(0, 0, 0));
    // Удержание период к периоду: из двоих, бывших 24–31 октября, в этот период пришёл один.
    assert_eq!(
        period["carried"],
        json!({"previous_people": 2, "stayed": 1, "share": 0.5})
    );
}

#[tokio::test]
async fn the_period_view_counts_what_happened_in_the_days_and_the_cohort_view_follows_the_newcomers()
 {
    let (_pool, reports) = dataset().await;
    let tile = |report: &Value, name: &str| report["tiles"][name]["value"].clone();

    let period = data(&reports, "pulse", query("2026-11-01", "2026-11-08")).await;
    // Были: P1–P6, B1, OLD (P7 узнан по отпечатку — он P1). Новые — шестеро, вернувшиеся — B1 и OLD,
    // воскресший — OLD (35 дней тишины; у B1 — восемь).
    assert_eq!(tile(&period, "people"), 8);
    assert_eq!(tile(&period, "new_people"), 6);
    assert_eq!(tile(&period, "returning"), 2);
    assert_eq!(tile(&period, "resurrected"), 1);
    // Собеседник — не один дольше минуты: P1 (120 с 2.11); P5 3.11 — 30 секунд, не в счёт.
    assert_eq!(tile(&period, "interlocutors"), 1);
    assert_eq!(tile(&period, "weekly_interlocutors"), 1);
    assert_eq!(tile(&period, "interlocutor_share"), 0.125);
    // Липкость: за 30 дней до 8 ноября 14 человеко-дней у 9 людей → (14 / 30) / 9.
    assert_eq!(tile(&period, "stickiness"), 0.0519);
    // Плитка несёт прошлый период той же длины (24–31 октября: B1 и B2) и изменение к нему.
    assert_eq!(
        period["tiles"]["people"],
        json!({"value": 8, "previous": 2, "change": 3.0})
    );
    let days: Vec<i64> = period["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["people"].as_i64().unwrap())
        .collect();
    assert_eq!(days, vec![4, 2, 3, 1, 1, 1, 0, 0]);
    assert_eq!(
        period["series"][0],
        json!({"day": "2026-11-01", "people": 4, "new_people": 4, "interlocutors": 0, "talk_hours": 0.0, "weekly_interlocutors": 0})
    );

    // «Когорты»: пришедшие 1–8 ноября — шестеро — и вся их жизнь до 5 декабря.
    let cohort = data(
        &reports,
        "pulse",
        Query {
            cohort: true,
            ..query("2026-11-01", "2026-11-08")
        },
    )
    .await;
    assert_eq!(tile(&cohort, "people"), 6);
    assert_eq!(tile(&cohort, "new_people"), 6);
    assert_eq!(tile(&cohort, "returning"), 0);
    // Собеседниками стали P1, P3 (25.11) и P5 (9.11) — уже после периода.
    assert_eq!(tile(&cohort, "interlocutors"), 3);
    // Воскресшие: P1 (2.11 → 20.11 — с отпечатком 4.11 → 20.11, 15 дней тишины) и P3 (1.11 → 25.11).
    assert_eq!(tile(&cohort, "resurrected"), 2);
    assert_eq!(
        cohort["series"].as_array().unwrap().len(),
        35,
        "ряд когорты идёт до сегодня"
    );
}

#[tokio::test]
async fn the_strict_switch_counts_people_recognised_by_fingerprint_separately() {
    let (_pool, reports) = dataset().await;
    let usual = data(&reports, "audience", query("2026-11-01", "2026-11-08")).await;
    let strict = data(
        &reports,
        "audience",
        Query {
            strict: true,
            ..query("2026-11-01", "2026-11-08")
        },
    )
    .await;
    assert_eq!(
        (
            usual["totals"]["people"].clone(),
            usual["totals"]["new_people"].clone()
        ),
        (json!(8), json!(6))
    );
    assert_eq!(
        (
            strict["totals"]["people"].clone(),
            strict["totals"]["new_people"].clone()
        ),
        (json!(9), json!(7))
    );
    // «Из вернувшихся — N узнаны по отпечатку» — одно число в обоих счётах.
    assert_eq!(usual["totals"]["recognised_by_fingerprint"], 1);
    assert_eq!(strict["totals"]["recognised_by_fingerprint"], 1);
    // Люди за день, неделю и месяц на 4 ноября: P7 в обычном счёте — это P1.
    let on = |report: &Value| report["series"][3].clone();
    assert_eq!(
        (
            on(&usual)["dau"].clone(),
            on(&usual)["wau"].clone(),
            on(&usual)["mau"].clone()
        ),
        (json!(1), json!(7), json!(8))
    );
    assert_eq!(
        (
            on(&strict)["dau"].clone(),
            on(&strict)["wau"].clone(),
            on(&strict)["mau"].clone()
        ),
        (json!(1), json!(8), json!(9))
    );
    // Частота: сколько дней из семи (2–8 ноября) был активен.
    let frequency: Vec<i64> = usual["frequency"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["people"].as_i64().unwrap())
        .collect();
    assert_eq!(frequency, vec![4, 2, 0, 0, 0, 0, 0]);
}

#[tokio::test]
async fn activation_is_becoming_an_interlocutor_within_24_hours_and_7_days_of_the_first_visit() {
    let (_pool, reports) = dataset().await;
    // «За период» 1–8 ноября: P1 стал собеседником через 23 часа. Срок в 7 дней к концу периода вышел у
    // четверых пришедших 1-го.
    let period = data(&reports, "activation", query("2026-11-01", "2026-11-08")).await;
    assert_eq!(period["new_people"], 6);
    assert_eq!(
        (
            period["activated_24h"].clone(),
            period["mature_24h"].clone(),
            period["share_24h"].clone()
        ),
        (json!(1), json!(6), json!(0.1667))
    );
    assert_eq!(
        (
            period["activated_7d"].clone(),
            period["mature_7d"].clone(),
            period["share_7d"].clone()
        ),
        (json!(1), json!(4), json!(0.25))
    );
    let waits = |report: &Value| -> Vec<(String, i64)> {
        report["time_to_talk"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                (
                    b["bucket"].as_str().unwrap().to_owned(),
                    b["people"].as_i64().unwrap(),
                )
            })
            .collect()
    };
    let buckets = |counts: [i64; 6]| -> Vec<(String, i64)> {
        ["10m", "1h", "24h", "7d", "later", "never"]
            .iter()
            .map(|b| (*b).to_owned())
            .zip(counts)
            .collect()
    };
    assert_eq!(waits(&period), buckets([0, 0, 1, 0, 0, 5]));
    // «Когорты»: вся дальнейшая жизнь — P5 (через 7 дней и 2 часа) и P3 (через 24 дня) стали собеседниками,
    // но не за 7 дней.
    let cohort = data(
        &reports,
        "activation",
        Query {
            cohort: true,
            ..query("2026-11-01", "2026-11-08")
        },
    )
    .await;
    assert_eq!(
        (
            cohort["activated_7d"].clone(),
            cohort["mature_7d"].clone(),
            cohort["share_7d"].clone()
        ),
        (json!(1), json!(6), json!(0.1667))
    );
    assert_eq!(waits(&cohort), buckets([0, 0, 1, 0, 2, 3]));
}

#[tokio::test]
async fn acquisition_shows_where_newcomers_came_from_and_how_invitations_grow_the_product() {
    let (pool, reports) = dataset().await;
    sqlx::query(
        "UPDATE an_person_days SET invites = 2 WHERE day = '2026-11-02' AND together_s = 120",
    )
    .execute(&pool)
    .await
    .unwrap();
    let period = data(&reports, "acquisition", query("2026-11-01", "2026-11-08")).await;
    // Трое из шести пришли по приглашению (P1, P4, P5); собеседником за 7 дней в пределах периода стал P1.
    assert_eq!(period["totals"]["new_people"], 6);
    assert_eq!(period["totals"]["by_invite"], 3);
    assert_eq!(period["totals"]["invite_share"], 0.5);
    assert_eq!(period["totals"]["interlocutors"], 1);
    assert_eq!(
        (
            period["totals"]["invites_sent"].clone(),
            period["totals"]["inviters"].clone()
        ),
        (json!(2), json!(1))
    );
    // K — новых собеседников по приглашению на одного собеседника периода: 1 / 1.
    assert_eq!(period["totals"]["k_factor"], 1.0);
    assert_eq!(
        period["by_landing"],
        json!([
            {"key": "home", "new_people": 3, "interlocutors": 0, "share": 0.0},
            {"key": "invite", "new_people": 3, "interlocutors": 1, "share": 0.3333},
        ])
    );
    // «Когорты»: собеседниками когда-либо стали P1 и P5 из приглашённых и P3 из пришедших сами.
    let cohort = data(
        &reports,
        "acquisition",
        Query {
            cohort: true,
            ..query("2026-11-01", "2026-11-08")
        },
    )
    .await;
    assert_eq!(
        cohort["by_landing"][0],
        json!({"key": "home", "new_people": 3, "interlocutors": 1, "share": 0.3333})
    );
    assert_eq!(
        cohort["by_landing"][1],
        json!({"key": "invite", "new_people": 3, "interlocutors": 2, "share": 0.6667})
    );
}

#[tokio::test]
async fn compare_attaches_the_previous_period_of_the_same_length() {
    let (_pool, reports) = dataset().await;
    let report = reports
        .report(
            "audience",
            None,
            &Query {
                compare: true,
                ..query("2026-11-01", "2026-11-08")
            },
            at("2026-12-05 09:00:00"),
        )
        .await
        .unwrap();
    assert_eq!(report["section"], "audience");
    assert_eq!(report["view"], "period");
    assert_eq!(report["strict"], false);
    assert_eq!(report["zone"], "Europe/Moscow");
    assert_eq!(
        report["range"],
        json!({"from": "2026-11-01", "to": "2026-11-08", "days": 8})
    );
    assert_eq!(
        report["previous"]["range"],
        json!({"from": "2026-10-24", "to": "2026-10-31", "days": 8})
    );
    assert_eq!(report["previous"]["data"]["totals"]["people"], 2);
    assert_eq!(report["data"]["totals"]["people"], 8);
    // Без `compare` прошлого периода в ответе нет.
    let plain = reports
        .report(
            "audience",
            None,
            &query("2026-11-01", "2026-11-08"),
            at("2026-12-05 09:00:00"),
        )
        .await
        .unwrap();
    assert!(plain.get("previous").is_none());
}

#[tokio::test]
async fn a_bad_request_is_refused_with_a_reason() {
    let (_pool, reports) = dataset().await;
    let now = at("2026-12-05 09:00:00");
    let refused = |result: Result<Value, ReportError>| result.unwrap_err().to_string();
    assert_eq!(
        refused(
            reports
                .report("nonsense", None, &query("2026-11-01", "2026-11-08"), now)
                .await
        ),
        "нет такого раздела"
    );
    assert_eq!(
        refused(
            reports
                .report(
                    "pulse",
                    Some("key"),
                    &query("2026-11-01", "2026-11-08"),
                    now
                )
                .await
        ),
        "нет такого раздела"
    );
    assert_eq!(
        refused(
            reports
                .report("pulse", None, &query("2026-11-08", "2026-11-01"), now)
                .await
        ),
        "from позже to"
    );
    assert_eq!(
        refused(
            reports
                .report("pulse", None, &query("2025-01-01", "2026-11-01"), now)
                .await
        ),
        "период длиннее 400 дней"
    );
    assert_eq!(
        refused(
            reports
                .report(
                    "errors",
                    Some("NOPE~app~1.4"),
                    &query("2026-11-01", "2026-11-08"),
                    now
                )
                .await
        ),
        "нет такой группы ошибок"
    );
    // Ровно 400 дней — можно.
    let longest = Query {
        from: NaiveDate::from_ymd_opt(2025, 10, 28).unwrap(),
        ..query("2026-11-01", "2026-12-01")
    };
    assert!(reports.report("traffic", None, &longest, now).await.is_ok());
}

#[tokio::test]
async fn every_section_answers_on_an_empty_database() {
    let reports = Reports::new(fresh_pool().await, ZONE);
    for section in cord_insight::reports::SECTIONS {
        for cohort in [false, true] {
            let query = Query {
                cohort,
                compare: true,
                ..query("2026-11-01", "2026-11-08")
            };
            let report = reports
                .report(section, None, &query, at("2026-11-10 09:00:00"))
                .await;
            let report =
                report.unwrap_or_else(|error| panic!("{section} (cohort: {cohort}): {error}"));
            assert!(report["data"].is_object(), "{section}");
            assert!(report["previous"]["data"].is_object(), "{section}");
        }
    }
}
