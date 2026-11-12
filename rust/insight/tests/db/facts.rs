//! Факты ядра и служб: один раз, секунды на связи по дням, качество без строки на сводку, интеграции,
//! группы ошибок.

use chrono::Duration;
use serde_json::{Value, json};

use crate::common::*;

/// Два человека, которые проявили себя: их браузеры и псевдонимы профилей.
async fn two_people(world: &mut World, start: &str) -> (Browser, Browser, String, String) {
    let mut anna = Browser::desktop(1);
    let mut boris = Browser::desktop(2);
    anna.arrive(world, &sid("anna"), at(start)).await;
    boris.arrive(world, &sid("boris"), at(start)).await;
    let (a, b) = (anna.pseudonym(world).unwrap(), boris.pseudonym(world).unwrap());
    (anna, boris, a, b)
}

/// `секунд на связи|из них не один|собеседник дня` по дням человека с этим профилем.
async fn talk(world: &World, profile: &str) -> String {
    let sql = format!(
        "SELECT concat_ws('|', d.day, d.talk_s, d.together_s, d.with_peer) FROM an_person_days d \
         JOIN an_devices v ON v.person_id = d.person_id JOIN an_profiles p ON p.device_id = v.id \
         WHERE p.profile = '{profile}' ORDER BY d.day"
    );
    world.text(&sql).await
}

#[tokio::test]
async fn a_fact_counts_once_however_many_times_the_batch_is_repeated() {
    let mut world = world().await;
    let (_, _, anna, _) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let now = at("2026-11-12 10:01:00");
    let batch = json!([
        {"id": "f-1", "type": "join", "room": "r1", "profile": anna, "member": "m1", "how": "link", "node": "fra", "client": "web"},
        {"id": "f-2", "type": "refusal", "code": "RATE_LIMITED", "count": 3},
    ]);
    // Ядро не дождалось ответа и повторило пачку до записи; потом ещё раз — после записи и после перезапуска.
    world.facts(now, batch.clone()).await;
    world.facts(now, batch.clone()).await;
    world.flush(now).await;
    world.facts(now, batch.clone()).await;
    world.restart(now).await;
    world.facts(now, batch).await;
    world.flush(now).await;

    assert_eq!(world.text("SELECT concat_ws('|', metric, a, b, n) FROM an_counts WHERE metric IN ('join', 'refusal') ORDER BY metric").await, "join|link|fra|1\nrefusal|RATE_LIMITED||3");
    assert_eq!(world.number("SELECT sum(joins) FROM an_person_days").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_events WHERE name = 'join'").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_fact_ids").await, 2);
    assert_eq!(world.number("SELECT joins FROM an_meetings").await, 1);
    assert_eq!(world.metrics.get("insight_facts_dropped_total", &[("reason", "duplicate")]), 6.0);
}

#[tokio::test]
async fn presence_ticks_credit_the_seconds_since_the_previous_tick_or_edge() {
    let mut world = world().await;
    let (_, _, anna, boris) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let t0 = at("2026-11-12 10:10:00");
    let members = json!([{"member": "m1", "profile": anna}, {"member": "m2", "profile": boris}]);
    world.facts(t0, json!([{"type": "meeting_open", "room": "r1", "node": "fra", "profile": anna}])).await;
    world.facts(t0, json!([{"type": "media_up", "room": "r1", "member": "m1", "profile": anna, "node": "fra"}])).await;
    // Борис соединился через 20 с: до этого Анна одна.
    world.facts(t0 + Duration::seconds(20), json!([{"type": "media_up", "room": "r1", "member": "m2", "profile": boris, "node": "fra"}])).await;
    for tick in 1..=3 {
        world.facts(t0 + Duration::seconds(60 * tick), json!([{"type": "presence", "room": "r1", "node": "fra", "members": members}])).await;
    }
    // Борис вышел на 200-й секунде, Анна — на 230-й, встреча закрылась.
    world.facts(t0 + Duration::seconds(200), json!([{"type": "media_down", "room": "r1", "member": "m2", "profile": boris, "reason": "left"}])).await;
    world.facts(t0 + Duration::seconds(230), json!([{"type": "media_down", "room": "r1", "member": "m1", "profile": anna, "reason": "left"}])).await;
    world.facts(t0 + Duration::seconds(231), json!([{"type": "meeting_close", "room": "r1", "reason": "empty", "peak": 2}])).await;
    world.flush(t0 + Duration::seconds(240)).await;

    // Анна: 230 с на связи, из них не одна — с 20-й по 200-ю секунду; Борис — все свои 180 с.
    assert_eq!(talk(&world, &anna).await, "2026-11-12|230|180|t");
    assert_eq!(talk(&world, &boris).await, "2026-11-12|180|180|t");
    let meeting = world.text("SELECT concat_ws('|', node, peak, person_s, together_s, close_reason, extract(epoch FROM closed_at - opened_at)::int, creator IS NOT NULL) FROM an_meetings").await;
    assert_eq!(meeting, "fra|2|410|360|empty|231|t");
    // Одно событие присутствия на человека и встречу, а не строка на тик; псевдоним встречи — не её номер.
    assert_eq!(world.text("SELECT (props->>'seconds') FROM an_events WHERE name = 'presence' ORDER BY 1").await, "180\n230");
    assert_eq!(world.number("SELECT count(*) FROM an_events WHERE room = 'r1'").await, 0);
    assert_eq!(world.number("SELECT count(*) FROM an_persons WHERE first_peer_at IS NOT NULL").await, 2);
    assert_eq!(world.text("SELECT DISTINCT step::text FROM an_sessions").await, "7");
}

#[tokio::test]
async fn a_missed_tick_is_not_an_hour_of_talk_the_credit_is_capped_at_90_seconds() {
    let mut world = world().await;
    let (_, _, anna, _) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let t0 = at("2026-11-12 10:10:00");
    let alone = json!([{"member": "m1", "profile": anna}]);
    world.facts(t0, json!([{"type": "media_up", "room": "r1", "member": "m1", "profile": anna}])).await;
    world.facts(t0 + Duration::seconds(60), json!([{"type": "presence", "room": "r1", "members": alone}])).await;
    // Служба или ядро молчали час: следующий тик засчитывает 90 с, а не 3600.
    world.facts(t0 + Duration::seconds(3660), json!([{"type": "presence", "room": "r1", "members": alone}])).await;
    world.flush(t0 + Duration::seconds(3700)).await;
    // Одна во встрече: на связи была, собеседником не стала.
    assert_eq!(talk(&world, &anna).await, "2026-11-12|150|0|f");
    assert_eq!(world.number("SELECT count(*) FROM an_persons WHERE first_peer_at IS NOT NULL").await, 0);
}

#[tokio::test]
async fn presence_across_local_midnight_is_split_between_the_two_days() {
    let mut world = world().await;
    // 23:50 по Москве — 20:50 UTC.
    let (_, _, anna, boris) = two_people(&mut world, "2026-11-12 20:50:00").await;
    let members = json!([{"member": "m1", "profile": anna}, {"member": "m2", "profile": boris}]);
    let t0 = at("2026-11-12 20:58:30");
    world
        .facts(t0, json!([
            {"type": "media_up", "room": "r1", "member": "m1", "profile": anna},
            {"type": "media_up", "room": "r1", "member": "m2", "profile": boris},
        ]))
        .await;
    for tick in 1..=4 {
        world.facts(t0 + Duration::seconds(60 * tick), json!([{"type": "presence", "room": "r1", "members": members}])).await;
    }
    world.flush(t0 + Duration::seconds(300)).await;
    // До полуночи (21:00 UTC) — 90 с, после — 150 с; у Анны первые секунды до прихода Бориса — в одиночку.
    assert_eq!(talk(&world, &boris).await, "2026-11-12|90|90|t\n2026-11-13|150|150|t");
    assert_eq!(talk(&world, &anna).await, "2026-11-12|90|90|t\n2026-11-13|150|150|t");
    assert_eq!(world.text("SELECT last_day::text FROM an_persons LIMIT 1").await, "2026-11-13");
}

#[tokio::test]
async fn quality_summaries_add_up_in_the_meeting_and_the_person_day_without_a_row_each() {
    let mut world = world().await;
    let (_, _, anna, boris) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let t0 = at("2026-11-12 10:10:00");
    world.facts(t0, json!([{"type": "meeting_open", "room": "r1", "node": "fra", "profile": anna}])).await;
    let mut summaries = Vec::new();
    for n in 0..30 {
        let who = if n % 2 == 0 { &anna } else { &boris };
        summaries.push(json!({
            "type": "quality", "room": "r1", "profile": who, "at": (t0 + Duration::seconds(10 * n)).timestamp_millis(),
            "mic_s": 10, "cam_s": 8, "screen_s": if n < 6 { 10 } else { 0 }, "bytes_up": 1000, "bytes_down": 3000,
            "loss": 0.02, "rtt": 40, "freezes": if n == 3 { 2 } else { 0 }, "relay": n % 3 == 0, "reconnects": if n == 7 { 1 } else { 0 },
        }));
    }
    world.facts(t0 + Duration::seconds(300), Value::Array(summaries)).await;
    world.facts(t0 + Duration::seconds(301), json!([{"type": "node_move", "room": "r1", "from": "fra", "to": "hel", "reason": "drain"}])).await;
    world.flush(t0 + Duration::seconds(310)).await;

    let meeting = world.text("SELECT concat_ws('|', node, mic_s, cam_s, screen_s, bytes_up, bytes_down, summaries, relay, round(loss_sum::numeric, 2), round(rtt_sum::numeric), freezes, reconnects, moves) FROM an_meetings").await;
    assert_eq!(meeting, "hel|300|240|60|30000|90000|30|10|0.60|1200|2|1|1");
    assert_eq!(world.text("SELECT concat_ws('|', mic_s, cam_s, screen_s) FROM an_person_days ORDER BY person_id").await, "150|120|30\n150|120|30");
    assert_eq!(world.number("SELECT count(*) FROM an_events WHERE name = 'quality'").await, 0);
    assert_eq!(world.number("SELECT count(*) FROM an_meetings").await, 1);
}

#[tokio::test]
async fn usage_and_views_add_bytes_seconds_and_viewers_to_the_integration_run() {
    let mut world = world().await;
    let (mut anna_browser, mut boris_browser, anna, _) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let t0 = at("2026-11-12 10:10:00");
    world.facts(t0, json!([{"type": "integration_open", "room": "r1", "run": "run-1", "kind": "cinema", "variant": "youtube", "profile": anna}])).await;
    // Служба кинозала отчитывается раз в 30 с; зрители — раз в 30 с о том, сколько смотрели.
    for tick in 1..=4 {
        let now = t0 + Duration::seconds(30 * tick);
        world.facts_from("services", now, json!([{"type": "usage", "room": "r1", "kind": "cinema", "variant": "youtube", "bytes": 2_000_000, "seconds": 30}])).await;
        let view = json!([{"n": "integration_view", "p": {"room": "r1", "kind": "cinema", "variant": "youtube", "seconds": 30, "stalls": u8::from(tick == 2), "stall_ms": if tick == 2 { 700 } else { 0 }}}]);
        anna_browser.send(&mut world, &sid("anna"), now, view.clone()).await;
        if tick <= 2 {
            boris_browser.send(&mut world, &sid("boris"), now, view).await;
        }
    }
    world.facts_from("services", t0 + Duration::seconds(125), json!([{"type": "integration_error", "room": "r1", "run": "run-1", "kind": "cinema", "variant": "youtube", "code": "CINEMA_STREAM_FAILED"}])).await;
    world.facts(t0 + Duration::seconds(130), json!([{"type": "integration_close", "room": "r1", "run": "run-1", "reason": "error"}])).await;
    // Отчёт службы после закрытия запуска ни к чему не прибавляется.
    world.facts_from("services", t0 + Duration::seconds(150), json!([{"type": "usage", "room": "r1", "kind": "cinema", "variant": "youtube", "bytes": 5, "seconds": 30}])).await;
    world.flush(t0 + Duration::seconds(160)).await;

    let run = world.text("SELECT concat_ws('|', kind, variant, peak, person_s, bytes, stream_s, errors, stalls, stall_ms, close_reason, opener IS NOT NULL, extract(epoch FROM closed_at - opened_at)::int) FROM an_integration_runs").await;
    assert_eq!(run, "cinema|youtube|2|180|8000000|120|1|2|1400|error|t|130");
    assert_eq!(world.text("SELECT concat_ws('|', kind, variant, seconds, stalls) FROM an_integration_days ORDER BY seconds").await, "cinema|youtube|60|1\ncinema|youtube|120|1");
    assert_eq!(world.text("SELECT cinema_s::text AS seconds FROM an_person_days ORDER BY cinema_s").await, "60\n120");
    // Номер встречи в событиях заменён псевдонимом.
    assert_eq!(world.number("SELECT count(*) FROM an_events WHERE name = 'integration_view' AND room IS NOT NULL AND room <> 'r1' AND NOT props ? 'room'").await, 6);
    assert_eq!(world.text("SELECT concat_ws('|', key, cause, source, count) FROM an_errors").await, "CINEMA_STREAM_FAILED~cinema~services|platform|services|1");
    assert_eq!(world.metrics.get("insight_facts_dropped_total", &[("reason", "no_run")]), 1.0);
}

#[tokio::test]
async fn errors_are_grouped_by_code_scope_and_version_with_a_cause_and_the_people_they_touched() {
    let mut world = world().await;
    let (mut anna, mut boris, anna_profile, _) = two_people(&mut world, "2026-11-12 10:00:00").await;
    let denied = json!([{"n": "error", "p": {"code": "NotAllowedError", "scope": "device", "screen": "prejoin", "fatal": false, "detail": "Permission denied"}}]);
    let now = at("2026-11-12 10:05:00");
    // Анна увидела ошибку дважды в одной сессии, Борис — раз; версия у обоих 1.4.0.
    anna.send(&mut world, &sid("anna"), now, denied.clone()).await;
    anna.send(&mut world, &sid("anna"), now + Duration::seconds(30), denied.clone()).await;
    boris.send(&mut world, &sid("boris"), now + Duration::seconds(40), denied.clone()).await;
    // Та же ошибка у версии 1.5 — другая группа; у 1.4.1 — та же, что у 1.4.0.
    let mut newer = Browser { version: "1.5.0", ..Browser::desktop(3) };
    newer.arrive(&mut world, &sid("newer"), now).await;
    newer.send(&mut world, &sid("newer"), now + Duration::seconds(50), denied.clone()).await;
    let mut patch = Browser { version: "1.4.1", agent: SAFARI_MAC, ..Browser::desktop(4) };
    patch.arrive(&mut world, &sid("patch"), now).await;
    patch.send(&mut world, &sid("patch"), now + Duration::seconds(55), denied).await;
    // Сбой при открытии страницы: человек ещё ничего не нажал, сессия «неясно» — ошибка всё равно считается.
    let mut crashed = Browser::desktop(5);
    crashed.open(&mut world, &sid("crashed"), now).await;
    crashed.send(&mut world, &sid("crashed"), now + Duration::seconds(1), json!([{"n": "error", "p": {"code": "TypeError", "scope": "app", "fatal": true, "detail": "x is undefined"}}])).await;
    // Отказ двери от ядра — своя группа.
    world.facts(now + Duration::seconds(60), json!([{"type": "join_fail", "profile": anna_profile, "how": "link", "code": "ROOM_FULL"}])).await;
    world.flush(now + Duration::seconds(70)).await;

    let groups = world.text("SELECT concat_ws('|', key, cause, source, count, sessions, persons) FROM an_errors ORDER BY key").await;
    assert_eq!(
        groups,
        "NotAllowedError~device~1.4|permission|client|4|3|3\n\
         NotAllowedError~device~1.5|permission|client|1|1|1\n\
         ROOM_FULL~join~core|limit|core|1|0|1\n\
         TypeError~app~1.4|crash|client|1|1|0"
    );
    // Срезы по дням: система, браузер, полная версия.
    let days = world.text("SELECT concat_ws('|', os, browser, version, count, sessions) FROM an_error_days WHERE key = 'NotAllowedError~device~1.4' ORDER BY version, count").await;
    assert_eq!(days, "windows|chrome|1.4.0|3|2\nmacos|safari|1.4.1|1|1");
    assert_eq!(world.text("SELECT concat_ws('|', errors, error_sessions) FROM an_person_days ORDER BY person_id").await, "2|1\n1|1\n1|1\n1|1");
    assert_eq!(world.text("SELECT errors::text FROM an_sessions ORDER BY started_at, sid").await, "2\n1\n1\n1");
    let sample = world.text("SELECT concat_ws('|', sample->>'screen', sample->>'detail', sample->>'os', sample->>'step') FROM an_errors WHERE key = 'NotAllowedError~device~1.5'").await;
    assert_eq!(sample, "prejoin|Permission denied|windows|2");

    // Человек, который сначала увидел сбой, а потом проявил себя: ошибка не удваивается, человек появляется.
    crashed.engage(&mut world, &sid("crashed"), now + Duration::seconds(80)).await;
    world.flush(now + Duration::seconds(90)).await;
    assert_eq!(world.text("SELECT concat_ws('|', count, sessions, persons) FROM an_errors WHERE key = 'TypeError~app~1.4'").await, "1|1|1");
}
