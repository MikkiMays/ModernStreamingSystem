//! Факты ядра и служб (`contracts/insight.md` §2): то, что случилось на самом деле.

use serde_json::{Map, Value};

use crate::event::clean_text;

/// Больше фактов в пачке не принимается.
pub const MAX_FACTS: usize = 500;

/// Типы фактов контракта.
pub const TYPES: &[&str] = &[
    "join",
    "join_fail",
    "media_up",
    "media_down",
    "presence",
    "meeting_open",
    "meeting_close",
    "quality",
    "integration_open",
    "integration_close",
    "integration_error",
    "usage",
    "node_move",
    "refusal",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Fact {
    pub id: String,
    /// Мс эпохи по часам отправителя.
    pub at: i64,
    pub name: &'static str,
    fields: Map<String, Value>,
}

impl Fact {
    /// Строка факта: машинный текст до 64 знаков; `null` и пустая — нет поля.
    pub fn text(&self, key: &str) -> Option<String> {
        clean_text(self.fields.get(key)?.as_str()?, 64)
    }

    /// Строка или пусто.
    pub fn word(&self, key: &str) -> String {
        self.text(key).unwrap_or_default()
    }

    /// Неотрицательное целое; дробное округляется.
    pub fn int(&self, key: &str) -> i64 {
        self.num(key).round() as i64
    }

    /// Неотрицательное число.
    pub fn num(&self, key: &str) -> f64 {
        self.fields.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(0.0)
    }

    pub fn flag(&self, key: &str) -> bool {
        self.fields.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// Участники на связи из факта `presence`: `(участник, псевдоним профиля)`.
    pub fn members(&self) -> Vec<(String, Option<String>)> {
        let members = self.fields.get("members").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        members
            .iter()
            .filter_map(|m| {
                let text = |key: &str| m.get(key).and_then(Value::as_str).and_then(|t| clean_text(t, 64));
                Some((text("member")?, text("profile")))
            })
            .collect()
    }
}

/// Пачка фактов: кто прислал и что.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    /// `core` или `services`.
    pub source: String,
    pub facts: Vec<Fact>,
    /// Сколько фактов отброшено: нет `id`, незнакомый тип, сверх предела.
    pub dropped: usize,
}

/// Разобрать тело `POST /internal/facts`. `None` — не JSON-объект.
pub fn parse(body: &[u8]) -> Option<Facts> {
    let raw: Value = serde_json::from_slice(body).ok()?;
    let raw = raw.as_object()?;
    let source = raw.get("source").and_then(Value::as_str).and_then(|s| clean_text(s, 16)).unwrap_or_default();
    let mut facts = Vec::new();
    let mut dropped = 0;
    for item in raw.get("facts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let parsed = (|| {
            let fields = item.as_object()?;
            let id = clean_text(fields.get("id")?.as_str()?, 64)?;
            let kind = fields.get("type")?.as_str()?;
            let name = TYPES.iter().find(|t| **t == kind)?;
            let at = fields.get("at").and_then(|at| at.as_i64().or_else(|| at.as_f64().map(|f| f as i64)))?;
            Some(Fact { id, at, name, fields: fields.clone() })
        })();
        match parsed {
            Some(fact) if facts.len() < MAX_FACTS => facts.push(fact),
            _ => dropped += 1,
        }
    }
    Some(Facts { source, facts, dropped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn facts_are_read_leniently_and_unknown_ones_are_dropped() {
        let body = json!({
            "source": "core",
            "facts": [
                {"id": "a", "at": 1_793_612_345_678_i64, "type": "join", "room": "r", "profile": null, "how": "link", "node": "fra"},
                {"id": "b", "at": 1, "type": "made_up"},
                {"at": 1, "type": "join"},
                {"id": "c", "at": 2.0, "type": "quality", "mic_s": 9.6, "bytes_up": 1e9, "loss": 0.013, "relay": true, "freezes": -1},
                {"id": "d", "at": 3, "type": "presence", "members": [{"member": "m1", "profile": "p1"}, {"member": "m2", "profile": null}, {"profile": "p3"}]},
            ],
        });
        let parsed = parse(body.to_string().as_bytes()).unwrap();
        assert_eq!((parsed.source.as_str(), parsed.facts.len(), parsed.dropped), ("core", 3, 2));
        let join = &parsed.facts[0];
        assert_eq!((join.name, join.at, join.text("room").as_deref()), ("join", 1_793_612_345_678, Some("r")));
        assert_eq!((join.text("profile"), join.word("how"), join.word("нет")), (None, "link".to_owned(), String::new()));
        let quality = &parsed.facts[1];
        assert_eq!((quality.at, quality.int("mic_s"), quality.int("bytes_up")), (2, 10, 1_000_000_000));
        assert_eq!((quality.num("loss"), quality.flag("relay"), quality.int("freezes")), (0.013, true, 0));
        assert_eq!(parsed.facts[2].members(), vec![("m1".to_owned(), Some("p1".to_owned())), ("m2".to_owned(), None)]);
    }

    #[test]
    fn a_body_that_is_not_an_object_is_refused_and_a_long_batch_is_cut() {
        assert_eq!(parse(b"[]"), None);
        assert_eq!(parse(b"oops"), None);
        let many: Vec<Value> = (0..510).map(|n| json!({"id": format!("f{n}"), "at": n, "type": "refusal"})).collect();
        let parsed = parse(json!({"source": "core", "facts": many}).to_string().as_bytes()).unwrap();
        assert_eq!((parsed.facts.len(), parsed.dropped), (500, 10));
    }
}
