//! Образцы ответов отчётов (`contracts/fixtures/insight/*.json`) — из синтетического набора, прогнанного
//! через движок: 60 дней, несколько сотен людей, роботы, свои проверки, встречи, интеграции, ошибки.
//!
//! Набор детерминирован (свой генератор случайных чисел с постоянным зерном, свои часы), поэтому образцы
//! сверяются с файлами байт в байт: изменилась форма или счёт — тест упадёт. Записать заново:
//!
//! ```text
//! INSIGHT_WRITE_FIXTURES=1 rust/cargo.sh test --test db fixtures
//! ```

use std::path::PathBuf;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use cord_insight::days::day_start;
use cord_insight::net;
use cord_insight::reports::{Query, Reports};
use serde_json::{Value, json};

use crate::common::*;

/// Последний день набора; отчёты строятся «сегодня» — на следующий.
const LAST_DAY: &str = "2026-11-10";
const DAYS: i64 = 60;

/// SplitMix64: маленький генератор с постоянным зерном — набор один и тот же на любой машине.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn between(&mut self, from: i64, to: i64) -> i64 {
        from + self.below((to - from + 1) as u64) as i64
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Clone>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize].clone()
    }
}

/// Что происходит в наборе, по порядку времени.
enum Action {
    Open(usize, String),
    Engage(usize, String),
    Send(usize, String, Value),
    Fact(&'static str, Value),
}

struct Person {
    browser: Browser,
    /// С какой вероятностью (в процентах) человек приходит в любой следующий день.
    loyalty: u64,
}

const ROBOTS: &[&str] = &[
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "TelegramBot (like TwitterBot)",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "curl/8.5.0",
    "python-requests/2.32.3",
    "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "WhatsApp/2.23.20.0 A",
];
const HEADLESS: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36";

/// Новый человек: устройство, сеть, откуда пришёл.
fn newcomer(rng: &mut Rng, n: u32, day: i64) -> Person {
    let mut browser = match rng.below(100) {
        0..=59 => Browser::desktop(n),
        60..=89 => Browser::phone(n),
        90..=94 => Browser { agent: SAFARI_MAC, ..Browser::desktop(n) },
        _ => Browser { agent: SAFARI_IPHONE, ..Browser::phone(n) },
    };
    if browser.agent == CHROME_WINDOWS && rng.chance(12) {
        browser.agent = CORD_DESKTOP;
        browser.client = Some("desktop");
    }
    let mobile = browser.network.class == net::MOBILE;
    let (country, tz, asn) = rng.pick(&[
        ("RU", "Europe/Moscow", 8359),
        ("RU", "Europe/Moscow", 12389),
        ("RU", "Europe/Moscow", 8359),
        ("RU", "Asia/Yekaterinburg", 12389),
        ("RU", "Europe/Moscow", 16345),
        ("KZ", "Asia/Almaty", 9198),
        ("BY", "Europe/Minsk", 6697),
        ("DE", "Europe/Berlin", 3320),
    ]);
    browser.tz = tz;
    browser.network = network(country, if mobile { 31133 } else { asn }, if mobile { net::MOBILE } else { net::HOME }, &format!("net-{}", rng.below(140)));
    // Каждый пятнадцатый ходит через VPN: адрес — в дата-центре за границей, пояс — свой.
    if rng.chance(7) {
        browser.network = network("NL", 14061, net::HOSTING, &format!("vpn-{}", rng.below(6)));
    }
    browser.landing = rng.pick(&["invite", "invite", "invite", "invite", "home", "home", "home", "room", "tg", "download", "app"]);
    browser.source = rng.pick(&["", "", "", "", "t.me", "t.me", "yandex.ru", "google.com", "vk.com"]);
    if rng.chance(15) {
        browser.utm = rng.pick(&[
            json!({"source": "telegram", "medium": "post", "campaign": "launch-1-4"}),
            json!({"source": "telegram", "medium": "post", "campaign": "launch-1-4"}),
            json!({"source": "vk", "medium": "ads", "campaign": "autumn"}),
            json!({"source": "habr", "medium": "article"}),
        ]);
    }
    // Новая версия клиента выходит на сороковой день набора.
    browser.version = if day < 40 { "1.3.7" } else { "1.4.0" };
    Person { browser, loyalty: rng.pick(&[1, 2, 2, 4, 4, 8, 15, 30, 55, 80]) }
}

fn ms(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis()
}

/// Прогнать набор через движок.
async fn simulate(world: &mut World) {
    let mut rng = Rng(239);
    let first_day = day(LAST_DAY) - chrono::Days::new(DAYS as u64 - 1);
    let mut people: Vec<Person> = Vec::new();
    let mut crowd = 0u32;
    let mut rooms = 0u32;

    for d in 0..DAYS {
        let date = first_day + chrono::Days::new(d as u64);
        let morning = day_start(date, ZONE) + Duration::hours(8);
        let mut script: Vec<(DateTime<Utc>, Action)> = Vec::new();
        // Кто готов войти во встречу: человек, сессия, с какого момента.
        let mut callers: Vec<(DateTime<Utc>, usize, String)> = Vec::new();

        // ── Кто сегодня приходит: вернувшиеся и новые ────────────────────────────────────────────
        let mut today: Vec<usize> = (0..people.len()).filter(|i| rng.chance(people[*i].loyalty)).collect();
        for _ in 0..rng.between(3, 8) {
            people.push(newcomer(&mut rng, people.len() as u32 + 1, d));
            today.push(people.len() - 1);
        }
        for who in today {
            let returning = people[who].browser.cookie.is_some();
            let person = &mut people[who];
            person.browser.version = if d < 40 { "1.3.7" } else { "1.4.0" };
            if returning {
                // Потери опор личности: инкогнито и полная очистка, стёртые куки, стёртое хранилище.
                match rng.below(100) {
                    0..=3 => {
                        person.browser.cookie = None;
                        person.browser.profile = Some(profile_secret(100_000 + rng.below(900_000) as u32));
                    }
                    4..=7 => person.browser.cookie = None,
                    8..=11 => person.browser.profile = Some(profile_secret(100_000 + rng.below(900_000) as u32)),
                    _ => {}
                }
                person.browser.landing = rng.pick(&["home", "home", "invite", "room", "app"]);
            }
            let session = sid(&format!("p{who}d{d}"));
            let opened = morning + Duration::seconds(rng.between(0, 13 * 3600));
            script.push((opened, Action::Open(who, session.clone())));
            // Открыл и ушёл: так и остался «неясно».
            if rng.chance(4) {
                continue;
            }
            let acted = opened + Duration::seconds(rng.between(4, 25));
            script.push((acted, Action::Engage(who, session.clone())));
            let mut events = vec![json!({"n": "screen", "at": ms(acted), "p": {"name": "home"}})];
            if rng.chance(4) {
                let (code, scope, fatal) = rng.pick(&[("TypeError", "app", true), ("ChunkLoadError", "update", true), ("RangeError", "app", false)]);
                events.push(json!({"n": "error", "at": ms(acted) + 500, "p": {"code": code, "scope": scope, "screen": "home", "fatal": fatal, "detail": "Cannot read properties of undefined"}}));
            }
            if rng.chance(18) {
                events.push(json!({"n": "screen", "at": ms(acted) + 2000, "p": {"name": "settings", "tab": rng.pick(&["devices", "background", "language"])}}));
            }
            if !rng.chance(62) {
                script.push((acted + Duration::seconds(3), Action::Send(who, session, Value::Array(events))));
                continue;
            }
            // Предвход: экран, разрешения.
            let at_door = acted + Duration::seconds(rng.between(5, 40));
            events.push(json!({"n": "screen", "at": ms(at_door), "p": {"name": "prejoin"}}));
            events.push(json!({"n": "prejoin", "at": ms(at_door), "p": {"from": rng.pick(&["create", "invite", "invite", "code", "recent", "favorite"])}}));
            let allowed = rng.chance(90);
            for device in ["mic", "cam"] {
                let result = if allowed { "granted" } else { rng.pick(&["denied", "denied", "dismissed"]) };
                events.push(json!({"n": "permission", "at": ms(at_door) + 3000, "p": {"device": device, "result": result}}));
            }
            if !allowed {
                events.push(json!({"n": "error", "at": ms(at_door) + 3100, "p": {"code": "NotAllowedError", "scope": "device", "screen": "prejoin", "fatal": false, "detail": "Permission denied"}}));
            }
            script.push((at_door + Duration::seconds(4), Action::Send(who, session.clone(), Value::Array(events))));
            if allowed {
                callers.push((at_door + Duration::seconds(10), who, session));
            }
        }

        // ── Встречи ──────────────────────────────────────────────────────────────────────────────
        callers.sort_by_key(|(ready, who, _)| (*ready, *who));
        let mut queue = callers.into_iter().peekable();
        while queue.peek().is_some() {
            let size = rng.pick(&[1usize, 2, 2, 2, 3, 3, 4, 5]);
            let members: Vec<(DateTime<Utc>, usize, String)> = queue.by_ref().take(size).collect();
            rooms += 1;
            let room = format!("room-{rooms}");
            let node = rng.pick(&["fra", "fra", "hel", "msk"]);
            let start = members.iter().map(|(ready, ..)| *ready).max().unwrap_or(morning) + Duration::seconds(5);
            let minutes = if members.len() == 1 { rng.between(1, 4) } else { rng.between(2, 50) };
            let end = start + Duration::minutes(minutes);
            let profile = |who: usize| people[who].browser.pseudonym(world).unwrap_or_default();
            script.push((start, Action::Fact("core", json!({"type": "meeting_open", "at": ms(start), "room": room, "node": node, "profile": profile(members[0].1)}))));
            // Кто вошёл и до какого момента оставался.
            let mut inside: Vec<(usize, String, String, DateTime<Utc>, DateTime<Utc>)> = Vec::new();
            for (n, (_, who, session)) in members.iter().enumerate() {
                let joined = start + Duration::seconds(3 * n as i64 + 1);
                let how = if n == 0 { "create" } else { rng.pick(&["link", "link", "code", "saved"]) };
                if n > 0 && rng.chance(7) {
                    let code = rng.pick(&["ROOM_FULL", "CODE_INVALID", "SERVER_BUSY", "RATE_LIMITED"]);
                    script.push((joined, Action::Fact("core", json!({"type": "join_fail", "at": ms(joined), "profile": profile(*who), "how": how, "code": code}))));
                    let seen = json!([{"n": "error", "at": ms(joined) + 200, "p": {"code": code, "scope": "join", "screen": "prejoin", "fatal": false, "detail": "HTTP 409"}}]);
                    script.push((joined + Duration::seconds(1), Action::Send(*who, session.clone(), seen)));
                    continue;
                }
                let member = format!("m{n}");
                let client = people[*who].browser.client.unwrap_or("web");
                script.push((joined, Action::Fact("core", json!({"type": "join", "at": ms(joined), "room": room, "profile": profile(*who), "member": member, "how": how, "node": node, "client": client}))));
                let on_media = joined + Duration::seconds(2);
                script.push((on_media, Action::Fact("core", json!({"type": "media_up", "at": ms(on_media), "room": room, "profile": profile(*who), "member": member, "node": node}))));
                let total = rng.between(700, 4200);
                let mut events = vec![
                    json!({"n": "screen", "at": ms(on_media), "p": {"name": "meeting"}}),
                    json!({"n": "join_timing", "at": ms(on_media), "p": {"ms": total, "signal_ms": total / 3, "media_ms": total / 2, "node": node}}),
                ];
                if n == 0 && rng.chance(45) {
                    events.push(json!({"n": "invite", "at": ms(on_media) + 4000, "p": {"how": rng.pick(&["copy", "copy", "share", "qr"])}}));
                }
                for _ in 0..rng.below(3) {
                    let feature = rng.pick(&["chat", "chat", "reaction", "screen_share", "background", "hand", "layout", "pin", "noise"]);
                    events.push(json!({"n": "feature", "at": ms(on_media) + 9000, "p": {"name": feature, "count": rng.between(1, 4)}}));
                }
                script.push((on_media + Duration::seconds(10), Action::Send(*who, session.clone(), Value::Array(events))));
                // Последний остаётся до конца, остальные уходят в последней трети встречи.
                let left = if n == 0 { end } else { end - Duration::seconds(rng.between(0, minutes * 20)) };
                inside.push((*who, session.clone(), member, on_media, left));
            }
            // Присутствие раз в минуту, сводка качества — раз в минуту на участника (в жизни — раз в 10 с).
            let relayed = rng.chance(15);
            let mut tick = start + Duration::seconds(60);
            while tick < end {
                let present: Vec<Value> = inside.iter().filter(|m| m.3 <= tick && tick < m.4).map(|m| json!({"member": m.2, "profile": profile(m.0)})).collect();
                if !present.is_empty() {
                    script.push((tick, Action::Fact("core", json!({"type": "presence", "at": ms(tick), "room": room, "node": node, "members": present}))));
                }
                for member in inside.iter().filter(|m| m.3 <= tick && tick < m.4) {
                    let quality = json!({
                        "type": "quality", "at": ms(tick), "room": room, "profile": profile(member.0),
                        "mic_s": rng.between(4, 10), "cam_s": if rng.chance(70) { 10 } else { 0 }, "screen_s": if rng.chance(8) { 10 } else { 0 },
                        "bytes_up": rng.between(200_000, 900_000), "bytes_down": rng.between(400_000, 2_500_000),
                        "loss": rng.between(0, 30) as f64 / 1000.0, "rtt": rng.between(25, 180), "freezes": u8::from(rng.chance(3)),
                        "relay": relayed, "reconnects": u8::from(rng.chance(1)),
                    });
                    script.push((tick, Action::Fact("core", quality)));
                }
                tick += Duration::seconds(60);
            }
            if rng.chance(4) && !inside.is_empty() {
                let moved = start + Duration::seconds(90);
                script.push((moved, Action::Fact("core", json!({"type": "node_move", "at": ms(moved), "room": room, "from": node, "to": "hel", "reason": "drain"}))));
            }
            // Интеграция: у встреч не в одиночку.
            if inside.len() >= 2 && minutes >= 4 && rng.chance(40) {
                let (kind, variant) = rng.pick(&[
                    ("cinema", "youtube"), ("cinema", "youtube"), ("cinema", "rutube"), ("cinema", "vk"), ("cinema", "ivi"),
                    ("music", "yandex"), ("music", "yandex"), ("game", "durak"), ("game", "chess"), ("game", "poker"), ("board", ""),
                ]);
                let run = format!("run-{rooms}");
                let opened = start + Duration::seconds(70);
                let closed = (opened + Duration::minutes(rng.between(2, 30))).min(end - Duration::seconds(20));
                script.push((opened, Action::Fact("core", json!({"type": "integration_open", "at": ms(opened), "room": room, "run": run, "kind": kind, "variant": variant, "profile": profile(inside[0].0)}))));
                let mut tick = opened + Duration::seconds(30);
                let failed = rng.chance(8);
                while tick <= closed {
                    if matches!(kind, "cinema" | "music") {
                        let bytes = if kind == "cinema" { rng.between(1_500_000, 4_000_000) } else { rng.between(200_000, 500_000) };
                        script.push((tick, Action::Fact("services", json!({"type": "usage", "at": ms(tick), "room": room, "kind": kind, "variant": variant, "bytes": bytes, "seconds": 30}))));
                    }
                    for member in inside.iter().filter(|m| m.3 <= tick && tick < m.4) {
                        let stalled = kind == "cinema" && rng.chance(5);
                        let view = json!([{"n": "integration_view", "at": ms(tick), "p": {"room": room, "kind": kind, "variant": variant, "seconds": 30, "stalls": u8::from(stalled), "stall_ms": if stalled { rng.between(300, 4000) } else { 0 }}}]);
                        script.push((tick, Action::Send(member.0, member.1.clone(), view)));
                    }
                    tick += Duration::seconds(30);
                }
                if failed {
                    let code = rng.pick(&["CINEMA_GEO", "CINEMA_TIMEOUT", "CINEMA_STREAM_FAILED", "MUSIC_UNREACHABLE"]);
                    script.push((closed, Action::Fact("services", json!({"type": "integration_error", "at": ms(closed), "room": room, "run": run, "kind": kind, "variant": variant, "code": code}))));
                }
                let why = if failed { "error" } else { rng.pick(&["closed", "closed", "replaced", "ended"]) };
                script.push((closed + Duration::seconds(1), Action::Fact("core", json!({"type": "integration_close", "at": ms(closed) + 1000, "room": room, "run": run, "reason": why}))));
            }
            for member in &inside {
                let why = rng.pick(&["left", "left", "left", "left", "lost", "ended"]);
                script.push((member.4, Action::Fact("core", json!({"type": "media_down", "at": ms(member.4), "room": room, "profile": profile(member.0), "member": member.2, "reason": why}))));
                let reason = if why == "lost" { "network" } else { rng.pick(&["user", "user", "closed", "ended"]) };
                let leave = json!([{"n": "leave", "at": ms(member.4), "p": {"reason": reason, "seconds": (member.4 - member.3).num_seconds()}}]);
                script.push((member.4 + Duration::seconds(1), Action::Send(member.0, member.1.clone(), leave)));
                if why == "lost" {
                    let broken = json!([{"n": "error", "at": ms(member.4), "p": {"code": "ICE_FAILED", "scope": "media", "screen": "meeting", "fatal": false, "detail": "iceConnectionState failed"}}]);
                    script.push((member.4 + Duration::seconds(2), Action::Send(member.0, member.1.clone(), broken)));
                }
            }
            let closed = end + Duration::seconds(5);
            script.push((closed, Action::Fact("core", json!({"type": "meeting_close", "at": ms(closed), "room": room, "reason": rng.pick(&["empty", "empty", "owner"]), "peak": inside.len()}))));
        }

        // ── Роботы, автоматика, свои проверки, молчаливые заходы ─────────────────────────────────
        let mut stranger = |rng: &mut Rng, browser: Browser, people: &mut Vec<Person>, script: &mut Vec<(DateTime<Utc>, Action)>| {
            crowd += 1;
            people.push(Person { browser, loyalty: 0 });
            let at = morning - Duration::hours(8) + Duration::seconds(rng.between(0, 86_000));
            script.push((at, Action::Open(people.len() - 1, sid(&format!("x{crowd}")))));
        };
        for _ in 0..rng.between(10, 24) {
            let robot = Browser { agent: rng.pick(ROBOTS), client: None, profile: None, network: network(rng.pick(&["US", "US", "DE", "RU", "FI"]), 16509, net::HOSTING, "robots"), ..Browser::desktop(0) };
            stranger(&mut rng, robot, &mut people, &mut script);
        }
        for _ in 0..rng.between(2, 6) {
            let driven = if rng.chance(50) { Browser { agent: HEADLESS, ..Browser::desktop(0) } } else { Browser { webdriver: true, ..Browser::desktop(0) } };
            stranger(&mut rng, Browser { profile: None, network: network("DE", 24940, net::HOSTING, "ci"), ..driven }, &mut people, &mut script);
        }
        for _ in 0..12 {
            stranger(&mut rng, Browser { probe: true, profile: None, network: network("RU", 8359, net::HOME, "office"), ..Browser::desktop(0) }, &mut people, &mut script);
        }
        for n in 0..rng.between(5, 14) {
            let number = 900_000 + d as u32 * 100 + n as u32;
            let silent = if rng.chance(50) { Browser::desktop(number) } else { Browser::phone(number) };
            stranger(&mut rng, silent, &mut people, &mut script);
        }
        let night = morning + Duration::hours(15);
        for (code, most) in [("RATE_LIMITED", 6), ("PROOF_INVALID", 3), ("BLOCKED", 2)] {
            let count = rng.between(0, most);
            if count > 0 {
                script.push((night, Action::Fact("core", json!({"type": "refusal", "at": ms(night), "code": code, "count": count}))));
            }
        }

        // ── День идёт по порядку времени ─────────────────────────────────────────────────────────
        script.sort_by_key(|(at, _)| *at);
        let mut facts: Vec<Value> = Vec::new();
        let mut source = "core";
        let mut last = morning;
        for (at, action) in script {
            last = last.max(at);
            let pending = matches!(&action, Action::Fact(from, _) if *from == source) && facts.len() < 400;
            if !pending && !facts.is_empty() {
                world.facts_from(source, last, Value::Array(std::mem::take(&mut facts))).await;
            }
            match action {
                Action::Open(who, session) => people[who].browser.open(world, &session, at).await,
                Action::Engage(who, session) => people[who].browser.engage(world, &session, at).await,
                Action::Send(who, session, events) => people[who].browser.send(world, &session, at, events).await,
                Action::Fact(from, fact) => {
                    source = from;
                    facts.push(fact);
                }
            }
        }
        if !facts.is_empty() {
            world.facts_from(source, last, Value::Array(facts)).await;
        }
        // Конец суток: сессии старше получаса забыты, накопленное записано.
        let midnight = day_start(date + chrono::Days::new(1), ZONE) + Duration::minutes(40);
        world.engine.sweep(midnight);
        world.flush(midnight).await;
        // Чужих заходов движок больше не увидит — и набору они не нужны.
        people.retain(|person| person.loyalty > 0);
    }
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contracts/fixtures/insight")
}

/// Сверить образец с файлом — или записать его, если так велено.
fn settle(name: &str, report: &Value) {
    let path = fixture_dir().join(format!("{name}.json"));
    let text = serde_json::to_string_pretty(report).unwrap() + "\n";
    if std::env::var("INSIGHT_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(fixture_dir()).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("нет образца {}: INSIGHT_WRITE_FIXTURES=1", path.display()));
    assert!(saved == text, "образец {name}.json разошёлся с ответом службы: INSIGHT_WRITE_FIXTURES=1 и посмотреть diff");
}

#[tokio::test]
async fn fixtures_are_the_reports_of_a_seeded_synthetic_dataset() {
    let mut world = world().await;
    simulate(&mut world).await;
    let reports = Reports::new(world.pool.clone(), ZONE);
    let now = at("2026-11-11 09:00:00");
    let last: NaiveDate = day(LAST_DAY);
    let two_weeks = Query { from: last - chrono::Days::new(13), to: last, cohort: false, strict: false, compare: false };
    let report = async |section: &str, key: Option<&str>, query: &Query| reports.report(section, key, query, now).await.unwrap();

    // Набор похож на жизнь: людей — сотни, роботов и своих проверок — больше, чем людей в день.
    let people = world.number("SELECT count(*) FROM an_persons").await;
    assert!((250..600).contains(&people), "людей в наборе: {people}");
    assert!(world.number("SELECT count(*) FROM an_persons WHERE merged_into IS NOT NULL").await > 0, "есть узнанные по отпечатку");
    assert!(world.number("SELECT count(*) FROM an_sessions WHERE via = 'profile'").await > 0, "есть узнанные по профилю");
    assert!(world.number("SELECT count(*) FROM an_meetings WHERE closed_at IS NULL").await == 0, "все встречи закрыты");
    assert!(world.number("SELECT count(*) FROM an_integration_runs").await > 20);

    for section in ["pulse", "audience", "acquisition", "activation", "engagement", "integrations", "quality", "errors"] {
        settle(section, &report(section, None, &two_weeks).await);
    }
    // Удержание — видом «Когорты»: три недели пришедших и их жизнь до сегодня.
    let cohorts = Query { from: day("2026-10-01"), to: day("2026-10-21"), cohort: true, ..two_weeks.clone() };
    settle("retention", &report("retention", None, &cohorts).await);
    // Трафик — с прошлым периодом (`compare=1`): так выглядит оболочка со сравнением.
    settle("traffic", &report("traffic", None, &Query { compare: true, ..two_weeks.clone() }).await);
    // Одна группа ошибок — самая частая из увиденных клиентом.
    let errors = report("errors", None, &two_weeks).await;
    let top = errors["data"]["groups"].as_array().unwrap().iter().find(|g| g["source"] == "client").expect("в наборе есть ошибки клиента");
    settle("errors-detail", &report("errors", top["key"].as_str(), &two_weeks).await);

    // Здравый смысл образцов: счёт сходится между разделами.
    let pulse = report("pulse", None, &two_weeks).await;
    let audience = report("audience", None, &two_weeks).await;
    let traffic = report("traffic", None, &two_weeks).await;
    assert_eq!(pulse["data"]["tiles"]["people"]["value"], audience["data"]["totals"]["people"]);
    assert_eq!(audience["data"]["totals"]["sessions"], traffic["data"]["totals"]["human"], "сессии людей — это заходы класса «люди»");
    let tiles = &pulse["data"]["tiles"];
    assert_eq!(tiles["people"]["value"].as_i64().unwrap(), tiles["new_people"]["value"].as_i64().unwrap() + tiles["returning"]["value"].as_i64().unwrap());
    assert_eq!(tiles["people"]["value"].as_i64().unwrap(), tiles["confirmed"]["value"].as_i64().unwrap() + tiles["engaged_only"]["value"].as_i64().unwrap());
    let strict = report("pulse", None, &Query { strict: true, ..two_weeks.clone() }).await;
    assert!(strict["data"]["tiles"]["new_people"]["value"].as_i64() > tiles["new_people"]["value"].as_i64(), "строгий счёт видит узнанных по отпечатку новыми");
}
