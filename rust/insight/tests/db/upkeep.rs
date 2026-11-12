//! Сроки хранения: события и сессии — 90 дней, итоги — 400, люди — 400 дней от последнего появления.

use cord_insight::config::Retention;
use cord_insight::{db, retention};
use serde_json::json;

use crate::common::*;

#[tokio::test]
async fn old_events_sessions_rollups_and_people_are_removed_on_their_own_terms() {
    let mut world = world().await;
    // Давний человек: был один раз 500 дней назад. Недавний: был 120 дней назад и вчера.
    let mut long_gone = Browser::desktop(1);
    long_gone
        .arrive(&mut world, &sid("old"), at("2025-07-01 10:00:00"))
        .await;
    let mut regular = Browser::desktop(2);
    regular
        .arrive(&mut world, &sid("r1"), at("2026-07-15 10:00:00"))
        .await;
    world
        .facts(
            at("2026-07-15 10:01:00"),
            json!([{"type": "refusal", "code": "RATE_LIMITED", "count": 1}]),
        )
        .await;
    world.engine.sweep(at("2026-07-15 12:00:00"));
    regular
        .arrive(&mut world, &sid("r2"), at("2026-11-11 10:00:00"))
        .await;
    regular
        .send(
            &mut world,
            &sid("r2"),
            at("2026-11-11 10:00:30"),
            json!([{"n": "error", "p": {"code": "TypeError", "scope": "app"}}]),
        )
        .await;
    world.flush(at("2026-11-11 10:01:00")).await;
    assert_eq!(
        world
            .number("SELECT count(*) FROM pg_inherits WHERE inhparent = 'an_events'::regclass")
            .await,
        3
    );

    let today = day("2026-11-12");
    let removed = retention::sweep(
        &world.pool,
        Retention::default(),
        today,
        at("2026-11-12 03:00:00"),
    )
    .await
    .unwrap();
    assert_eq!((removed.partitions, removed.people), (2, 1));

    // События и сессии старше 90 дней ушли: разделы июля 2025 и июля 2026 — целиком.
    assert_eq!(
        world.text("SELECT DISTINCT day::text FROM an_events").await,
        "2026-11-11"
    );
    assert_eq!(world.text("SELECT sid FROM an_sessions").await, sid("r2"));
    // Строка «человек × день» 120-дневной давности остаётся (срок — 400), 500-дневной — нет.
    assert_eq!(
        world
            .text("SELECT day::text FROM an_person_days ORDER BY day")
            .await,
        "2026-07-15\n2026-11-11"
    );
    // Давний человек ушёл вместе с устройством и профилем; недавний цел.
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_devices").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_profiles").await, 1);
    // Суточный трафик и суточные счётчики бессрочны: в них нет ничего о человеке.
    assert_eq!(
        world
            .number("SELECT count(DISTINCT day) FROM an_traffic_days")
            .await,
        3
    );
    assert_eq!(
        world
            .number("SELECT count(*) FROM an_counts WHERE metric = 'refusal'")
            .await,
        1
    );
    // Одноразовые ответы и принятые факты живут дни, а не месяцы.
    assert_eq!(world.number("SELECT count(*) FROM an_proofs").await, 0);
    assert_eq!(world.number("SELECT count(*) FROM an_fact_ids").await, 0);
    // Группа ошибок жива, пока у неё есть дни в пределах срока.
    assert_eq!(
        world.text("SELECT key FROM an_errors ORDER BY key").await,
        "RATE_LIMITED~guard~core\nTypeError~app~1.4"
    );

    // Сроки настраиваются: при неделе на события вчерашние остаются, при 30 днях на итоги июльские уходят.
    let short = Retention {
        events: 7,
        rollups: 30,
        people: 400,
    };
    retention::sweep(&world.pool, short, today, at("2026-11-12 03:00:00"))
        .await
        .unwrap();
    assert_eq!(
        world.text("SELECT day::text FROM an_person_days").await,
        "2026-11-11"
    );
    assert_eq!(
        world.text("SELECT key FROM an_errors").await,
        "TypeError~app~1.4"
    );
    assert_eq!(world.number("SELECT count(*) FROM an_events").await, 3);
}

#[tokio::test]
async fn when_the_root_of_a_fingerprint_link_expires_the_earliest_survivor_becomes_the_root() {
    let world = world().await;
    let person = |first: &'static str, last: &'static str, merged: Option<i64>| {
        let pool = world.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "INSERT INTO an_persons (merged_into, first_at, first_day, last_day) VALUES ($1, $2::date, $2::date, $3::date) RETURNING id",
            )
            .bind(merged)
            .bind(day(first))
            .bind(day(last))
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // Корень не появлялся 500 дней; двое узнанных по отпечатку появлялись недавно, третий — тоже давно.
    let root = person("2025-01-01", "2025-06-01", None).await;
    let second = person("2025-03-01", "2026-11-01", Some(root)).await;
    let third = person("2025-04-01", "2026-11-05", Some(root)).await;
    person("2025-02-01", "2025-06-10", Some(root)).await;
    let removed = retention::sweep(
        &world.pool,
        Retention::default(),
        day("2026-11-12"),
        at("2026-11-12 03:00:00"),
    )
    .await
    .unwrap();
    assert_eq!(removed.people, 2);
    assert_eq!(
        world.text("SELECT concat_ws('|', id, COALESCE(merged_into::text, 'корень')) FROM an_persons ORDER BY id").await,
        format!("{second}|корень\n{third}|{second}")
    );
}

#[tokio::test]
async fn event_partitions_are_created_ahead_and_on_demand() {
    let mut world = world().await;
    let partitions = async |world: &World| {
        world.text("SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = 'an_events'::regclass ORDER BY 1").await
    };
    assert_eq!(partitions(&world).await, "");
    // Заранее: прошлый месяц, текущий и два следующих.
    db::ensure_partitions_ahead(&world.pool, day("2026-11-12"))
        .await
        .unwrap();
    db::ensure_partitions_ahead(&world.pool, day("2026-11-13"))
        .await
        .unwrap();
    assert_eq!(
        partitions(&world).await,
        "an_events_y2026m10\nan_events_y2026m11\nan_events_y2026m12\nan_events_y2027m01"
    );
    // По требованию: событие из месяца, для которого раздела нет, заводит его при записи.
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2027-03-01 10:00:00"))
        .await;
    world.flush(at("2027-03-01 10:01:00")).await;
    assert!(partitions(&world).await.ends_with("an_events_y2027m03"));
    assert_eq!(
        world
            .number("SELECT count(*) FROM an_events_y2027m03")
            .await,
        2
    );
}
