//! События клиента (`contracts/insight.md` §1): разбор пачки и чистка полей.
//!
//! В службу дальше этого модуля попадает только то, что названо в контракте: незнакомое событие и лишние
//! поля отбрасываются молча, строки режутся по длине, перечисления принимают только свои слова. Свободного
//! текста от человека в событиях нет.

use serde_json::{Map, Number, Value};

/// Больше событий в пачке не принимается: лишние отбрасываются.
pub const MAX_EVENTS: usize = 50;

/// Пачка событий одной сессии.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub sid: String,
    /// Секрет профиля устройства, если похож на секрет. Служба хранит только псевдоним.
    pub profile: Option<String>,
    pub client_kind: Option<String>,
    pub client_version: String,
    pub probe: Option<String>,
    pub events: Vec<Event>,
    /// Сколько событий отброшено: незнакомое имя, не объект, сверх предела.
    pub dropped: usize,
}

/// Событие с вычищенными полями.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub name: &'static str,
    /// Мс эпохи по часам клиента, как пришло.
    pub at: i64,
    pub props: Map<String, Value>,
}

impl Event {
    pub fn text(&self, key: &str) -> Option<&str> {
        self.props.get(key)?.as_str()
    }

    pub fn int(&self, key: &str) -> Option<i64> {
        self.props.get(key)?.as_i64()
    }

    pub fn flag(&self, key: &str) -> bool {
        self.props.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn object(&self, key: &str) -> Option<&Map<String, Value>> {
        self.props.get(key)?.as_object()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BatchError {
    #[error("тело — не JSON-объект")]
    NotJson,
    #[error("нет sid")]
    NoSession,
}

/// Как чистится поле.
#[derive(Clone, Copy)]
enum Field {
    /// Строка машинного текста не длиннее стольких знаков.
    Text(usize),
    /// Имя узла или домена: буквы, цифры, точка, дефис.
    Host,
    /// Одно из названных слов.
    Word(&'static [&'static str]),
    /// Целое от нуля до предела.
    Int(i64),
    /// Число от нуля до предела, до сотых.
    Num(f64),
    Bool,
    Object(&'static [(&'static str, Field)]),
}

use Field::{Bool, Host, Int, Num, Object, Text, Word};

const DAY_MS: i64 = 86_400_000;

const LANDINGS: &[&str] = &["home", "invite", "room", "app", "tg", "download", "support", "other"];
const SCREENS: &[&str] = &["home", "prejoin", "meeting", "settings", "download", "support", "activity", "other"];
pub const KINDS: &[&str] = &["cinema", "music", "game", "board"];
pub const SCOPES: &[&str] = &["join", "media", "device", "cinema", "music", "game", "board", "chat", "update", "app"];

/// События контракта и их поля.
const EVENTS: &[(&str, &[(&str, Field)])] = &[
    (
        "session_start",
        &[
            ("landing", Word(LANDINGS)),
            ("ref", Host),
            ("utm", Object(&[("source", Text(64)), ("medium", Text(64)), ("campaign", Text(64))])),
            ("lang", Text(64)),
            ("tz", Text(64)),
            ("screen", Object(&[("w", Int(100_000)), ("h", Int(100_000)), ("dpr", Num(16.0)), ("depth", Int(64))])),
            ("standalone", Bool),
            ("wd", Bool),
            (
                "fp",
                Object(&[
                    ("canvas", Text(64)),
                    ("gl", Text(64)),
                    ("fonts", Text(64)),
                    ("audio", Text(64)),
                    ("glr", Text(120)),
                    ("hc", Int(4096)),
                    ("dm", Num(4096.0)),
                    ("touch", Int(256)),
                    ("plat", Text(64)),
                ]),
            ),
        ],
    ),
    ("engaged", &[("proof", Text(2048)), ("ms", Int(DAY_MS))]),
    ("screen", &[("name", Word(SCREENS)), ("tab", Text(64))]),
    ("prejoin", &[("from", Word(&["create", "invite", "code", "recent", "favorite"]))]),
    (
        "permission",
        &[
            ("device", Word(&["mic", "cam", "screen"])),
            ("result", Word(&["granted", "denied", "dismissed", "error"])),
            ("error", Text(64)),
        ],
    ),
    ("join_timing", &[("ms", Int(DAY_MS)), ("signal_ms", Int(DAY_MS)), ("media_ms", Int(DAY_MS)), ("node", Host)]),
    ("feature", &[("name", Text(64)), ("count", Int(1_000_000))]),
    (
        "integration_view",
        &[
            ("room", Text(64)),
            ("kind", Word(KINDS)),
            ("variant", Text(64)),
            ("seconds", Int(86_400)),
            ("stalls", Int(100_000)),
            ("stall_ms", Int(DAY_MS)),
        ],
    ),
    (
        "error",
        &[("code", Text(64)), ("scope", Word(SCOPES)), ("screen", Word(SCREENS)), ("fatal", Bool), ("detail", Text(200))],
    ),
    ("invite", &[("how", Word(&["copy", "share", "qr"]))]),
    ("leave", &[("reason", Word(&["user", "closed", "network", "removed", "ended"])), ("seconds", Int(30 * 86_400))]),
];

/// Строка машинного текста: без управляющих знаков, без краёв, не длиннее `max` знаков; пустая — нет поля.
pub fn clean_text(text: &str, max: usize) -> Option<String> {
    let cleaned: String = text.trim().chars().filter(|c| !c.is_control()).take(max).collect();
    let cleaned = cleaned.trim_end().to_owned();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean(field: Field, value: &Value) -> Option<Value> {
    match field {
        Text(max) => clean_text(value.as_str()?, max).map(Value::String),
        Host => {
            let host = value.as_str()?.trim().to_ascii_lowercase();
            let fits = !host.is_empty()
                && host.len() <= 64
                && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
            fits.then_some(Value::String(host))
        }
        Word(words) => {
            let word = value.as_str()?;
            words.contains(&word).then(|| Value::String(word.to_owned()))
        }
        Int(max) => {
            // Число приходит и целым, и дробным (`performance.now()`): берётся целая часть.
            let n = value.as_i64().or_else(|| value.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))?;
            (0..=max).contains(&n).then(|| Value::Number(n.into()))
        }
        Num(max) => {
            let n = value.as_f64().filter(|f| f.is_finite() && (0.0..=max).contains(f))?;
            Number::from_f64((n * 100.0).round() / 100.0).map(Value::Number)
        }
        Bool => value.as_bool().map(Value::Bool),
        Object(fields) => {
            let object = clean_object(fields, value.as_object()?);
            (!object.is_empty()).then_some(Value::Object(object))
        }
    }
}

fn clean_object(fields: &[(&str, Field)], raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, field) in fields {
        if let Some(value) = raw.get(*name).and_then(|value| clean(*field, value)) {
            out.insert((*name).to_owned(), value);
        }
    }
    out
}

fn token(value: Option<&Value>, lengths: std::ops::RangeInclusive<usize>) -> Option<String> {
    let text = value?.as_str()?;
    let fits = lengths.contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    fits.then(|| text.to_owned())
}

/// Разобрать тело `POST /api/v1/t`.
pub fn parse(body: &[u8]) -> Result<Batch, BatchError> {
    let raw: Value = serde_json::from_slice(body).map_err(|_| BatchError::NotJson)?;
    let raw = raw.as_object().ok_or(BatchError::NotJson)?;
    let sid = token(raw.get("sid"), 16..=64).ok_or(BatchError::NoSession)?;
    let client = raw.get("client").and_then(Value::as_object);
    let client_text = |key: &str, max: usize| {
        client.and_then(|c| c.get(key)).and_then(Value::as_str).and_then(|text| clean_text(text, max))
    };
    let mut events = Vec::new();
    let mut dropped = 0;
    for item in raw.get("events").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        if events.len() == MAX_EVENTS {
            dropped += 1;
            continue;
        }
        let spec = item.get("n").and_then(Value::as_str).and_then(|n| EVENTS.iter().find(|(name, _)| *name == n));
        let Some((name, fields)) = spec else {
            dropped += 1;
            continue;
        };
        let at = item.get("at").and_then(|at| at.as_i64().or_else(|| at.as_f64().map(|f| f as i64))).unwrap_or(0);
        let props = item.get("p").and_then(Value::as_object).map(|p| clean_object(fields, p)).unwrap_or_default();
        events.push(Event { name, at, props });
    }
    Ok(Batch {
        sid,
        profile: token(raw.get("profile"), 43..=43),
        client_kind: client_text("kind", 16),
        client_version: client_text("version", 32).unwrap_or_default(),
        probe: raw.get("probe").and_then(Value::as_str).and_then(|p| clean_text(p, 128)),
        events,
        dropped,
    })
}

/// Момент события: часы клиента принимаются от «сутки назад» до «пять минут вперёд», иначе — время службы.
pub fn moment(at_ms: i64, now_ms: i64) -> i64 {
    if (now_ms - DAY_MS..=now_ms + 5 * 60_000).contains(&at_ms) { at_ms } else { now_ms }
}

/// Версия по старшим номерам: `1.4.2` → `1.4`. Не похоже на версию — пусто.
pub fn version_series(version: &str) -> String {
    let mut parts = version.split(['.', '-', '+']);
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) if is_number(major) && is_number(minor) => format!("{major}.{minor}"),
        (Some(major), _) if is_number(major) => major.to_owned(),
        _ => String::new(),
    }
}

fn is_number(text: &str) -> bool {
    !text.is_empty() && text.len() <= 6 && text.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn batch(events: Value) -> Batch {
        parse(json!({"v": 1, "sid": "pX9aaaaaaaaaaaaaaaaaaa", "events": events}).to_string().as_bytes()).unwrap()
    }

    fn one(name: &str, props: Value) -> Event {
        batch(json!([{"n": name, "at": 1_793_612_345_678_i64, "p": props}])).events.remove(0)
    }

    #[test]
    fn a_batch_needs_a_json_object_with_a_session() {
        assert_eq!(parse(b"not json"), Err(BatchError::NotJson));
        assert_eq!(parse(b"[1]"), Err(BatchError::NotJson));
        assert_eq!(parse(b"{}"), Err(BatchError::NoSession));
        assert_eq!(parse(br#"{"sid": "short"}"#), Err(BatchError::NoSession));
        assert_eq!(parse(br#"{"sid": "has spaces and <tags> in it!"}"#), Err(BatchError::NoSession));
        let empty = parse(br#"{"sid": "pX9aaaaaaaaaaaaaaaaaaa"}"#).unwrap();
        assert_eq!((empty.events.len(), empty.profile, empty.client_kind), (0, None, None));
    }

    #[test]
    fn the_envelope_carries_the_profile_the_client_and_the_probe() {
        let parsed = parse(
            json!({
                "v": 1, "sid": "pX9aaaaaaaaaaaaaaaaaaa",
                "profile": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
                "client": {"kind": "web", "version": "1.4.0"},
                "probe": "20261112.abc", "extra": {"ignored": true}, "events": [],
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(parsed.profile.as_deref(), Some("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
        assert_eq!((parsed.client_kind.as_deref(), parsed.client_version.as_str()), (Some("web"), "1.4.0"));
        assert_eq!(parsed.probe.as_deref(), Some("20261112.abc"));
        // Не похоже на секрет профиля — профиля нет, пачка принимается.
        let odd = parse(r#"{"sid": "pX9aaaaaaaaaaaaaaaaaaa", "profile": "короткий"}"#.as_bytes()).unwrap();
        assert_eq!(odd.profile, None);
    }

    #[test]
    fn unknown_events_and_fields_are_dropped_silently() {
        let parsed = batch(json!([
            {"n": "screen", "at": 1, "p": {"name": "home", "secret": "x"}},
            {"n": "made_up", "at": 2, "p": {}},
            "не объект",
            {"n": "invite", "p": {"how": "carrier-pigeon"}},
        ]));
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(parsed.dropped, 2);
        assert_eq!(parsed.events[0].props, json!({"name": "home"}).as_object().unwrap().clone());
        // Чужое слово перечисления — поля нет, событие остаётся; без `at` момент поставит служба.
        assert_eq!((parsed.events[1].name, parsed.events[1].at), ("invite", 0));
        assert!(parsed.events[1].props.is_empty());
    }

    #[test]
    fn no_more_than_50_events_per_batch() {
        let many: Vec<Value> = (0..60).map(|n| json!({"n": "screen", "at": n, "p": {"name": "home"}})).collect();
        let parsed = batch(Value::Array(many));
        assert_eq!((parsed.events.len(), parsed.dropped), (50, 10));
    }

    #[test]
    fn session_start_keeps_only_the_named_signs() {
        let event = one(
            "session_start",
            json!({
                "landing": "invite", "ref": "T.me", "utm": {"source": "tg", "medium": "", "x": 1},
                "lang": "ru-RU", "tz": "Europe/Moscow",
                "screen": {"w": 1920, "h": 1080.0, "dpr": 1.2549, "depth": 24},
                "standalone": false, "wd": true,
                "fp": {"canvas": "c".repeat(100), "gl": "g1", "glr": "ANGLE (NVIDIA)", "hc": 8, "dm": 0.5, "touch": 0, "plat": "Win32", "fonts": 7},
                "url": "https://cord.online/r/secret-room",
            }),
        );
        assert_eq!(event.text("landing"), Some("invite"));
        assert_eq!(event.text("ref"), Some("t.me"));
        assert_eq!(event.object("utm").unwrap(), json!({"source": "tg"}).as_object().unwrap());
        assert_eq!(event.object("screen").unwrap(), json!({"w": 1920, "h": 1080, "dpr": 1.25, "depth": 24}).as_object().unwrap());
        assert!(event.flag("wd") && !event.flag("standalone"));
        let fp = event.object("fp").unwrap();
        assert_eq!(fp["canvas"].as_str().unwrap().len(), 64);
        assert_eq!((fp["hc"].as_i64(), fp["dm"].as_f64()), (Some(8), Some(0.5)));
        assert!(!fp.contains_key("fonts"), "хэш шрифтов — строка, число не принимается");
        assert!(!event.props.contains_key("url"), "адрес страницы в событие не попадает");
    }

    #[test]
    fn a_referrer_is_a_domain_never_a_page_address() {
        assert_eq!(one("session_start", json!({"ref": "https://t.me/joinchat/abc"})).text("ref"), None);
        assert_eq!(one("session_start", json!({"ref": "yandex.ru"})).text("ref"), Some("yandex.ru"));
        assert_eq!(one("session_start", json!({"ref": ""})).text("ref"), None);
    }

    #[test]
    fn strings_are_trimmed_cut_and_free_of_control_characters() {
        let event = one("error", json!({"code": "  NotAllowedError\n", "scope": "device", "detail": "д".repeat(500), "fatal": true}));
        assert_eq!(event.text("code"), Some("NotAllowedError"));
        assert_eq!(event.text("detail").unwrap().chars().count(), 200);
        assert!(event.flag("fatal"));
        assert_eq!(one("error", json!({"code": "X", "scope": "чужая"})).text("scope"), None);
        assert_eq!(clean_text(" \t ", 64), None);
        assert_eq!(clean_text("a\u{0}b\u{7}", 64).as_deref(), Some("ab"));
    }

    #[test]
    fn numbers_are_whole_and_within_limits() {
        let timing = one("join_timing", json!({"ms": 1840.7, "signal_ms": 300, "media_ms": -5, "node": "fra"}));
        assert_eq!((timing.int("ms"), timing.int("signal_ms"), timing.int("media_ms")), (Some(1840), Some(300), None));
        assert_eq!(timing.text("node"), Some("fra"));
        let view = one("integration_view", json!({"room": "r1", "kind": "cinema", "variant": "youtube", "seconds": 30, "stalls": 1, "stall_ms": 900}));
        assert_eq!((view.text("kind"), view.int("seconds"), view.int("stall_ms")), (Some("cinema"), Some(30), Some(900)));
        assert_eq!(one("integration_view", json!({"seconds": 1e12})).int("seconds"), None);
        assert_eq!(one("feature", json!({"name": "chat", "count": "3"})).int("count"), None);
    }

    #[test]
    fn the_client_clock_is_trusted_within_a_day_back_and_five_minutes_ahead() {
        let now = 1_793_612_345_678;
        assert_eq!(moment(now - 1000, now), now - 1000);
        assert_eq!(moment(now - DAY_MS, now), now - DAY_MS);
        assert_eq!(moment(now - DAY_MS - 1, now), now);
        assert_eq!(moment(now + 5 * 60_000, now), now + 5 * 60_000);
        assert_eq!(moment(now + 5 * 60_000 + 1, now), now);
        assert_eq!(moment(0, now), now);
    }

    #[test]
    fn the_version_series_is_the_first_two_numbers() {
        assert_eq!(version_series("1.4.2"), "1.4");
        assert_eq!(version_series("1.4.0-rc1+abc"), "1.4");
        assert_eq!(version_series("2"), "2");
        assert_eq!(version_series("dev"), "");
        assert_eq!(version_series(""), "");
    }
}
