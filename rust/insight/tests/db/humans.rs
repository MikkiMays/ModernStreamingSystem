//! Человек или нет (§5 проекта): в таблицах людей — только люди, остальное — суточный трафик.

use chrono::Duration;
use cord_insight::classify::{Class, reason};
use cord_insight::net;
use cord_insight::proof::Solved;
use serde_json::json;

use crate::common::*;

/// Суточный трафик: `класс|робот|заходов`, без пустых строк.
async fn traffic(world: &World) -> String {
    world
        .text(
            "SELECT concat_ws('|', class, NULLIF(bot, ''), sum(visits)) FROM an_traffic_days \
             GROUP BY class, bot HAVING sum(visits) <> 0 ORDER BY class, bot",
        )
        .await
}

async fn people_rows(world: &World) -> i64 {
    world.number("SELECT (SELECT count(*) FROM an_persons) + (SELECT count(*) FROM an_devices) + (SELECT count(*) FROM an_profiles) + (SELECT count(*) FROM an_sessions) + (SELECT count(*) FROM an_events) + (SELECT count(*) FROM an_person_days)").await
}

#[tokio::test]
async fn a_visit_that_only_opened_the_page_is_unclear_and_leaves_no_person() {
    let mut world = world().await;
    let mut visitor = Browser::desktop(1);
    visitor
        .open(&mut world, &sid("v1"), at("2026-11-12 10:00:00"))
        .await;
    visitor
        .send(
            &mut world,
            &sid("v1"),
            at("2026-11-12 10:00:20"),
            json!([{"n": "screen", "p": {"name": "home"}}]),
        )
        .await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    world.flush(at("2026-11-12 11:00:00")).await;
    assert_eq!(traffic(&world).await, "unclear|1");
    assert_eq!(people_rows(&world).await, 0);
    assert_eq!(
        world
            .text("SELECT concat_ws('|', day, client, os, country, net) FROM an_traffic_days")
            .await,
        "2026-11-12|web|windows|RU|home"
    );
}

#[tokio::test]
async fn a_real_action_a_visible_page_and_a_solved_challenge_make_a_person() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.open(&mut world, &sid("a1"), at("2026-11-12 10:00:00"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("a1")),
        Some((Class::Unclear, reason::SILENT))
    );
    anna.send(
        &mut world,
        &sid("a1"),
        at("2026-11-12 10:00:02"),
        json!([{"n": "screen", "p": {"name": "home"}}]),
    )
    .await;
    anna.engage(&mut world, &sid("a1"), at("2026-11-12 10:00:05"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("a1")),
        Some((Class::Engaged, reason::ENGAGED))
    );
    anna.send(
        &mut world,
        &sid("a1"),
        at("2026-11-12 10:00:09"),
        json!([{"n": "screen", "p": {"name": "prejoin"}}]),
    )
    .await;
    world.flush(at("2026-11-12 10:00:10")).await;

    // Заход перенесён из «неясно» в «люди», а не посчитан дважды.
    assert_eq!(traffic(&world).await, "human|1");
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 1);
    // События до действия не пропали: они ждали в памяти и записаны по порядку.
    assert_eq!(
        world
            .text("SELECT name FROM an_events ORDER BY at, name")
            .await,
        "session_start\nscreen\nengaged\nscreen"
    );
    // Ни решения задачи, ни признаков отпечатка в событиях нет.
    assert_eq!(
        world
            .number("SELECT count(*) FROM an_events WHERE props ? 'proof' OR props ? 'fp'")
            .await,
        0
    );
    assert_eq!(world.text("SELECT step::text FROM an_sessions").await, "3");
}

#[tokio::test]
async fn without_a_solved_challenge_or_a_visible_page_the_action_does_not_count() {
    let mut world = world().await;
    // Задача не решена.
    let mut one = Browser::desktop(1);
    one.open(&mut world, &sid("n1"), at("2026-11-12 10:00:00"))
        .await;
    one.engage_with(&mut world, &sid("n1"), at("2026-11-12 10:00:05"), None)
        .await;
    assert_eq!(
        world.engine.session_class(&sid("n1")),
        Some((Class::Unclear, reason::SILENT))
    );
    // Страница видна меньше трёх секунд — и по часам службы, и по часам клиента.
    let mut two = Browser::desktop(2);
    two.open(&mut world, &sid("n2"), at("2026-11-12 10:00:00"))
        .await;
    two.engage(&mut world, &sid("n2"), at("2026-11-12 10:00:02"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("n2")),
        Some((Class::Unclear, reason::SILENT))
    );
    world.flush(at("2026-11-12 10:01:00")).await;
    assert_eq!(traffic(&world).await, "unclear|2");
    assert_eq!(people_rows(&world).await, 0);
    assert_eq!(
        world
            .metrics
            .get("insight_engaged_refused_total", &[("reason", "proof")]),
        1.0
    );
    assert_eq!(
        world
            .metrics
            .get("insight_engaged_refused_total", &[("reason", "early")]),
        1.0
    );
}

#[tokio::test]
async fn the_page_may_have_been_visible_by_the_client_clock_when_the_first_batch_carries_everything()
 {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    // Клиент копил события и прислал начало и действие одной пачкой: службе видна только разница их часов.
    let now = at("2026-11-12 10:00:06");
    let start = (now - Duration::seconds(6)).timestamp_millis();
    anna.send(&mut world, &sid("a1"), now, json!([{"n": "session_start", "at": start, "p": {"landing": "home", "tz": "Europe/Moscow"}}])).await;
    anna.engage(&mut world, &sid("a1"), now).await;
    assert_eq!(
        world.engine.session_class(&sid("a1")),
        Some((Class::Engaged, reason::ENGAGED))
    );
}

#[tokio::test]
async fn a_challenge_answer_works_once_even_after_a_restart() {
    let mut world = world().await;
    let proof = Solved {
        signature: "одна-подпись".into(),
        expires_ms: at("2026-11-12 10:05:00").timestamp_millis(),
    };
    let mut one = Browser::desktop(1);
    one.open(&mut world, &sid("p1"), at("2026-11-12 10:00:00"))
        .await;
    one.engage_with(
        &mut world,
        &sid("p1"),
        at("2026-11-12 10:00:05"),
        Some(proof.clone()),
    )
    .await;
    assert_eq!(
        world.engine.session_class(&sid("p1")).unwrap().0,
        Class::Engaged
    );
    world.restart(at("2026-11-12 10:00:30")).await;
    // Скрипт предъявляет тот же ответ за другую «личность».
    let mut two = Browser::desktop(2);
    two.open(&mut world, &sid("p2"), at("2026-11-12 10:01:00"))
        .await;
    two.engage_with(
        &mut world,
        &sid("p2"),
        at("2026-11-12 10:01:05"),
        Some(proof),
    )
    .await;
    assert_eq!(
        world.engine.session_class(&sid("p2")).unwrap().0,
        Class::Unclear
    );
    world.flush(at("2026-11-12 10:02:00")).await;
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 1);
    assert_eq!(
        world.metrics.get(
            "insight_engaged_refused_total",
            &[("reason", "proof_reused")]
        ),
        1.0
    );
}

#[tokio::test]
async fn robots_automation_and_our_own_probes_go_to_daily_traffic_only() {
    let mut world = world().await;
    let start = at("2026-11-12 10:00:00");
    let mut google = Browser {
        agent: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        ..Browser::desktop(1)
    };
    let mut curl = Browser {
        agent: "curl/8.5.0",
        client: None,
        ..Browser::desktop(2)
    };
    let mut headless = Browser {
        agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
        ..Browser::desktop(3)
    };
    let mut driven = Browser {
        webdriver: true,
        ..Browser::desktop(4)
    };
    let mut fake_app = Browser {
        client: Some("desktop"),
        agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        ..Browser::desktop(5)
    };
    let mut server = Browser {
        network: network("DE", 24940, net::HOSTING, "dc"),
        ..Browser::desktop(6)
    };
    server.fp["glr"] = json!(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"
    );
    let mut ours = Browser {
        probe: true,
        ..Browser::desktop(7)
    };
    let all = [
        &mut google,
        &mut curl,
        &mut headless,
        &mut driven,
        &mut fake_app,
        &mut server,
        &mut ours,
    ];
    for (n, browser) in all.into_iter().enumerate() {
        let session = sid(&format!("r{n}"));
        // Робот может прислать и «действие» с решённой задачей — человеком это его не делает.
        browser.arrive(&mut world, &session, start).await;
        browser
            .send(
                &mut world,
                &session,
                start + Duration::seconds(8),
                json!([{"n": "error", "p": {"code": "TypeError", "scope": "app"}}]),
            )
            .await;
    }
    world.flush(at("2026-11-12 10:01:00")).await;

    assert_eq!(
        traffic(&world).await,
        "automation|4\nbot|curl|1\nbot|google|1\nown|1"
    );
    assert_eq!(people_rows(&world).await, 0);
    // Ошибки роботов в группы ошибок не попадают.
    assert_eq!(world.number("SELECT count(*) FROM an_errors").await, 0);
    for (n, why) in [
        (2, reason::HEADLESS),
        (3, reason::WEBDRIVER),
        (4, reason::CLIENT_MISMATCH),
        (5, reason::SOFTWARE_GL),
    ] {
        assert_eq!(
            world.engine.session_class(&sid(&format!("r{n}"))),
            Some((Class::Automation, why))
        );
    }
    assert_eq!(
        world.engine.session_class(&sid("r6")),
        Some((Class::Own, reason::PROBE))
    );
    // Своя проверка входит в настоящую встречу (автотест звонка): ни встречи, ни входа, ни отказа в цифрах нет.
    let probe = ours.pseudonym(&world).unwrap();
    let call = json!([
        {"type": "meeting_open", "room": "probe-room", "node": "fra", "profile": probe},
        {"type": "join", "room": "probe-room", "profile": probe, "member": "m1", "how": "create", "node": "fra"},
        {"type": "media_up", "room": "probe-room", "profile": probe, "member": "m1", "node": "fra"},
        {"type": "presence", "room": "probe-room", "node": "fra", "members": [{"member": "m1", "profile": probe}]},
        {"type": "quality", "room": "probe-room", "profile": probe, "mic_s": 10, "bytes_up": 1000},
        {"type": "join_fail", "profile": probe, "how": "code", "code": "CODE_INVALID"},
        {"type": "integration_open", "room": "probe-room", "run": "probe-run", "kind": "cinema", "variant": "youtube", "profile": probe},
        {"type": "meeting_close", "room": "probe-room", "reason": "empty", "peak": 1},
    ]);
    world.facts(at("2026-11-12 10:02:00"), call).await;
    world.flush(at("2026-11-12 10:03:00")).await;
    let traces = "SELECT (SELECT count(*) FROM an_meetings) + (SELECT count(*) FROM an_integration_runs) \
                  + (SELECT count(*) FROM an_errors) + (SELECT count(*) FROM an_counts)";
    assert_eq!(world.number(traces).await, 0);
    assert_eq!(people_rows(&world).await, 0);
    // Шесть фактов названы профилем проверки; тик присутствия остался без участников, закрытие — без встречи.
    let dropped = world
        .metrics
        .get("insight_facts_dropped_total", &[("reason", "outsider")]);
    assert_eq!(dropped, 6.0);
}

#[tokio::test]
async fn joining_a_call_confirms_a_person_and_promotes_a_silent_session() {
    let mut world = world().await;
    // Анна проявила себя и позвонила: «вовлечён» → «подтверждён».
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00"))
        .await;
    // Борис вошёл по приглашению так быстро, что `engaged` ещё не пришёл: сессия «неясно».
    let mut boris = Browser::desktop(2);
    boris
        .open(&mut world, &sid("b1"), at("2026-11-12 10:00:30"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("b1")).unwrap().0,
        Class::Unclear
    );
    let (anna_profile, boris_profile) = (
        anna.pseudonym(&world).unwrap(),
        boris.pseudonym(&world).unwrap(),
    );
    world
        .facts(
            at("2026-11-12 10:01:00"),
            json!([
                {"type": "media_up", "room": "r1", "member": "m1", "profile": anna_profile, "node": "fra"},
                {"type": "media_up", "room": "r1", "member": "m2", "profile": boris_profile, "node": "fra"},
            ]),
        )
        .await;
    assert_eq!(
        world.engine.session_class(&sid("a1")),
        Some((Class::Confirmed, reason::MEDIA))
    );
    assert_eq!(
        world.engine.session_class(&sid("b1")),
        Some((Class::Confirmed, reason::MEDIA))
    );
    world.flush(at("2026-11-12 10:01:10")).await;

    assert_eq!(traffic(&world).await, "human|2");
    assert_eq!(
        world
            .text("SELECT concat_ws('|', human, reason, step) FROM an_sessions ORDER BY started_at")
            .await,
        "confirmed|media|6\nconfirmed|media|6"
    );
    assert_eq!(
        world
            .number("SELECT count(*) FROM an_persons WHERE first_call_day = '2026-11-12'")
            .await,
        2
    );
    assert_eq!(
        world
            .number("SELECT count(*) FROM an_person_days WHERE confirmed")
            .await,
        2
    );
}

#[tokio::test]
async fn a_call_that_came_before_the_session_confirms_it_on_arrival_and_never_confirms_a_robot() {
    let mut world = world().await;
    let anna = Browser::desktop(1);
    let mut robot = Browser {
        webdriver: true,
        ..Browser::desktop(2)
    };
    let profiles = (
        anna.pseudonym(&world).unwrap(),
        robot.pseudonym(&world).unwrap(),
    );
    world
        .facts(
            at("2026-11-12 10:00:00"),
            json!([
                {"type": "media_up", "room": "r1", "member": "m1", "profile": profiles.0},
                {"type": "media_up", "room": "r1", "member": "m2", "profile": profiles.1},
            ]),
        )
        .await;
    // Сессия Анны пришла позже звонка — становится человеком при появлении.
    let mut anna = anna;
    anna.open(&mut world, &sid("a1"), at("2026-11-12 10:00:20"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("a1")),
        Some((Class::Confirmed, reason::MEDIA))
    );
    // Автоматика с настоящим WebRTC (свои автотесты без ключа пробы) остаётся автоматикой.
    robot
        .open(&mut world, &sid("x1"), at("2026-11-12 10:00:20"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("x1")),
        Some((Class::Automation, reason::WEBDRIVER))
    );
    world.flush(at("2026-11-12 10:01:00")).await;
    assert_eq!(traffic(&world).await, "automation|1\nhuman|1");
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 1);
}

#[tokio::test]
async fn a_device_that_opens_more_than_20_sessions_an_hour_is_demoted_until_the_end_of_the_day() {
    let mut world = world().await;
    let mut device = Browser::desktop(1);
    let start = at("2026-11-12 10:00:00");
    for n in 0..22 {
        device
            .arrive(
                &mut world,
                &sid(&format!("s{n}")),
                start + Duration::minutes(n),
            )
            .await;
    }
    world.flush(at("2026-11-12 10:30:00")).await;
    // Двадцать сессий — люди; двадцать первая и дальше — «неясно», строк нет.
    assert_eq!(world.number("SELECT count(*) FROM an_sessions").await, 20);
    assert_eq!(traffic(&world).await, "human|20\nunclear|2");
    assert_eq!(
        world.engine.session_class(&sid("s21")),
        Some((Class::Unclear, reason::TOO_MANY_SESSIONS))
    );
    // Назавтра устройство снова человек.
    world.engine.sweep(at("2026-11-13 09:00:00"));
    device
        .arrive(&mut world, &sid("next"), at("2026-11-13 09:00:00"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("next")).unwrap().0,
        Class::Engaged
    );
}

#[tokio::test]
async fn a_subnet_that_sends_more_than_30_new_devices_an_hour_without_a_call_gets_no_new_rows() {
    let mut world = world().await;
    let start = at("2026-11-12 10:00:00");
    for n in 0..33 {
        // Каждая «личность» честно решает задачу, но все — из одной подсети и ни одна не звонит.
        let mut fake = Browser {
            network: network("RU", 8359, net::HOME, "farm"),
            ..Browser::desktop(100 + n)
        };
        fake.arrive(
            &mut world,
            &sid(&format!("f{n}")),
            start + Duration::seconds(i64::from(n) * 20),
        )
        .await;
    }
    world.flush(at("2026-11-12 10:30:00")).await;
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 30);
    assert_eq!(traffic(&world).await, "human|30\nunclear|3");
    assert_eq!(
        world.engine.session_class(&sid("f32")),
        Some((Class::Unclear, reason::SUBNET_FLOOD))
    );

    // Прежние устройства подсети узнаются по-прежнему…
    world.engine.sweep(at("2026-11-12 12:00:00"));
    let mut known = Browser {
        network: network("RU", 8359, net::HOME, "farm"),
        ..Browser::desktop(100)
    };
    known.cookie = Some(
        world
            .text("SELECT id FROM an_devices ORDER BY created_at LIMIT 1")
            .await,
    );
    known
        .arrive(&mut world, &sid("k1"), at("2026-11-12 12:00:00"))
        .await;
    assert_eq!(
        world.engine.session_class(&sid("k1")).unwrap().0,
        Class::Engaged
    );
    // …а дозвонившийся новичок — человек: соединение с медиаузлом не подделать.
    let mut caller = Browser {
        network: network("RU", 8359, net::HOME, "farm"),
        ..Browser::desktop(500)
    };
    caller
        .open(&mut world, &sid("c1"), at("2026-11-12 12:01:00"))
        .await;
    let profile = caller.pseudonym(&world).unwrap();
    world
        .facts(
            at("2026-11-12 12:02:00"),
            json!([{"type": "media_up", "room": "r", "member": "m", "profile": profile}]),
        )
        .await;
    assert_eq!(
        world.engine.session_class(&sid("c1")),
        Some((Class::Confirmed, reason::MEDIA))
    );
}

#[tokio::test]
async fn a_persons_session_survives_a_restart_of_the_service() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00"))
        .await;
    world.restart(at("2026-11-12 10:05:00")).await;
    assert_eq!(world.engine.live_sessions(), 0);
    // Следующая пачка той же сессии — без `session_start`: служба находит сессию в базе.
    anna.send(
        &mut world,
        &sid("a1"),
        at("2026-11-12 10:06:00"),
        json!([{"n": "screen", "p": {"name": "prejoin"}}, {"n": "invite", "p": {"how": "copy"}}]),
    )
    .await;
    world.flush(at("2026-11-12 10:06:10")).await;
    assert_eq!(
        world.engine.session_class(&sid("a1")).unwrap().0,
        Class::Engaged
    );
    assert_eq!(world.number("SELECT count(*) FROM an_persons").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_sessions").await, 1);
    assert_eq!(traffic(&world).await, "human|1");
    assert_eq!(
        world
            .text("SELECT concat_ws('|', sessions, invites) FROM an_person_days")
            .await,
        "1|1"
    );
    assert_eq!(
        world
            .text("SELECT concat_ws('|', step, last_at::time(0)) FROM an_sessions")
            .await,
        "3|10:06:00"
    );
}
