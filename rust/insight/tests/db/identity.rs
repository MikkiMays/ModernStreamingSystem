//! Какой человек у сессии — каждая ветка правила §4.5 проекта.

use cord_insight::net;

use crate::common::*;

/// Люди обычным счётом (склейка по отпечатку — один человек) и строгим (без неё).
async fn people(world: &World) -> (i64, i64) {
    let merged = world.number("SELECT count(DISTINCT COALESCE(merged_into, id)) FROM an_persons").await;
    let strict = world.number("SELECT count(*) FROM an_persons").await;
    (merged, strict)
}

#[tokio::test]
async fn a_new_visitor_who_acts_becomes_a_person_with_a_device_a_profile_and_a_session() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.landing = "invite";
    anna.source = "t.me";
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    world.flush(at("2026-11-12 10:00:10")).await;

    assert_eq!(people(&world).await, (1, 1));
    let person = world
        .text("SELECT concat_ws('|', first_day, last_day, landing, source, client, os, country, merged_into) FROM an_persons")
        .await;
    assert_eq!(person, "2026-11-12|2026-11-12|invite|t.me|web|windows|RU");
    let device = world.text("SELECT concat_ws('|', client, os, browser, class, link, fp_strength, country, asn, tz) FROM an_devices").await;
    assert_eq!(device, "web|windows|chrome|desktop|cookie|3|RU|8359|Europe/Moscow");
    // Ключ устройства — id из куки, которую браузер получил; профиль хранится псевдонимом.
    assert_eq!(world.text("SELECT id FROM an_devices").await, anna.cookie.clone().unwrap());
    assert_eq!(world.text("SELECT profile FROM an_profiles").await, anna.pseudonym(&world).unwrap());
    let session = world.text("SELECT concat_ws('|', sid, day, human, reason, via, step, landing, net, vpn) FROM an_sessions").await;
    assert_eq!(session, format!("{}|2026-11-12|engaged|engaged|new|2|invite|home|f", sid("a1")));
    assert_eq!(world.text("SELECT concat_ws('|', day, sessions) FROM an_person_days").await, "2026-11-12|1");
}

#[tokio::test]
async fn rule_1_the_cookie_is_the_device_and_an_unfamiliar_profile_is_bound_to_it() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    // Safari стёр хранилище: профиль новый, кука та же. Адрес другой — VPN личности не мешает.
    anna.profile = Some(profile_secret(99));
    anna.network = network("NL", 14061, net::HOSTING, "subnet-vpn");
    anna.arrive(&mut world, &sid("a2"), at("2026-11-20 10:00:00")).await;
    world.flush(at("2026-11-20 10:01:00")).await;

    assert_eq!(people(&world).await, (1, 1));
    assert_eq!(world.number("SELECT count(*) FROM an_devices").await, 1);
    assert_eq!(world.number("SELECT count(*) FROM an_profiles").await, 2);
    assert_eq!(world.number("SELECT count(DISTINCT device_id) FROM an_profiles").await, 1);
    assert_eq!(world.text("SELECT via FROM an_sessions ORDER BY started_at").await, "new\ncookie");
    assert_eq!(world.text("SELECT concat_ws('|', first_day, last_day) FROM an_persons").await, "2026-11-12|2026-11-20");
    assert_eq!(world.text("SELECT concat_ws('|', link, country) FROM an_devices").await, "cookie|NL");
}

#[tokio::test]
async fn rule_2_a_known_profile_without_the_cookie_is_its_device_and_the_cookie_is_issued_again() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    let device = anna.cookie.clone().unwrap();
    world.engine.sweep(at("2026-11-12 11:00:00"));
    // Куки стёрты, профиль в localStorage остался.
    anna.cookie = None;
    anna.open(&mut world, &sid("a2"), at("2026-11-13 10:00:00")).await;
    assert_ne!(anna.cookie.clone().unwrap(), device, "первый ответ выдал новую куку: устройство ещё не узнано");
    anna.engage(&mut world, &sid("a2"), at("2026-11-13 10:00:05")).await;
    world.flush(at("2026-11-13 10:01:00")).await;

    assert_eq!(anna.cookie, Some(device.clone()), "кука прежнего устройства выдана заново");
    assert_eq!(people(&world).await, (1, 1));
    assert_eq!(world.text("SELECT id FROM an_devices").await, device);
    assert_eq!(world.text("SELECT concat_ws('|', via, device_id) FROM an_sessions ORDER BY started_at").await, format!("new|{device}\nprofile|{device}"));
    assert_eq!(world.text("SELECT link FROM an_devices").await, "profile");
}

#[tokio::test]
async fn rule_3a_a_desktop_that_lost_both_is_recognised_by_fingerprint_and_the_link_is_marked() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    // Инкогнито: ни куки, ни профиля; компьютер и сеть те же.
    let mut incognito = Browser { cookie: None, profile: Some(profile_secret(50)), ..anna.clone() };
    incognito.arrive(&mut world, &sid("a2"), at("2026-11-14 10:00:00")).await;
    world.flush(at("2026-11-14 10:01:00")).await;

    // Обычный счёт — один человек, строгий — два; связь помечена и у устройства, и у сессии.
    assert_eq!(people(&world).await, (1, 2));
    assert_eq!(world.number("SELECT count(*) FROM an_devices").await, 2);
    assert_eq!(world.text("SELECT link FROM an_devices ORDER BY created_at").await, "cookie\nfingerprint");
    assert_eq!(world.text("SELECT via FROM an_sessions ORDER BY started_at").await, "new\nfingerprint");
    let first = world.number("SELECT min(id) FROM an_persons").await;
    assert_eq!(world.number("SELECT merged_into FROM an_persons WHERE merged_into IS NOT NULL").await, first);

    // Третье устройство того же человека привязывается к тому же корню, а не к промежуточному.
    world.engine.sweep(at("2026-11-14 11:00:00"));
    let mut again = Browser { cookie: None, profile: Some(profile_secret(51)), ..anna.clone() };
    again.arrive(&mut world, &sid("a3"), at("2026-11-16 10:00:00")).await;
    world.flush(at("2026-11-16 10:01:00")).await;
    assert_eq!(people(&world).await, (1, 3));
    assert_eq!(world.number("SELECT count(*) FROM an_persons WHERE merged_into = (SELECT min(id) FROM an_persons)").await, 2);
}

#[tokio::test]
async fn rule_3a_any_of_subnet_asn_or_country_with_zone_links_and_none_of_them_does_not() {
    for (case, network, seen_in_zone, linked) in [
        ("та же подсеть", network("DE", 1, net::HOME, "subnet-1"), "Europe/Moscow", true),
        ("тот же провайдер", network("DE", 8359, net::HOME, "subnet-x"), "Europe/Moscow", true),
        ("та же страна и пояс", network("RU", 1, net::HOME, "subnet-x"), "Europe/Moscow", true),
        ("та же страна, другой пояс", network("RU", 1, net::HOME, "subnet-x"), "Asia/Yekaterinburg", false),
        ("всё другое", network("DE", 1, net::HOME, "subnet-x"), "Europe/Moscow", false),
    ] {
        let mut world = world().await;
        let mut anna = Browser::desktop(1);
        anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
        world.engine.sweep(at("2026-11-12 11:00:00"));
        // Пояс входит в отпечаток, поэтому у пришедшего он прежний; «другой пояс» — у прежнего устройства
        // в его строке.
        sqlx::query("UPDATE an_devices SET tz = $1").bind(seen_in_zone).execute(&world.pool).await.unwrap();
        let mut later = Browser { cookie: None, profile: Some(profile_secret(50)), network, ..anna.clone() };
        later.arrive(&mut world, &sid("a2"), at("2026-11-14 10:00:00")).await;
        world.flush(at("2026-11-14 10:01:00")).await;
        assert_eq!(people(&world).await, if linked { (1, 2) } else { (2, 2) }, "{case}");
    }
}

#[tokio::test]
async fn rule_3a_two_identical_office_computers_online_at_once_are_two_people() {
    // Два одинаковых компьютера в одном офисе: тот же отпечаток, та же подсеть.
    let mut world = world().await;
    let mut first = Browser::desktop(1);
    let mut second = Browser { cookie: None, profile: Some(profile_secret(2)), ..first.clone() };
    first.arrive(&mut world, &sid("o1"), at("2026-11-12 10:00:00")).await;
    // Первый на связи прямо сейчас — второй не может быть им же.
    second.arrive(&mut world, &sid("o2"), at("2026-11-12 10:10:00")).await;
    world.flush(at("2026-11-12 10:11:00")).await;
    assert_eq!(people(&world).await, (2, 2));
    assert_eq!(world.text("SELECT via FROM an_sessions ORDER BY started_at").await, "new\nnew");

    // Первый во встрече, а его вкладка давно молчит: присутствие — тоже «на связи».
    let mut world = self::world().await;
    let mut first = Browser::desktop(1);
    let mut second = Browser { cookie: None, profile: Some(profile_secret(2)), ..first.clone() };
    first.arrive(&mut world, &sid("o1"), at("2026-11-12 10:00:00")).await;
    let profile = first.pseudonym(&world).unwrap();
    let call = serde_json::json!([{"type": "media_up", "room": "r", "member": "m1", "profile": profile}]);
    world.facts(at("2026-11-12 10:01:00"), call).await;
    world.engine.sweep(at("2026-11-12 11:30:00"));
    assert_eq!(world.engine.live_sessions(), 0);
    second.arrive(&mut world, &sid("o2"), at("2026-11-12 11:31:00")).await;
    world.flush(at("2026-11-12 11:32:00")).await;
    assert_eq!(people(&world).await, (2, 2));
}

#[tokio::test]
async fn rule_3a_phones_are_never_merged_by_fingerprint() {
    let mut world = world().await;
    // Два телефона одной модели за одной мобильной сетью: отпечаток и подсеть совпадают.
    let mut one = Browser::phone(1);
    let mut two = Browser::phone(2);
    one.arrive(&mut world, &sid("p1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    two.arrive(&mut world, &sid("p2"), at("2026-11-13 10:00:00")).await;
    world.flush(at("2026-11-13 10:01:00")).await;
    assert_eq!(people(&world).await, (2, 2));
    assert_eq!(world.text("SELECT DISTINCT class FROM an_devices").await, "phone");
}

#[tokio::test]
async fn rule_3a_needs_a_strong_fingerprint_a_recent_device_and_the_same_client_and_system() {
    // Слабый отпечаток: один признак высокой силы из трёх.
    let mut world = world().await;
    let mut weak = Browser::desktop(1);
    weak.fp = serde_json::json!({"canvas": "c", "audio": "a", "hc": 8});
    weak.arrive(&mut world, &sid("w1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    let mut later = Browser { cookie: None, profile: Some(profile_secret(50)), ..weak.clone() };
    later.arrive(&mut world, &sid("w2"), at("2026-11-13 10:00:00")).await;
    world.flush(at("2026-11-13 10:01:00")).await;
    assert_eq!(people(&world).await, (2, 2), "слабый отпечаток");

    // Устройство видели 46 дней назад.
    let mut world = self::world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-09-01 10:00:00")).await;
    world.engine.sweep(at("2026-09-01 11:00:00"));
    let mut later = Browser { cookie: None, profile: Some(profile_secret(50)), ..anna.clone() };
    later.arrive(&mut world, &sid("a2"), at("2026-10-17 10:00:05")).await;
    world.flush(at("2026-10-17 10:01:00")).await;
    assert_eq!(people(&world).await, (2, 2), "46 дней");

    // Тот же отпечаток, но другая система: Mac вместо Windows.
    let mut world = self::world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    let mut mac = Browser { cookie: None, profile: Some(profile_secret(50)), agent: SAFARI_MAC, ..anna.clone() };
    mac.arrive(&mut world, &sid("a2"), at("2026-11-13 10:00:00")).await;
    world.flush(at("2026-11-13 10:01:00")).await;
    assert_eq!(people(&world).await, (2, 2), "другая система");
}

#[tokio::test]
async fn with_the_fingerprint_switched_off_only_the_cookie_and_the_profile_remain() {
    let mut world = World::on(fresh_pool().await, false);
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-11-12 10:00:00")).await;
    world.engine.sweep(at("2026-11-12 11:00:00"));
    let mut incognito = Browser { cookie: None, profile: Some(profile_secret(50)), ..anna.clone() };
    incognito.arrive(&mut world, &sid("a2"), at("2026-11-14 10:00:00")).await;
    // Кука по-прежнему узнаёт.
    world.engine.sweep(at("2026-11-14 11:00:00"));
    anna.arrive(&mut world, &sid("a3"), at("2026-11-15 10:00:00")).await;
    world.flush(at("2026-11-15 10:01:00")).await;
    assert_eq!(people(&world).await, (2, 2));
    assert_eq!(world.number("SELECT count(*) FROM an_devices WHERE fp IS NOT NULL OR fp_strength <> 0").await, 0);
    assert_eq!(world.text("SELECT via FROM an_sessions ORDER BY started_at").await, "new\nnew\ncookie");
}

#[tokio::test]
async fn the_cookie_is_renewed_once_it_is_30_days_old() {
    let mut world = world().await;
    let mut anna = Browser::desktop(1);
    anna.arrive(&mut world, &sid("a1"), at("2026-10-01 10:00:00")).await;
    let device = anna.cookie.clone().unwrap();
    let issued = async |world: &World| world.text("SELECT cookie_at::date::text FROM an_devices").await;

    // Через 29 дней — рано.
    world.engine.sweep(at("2026-10-01 11:00:00"));
    anna.arrive(&mut world, &sid("a2"), at("2026-10-30 09:00:00")).await;
    assert_eq!((anna.reissued, issued(&world).await.as_str()), (0, "2026-10-01"));
    // Через 31 день от выдачи — та же кука со свежим сроком.
    world.engine.sweep(at("2026-10-30 10:00:00"));
    anna.arrive(&mut world, &sid("a3"), at("2026-11-01 11:00:00")).await;
    assert_eq!((anna.reissued, issued(&world).await.as_str()), (1, "2026-11-01"));
    assert_eq!(anna.cookie, Some(device));
    // И снова не раньше чем через 30 дней.
    world.engine.sweep(at("2026-11-01 12:00:00"));
    anna.arrive(&mut world, &sid("a4"), at("2026-11-02 10:00:00")).await;
    assert_eq!((anna.reissued, issued(&world).await.as_str()), (1, "2026-11-01"));
}
