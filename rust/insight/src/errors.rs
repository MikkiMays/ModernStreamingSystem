//! Группы ошибок и класс причины (§9 проекта).
//!
//! Каждая ошибка, которую увидел человек (событие `error`) или вернул сервер (факты `join_fail`,
//! `integration_error`, `refusal`), попадает в группу с ключом «код + область + версия» и получает класс
//! причины по таблице правил ниже. Новое правило — новая строка таблицы.

/// Классы причин: что с ошибкой делать.
pub mod cause {
    /// Человек запретил камеру или микрофон: менять текст подсказки, не код.
    pub const PERMISSION: &str = "permission";
    /// Камера занята, не найдена, драйвер.
    pub const DEVICE: &str = "device";
    /// UDP закрыт, обрыв, TURN не помог, долгий сигнал.
    pub const NETWORK: &str = "network";
    /// 5xx, таймаут ядра, узел перегружен.
    pub const SERVER: &str = "server";
    /// Площадка не отдала ролик или недоступна из страны.
    pub const PLATFORM: &str = "platform";
    /// Пределы защиты: слишком много встреч, комната полна, «не робот» не пройдено.
    pub const LIMIT: &str = "limit";
    /// Клиент старше сервера.
    pub const VERSION: &str = "version";
    /// Исключение в коде клиента — и всё, для чего нет правила.
    pub const CRASH: &str = "crash";
}

use cause::{CRASH, DEVICE, LIMIT, NETWORK, PERMISSION, PLATFORM, SERVER, VERSION};

/// Правила: область (`*` — любая), шаблон кода (`*` — любые знаки, регистр не важен), класс причины.
/// Берётся первое совпадение, поэтому точные коды стоят выше общих шаблонов.
const RULES: &[(&str, &str, &str)] = &[
    // ── Разрешение ───────────────────────────────────────────────────────────────────────────────
    ("*", "NotAllowedError", PERMISSION),
    ("*", "PermissionDeniedError", PERMISSION),
    ("*", "PermissionDismissedError", PERMISSION),
    ("*", "PERMISSION_*", PERMISSION),
    // ── Устройство ───────────────────────────────────────────────────────────────────────────────
    ("*", "NotFoundError", DEVICE),
    ("*", "DevicesNotFoundError", DEVICE),
    ("*", "NotReadableError", DEVICE),
    ("*", "TrackStartError", DEVICE),
    ("*", "OverconstrainedError", DEVICE),
    ("*", "DEVICE_*", DEVICE),
    ("device", "AbortError", DEVICE),
    // ── Версия ───────────────────────────────────────────────────────────────────────────────────
    ("update", "*", VERSION),
    ("*", "ChunkLoadError", VERSION),
    ("*", "CLIENT_OUTDATED", VERSION),
    ("*", "VERSION_*", VERSION),
    ("*", "UNKNOWN_COMMAND", VERSION),
    // ── Сервер ───────────────────────────────────────────────────────────────────────────────────
    ("*", "HTTP_5*", SERVER),
    ("*", "SERVER_BUSY", SERVER),
    ("*", "*_UNAVAILABLE", SERVER),
    ("*", "DRAINING", SERVER),
    ("*", "MAINTENANCE*", SERVER),
    ("*", "CLOSED_BY_SERVER", SERVER),
    ("*", "MEDIA_MOVE_BUSY", SERVER),
    ("*", "CORE_TIMEOUT", SERVER),
    // ── Площадка ─────────────────────────────────────────────────────────────────────────────────
    ("*", "CINEMA_*", PLATFORM),
    ("*", "MUSIC_*", PLATFORM),
    ("*", "WATCH_*", PLATFORM),
    ("*", "PLATFORM_BUSY", PLATFORM),
    ("cinema", "MEDIA_ERR_*", PLATFORM),
    ("music", "MEDIA_ERR_*", PLATFORM),
    ("cinema", "HTTP_4*", PLATFORM),
    ("music", "HTTP_4*", PLATFORM),
    // ── Предел ───────────────────────────────────────────────────────────────────────────────────
    ("*", "RATE_LIMITED", LIMIT),
    ("*", "PROOF_INVALID", LIMIT),
    ("*", "BLOCKED", LIMIT),
    ("*", "ROOMS_PER_HOUR", LIMIT),
    ("*", "OPEN_ROOMS", LIMIT),
    ("*", "QUOTA_EXCEEDED", LIMIT),
    ("*", "*_MISSES", LIMIT),
    ("*", "*_FULL", LIMIT),
    ("*", "*_LIMIT", LIMIT),
    ("*", "*_RATE", LIMIT),
    ("*", "*_RATE_IP", LIMIT),
    ("*", "*_QUOTA_IP", LIMIT),
    ("*", "*_BUSY", LIMIT),
    ("*", "HTTP_429", LIMIT),
    // ── Сеть ─────────────────────────────────────────────────────────────────────────────────────
    ("*", "NetworkError", NETWORK),
    ("*", "NETWORK_*", NETWORK),
    ("*", "OFFLINE", NETWORK),
    ("*", "ICE_*", NETWORK),
    ("*", "DTLS_*", NETWORK),
    ("*", "TURN_*", NETWORK),
    ("*", "UDP_*", NETWORK),
    ("*", "WS_*", NETWORK),
    ("*", "WEBSOCKET_*", NETWORK),
    ("*", "SIGNAL_*", NETWORK),
    ("*", "RECONNECT_*", NETWORK),
    ("*", "ConnectionError", NETWORK),
    ("join", "*TIMEOUT", NETWORK),
    ("media", "*TIMEOUT", NETWORK),
    ("media", "AbortError", NETWORK),
];

/// Класс причины по коду и области.
pub fn cause(code: &str, scope: &str) -> &'static str {
    RULES
        .iter()
        .find(|(rule_scope, pattern, _)| (*rule_scope == "*" || *rule_scope == scope) && glob(pattern, code))
        .map_or(CRASH, |(_, _, cause)| cause)
}

/// Совпадение с шаблоном, где `*` — любые знаки; регистр не важен.
fn glob(pattern: &str, text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = text.strip_prefix(first) else { return false };
    let mut parts: Vec<&str> = parts.collect();
    let Some(last) = parts.pop() else { return rest.is_empty() };
    for part in parts {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// Код ошибки для ключа группы: буквы, цифры и `_ . : -`, остальное — `_`.
pub fn clean_code(code: &str) -> String {
    let cleaned: String = code
        .trim()
        .chars()
        .take(64)
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') { c } else { '_' })
        .collect();
    if cleaned.is_empty() { "UNKNOWN".to_owned() } else { cleaned }
}

/// Ключ группы: код + область + версия. Годится частью адреса отчёта (`errors/{key}`).
/// Версия клиента — по старшим номерам (`1.4`); у фактов ядра и служб на её месте их имя.
pub fn key(code: &str, scope: &str, version: &str) -> String {
    let part = |text: &str| if text.is_empty() { "-".to_owned() } else { clean_code(text) };
    format!("{}~{}~{}", clean_code(code), part(scope), part(version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_cause_class_has_a_rule_that_leads_to_it() {
        for (code, scope, expected) in [
            // Человек запретил камеру.
            ("NotAllowedError", "device", PERMISSION),
            ("PERMISSION_DENIED", "media", PERMISSION),
            // Камера занята или не найдена.
            ("NotReadableError", "device", DEVICE),
            ("NotFoundError", "device", DEVICE),
            ("OverconstrainedError", "media", DEVICE),
            ("AbortError", "device", DEVICE),
            // UDP закрыт, обрыв, долгий сигнал.
            ("ICE_FAILED", "media", NETWORK),
            ("SIGNAL_TIMEOUT", "join", NETWORK),
            ("WS_CLOSED", "join", NETWORK),
            ("JOIN_TIMEOUT", "join", NETWORK),
            ("AbortError", "media", NETWORK),
            // 5xx, узел перегружен.
            ("HTTP_503", "join", SERVER),
            ("SERVER_BUSY", "join", SERVER),
            ("NODE_UNAVAILABLE", "join", SERVER),
            ("MEDIA_UNAVAILABLE", "media", SERVER),
            ("MAINTENANCE_WINDOW", "app", SERVER),
            // Площадка не отдала ролик.
            ("CINEMA_GEO", "cinema", PLATFORM),
            ("MUSIC_UNREACHABLE", "music", PLATFORM),
            ("WATCH_INVALID", "cinema", PLATFORM),
            ("MEDIA_ERR_SRC_NOT_SUPPORTED", "cinema", PLATFORM),
            // Пределы защиты.
            ("ROOM_FULL", "join", LIMIT),
            ("ROOMS_PER_HOUR", "join", LIMIT),
            ("PROOF_INVALID", "join", LIMIT),
            ("RATE_LIMITED", "app", LIMIT),
            ("CODE_MISSES", "join", LIMIT),
            ("CHAT_RATE_IP", "chat", LIMIT),
            ("SCREEN_LIMIT", "media", LIMIT),
            ("INTEGRATION_BUSY", "cinema", LIMIT),
            // Клиент старше сервера.
            ("ChunkLoadError", "app", VERSION),
            ("ANYTHING", "update", VERSION),
            ("UNKNOWN_COMMAND", "app", VERSION),
            // Исключение в коде клиента и всё незнакомое.
            ("TypeError", "app", CRASH),
            ("RangeError", "game", CRASH),
            ("CHESS_ILLEGAL", "game", CRASH),
            ("", "", CRASH),
        ] {
            assert_eq!(cause(code, scope), expected, "{code} / {scope}");
        }
    }

    #[test]
    fn exact_rules_win_over_patterns_and_case_does_not_matter() {
        // `MEDIA_MOVE_BUSY` — узел занят переездом (сервер), а не предел, хотя кончается на `_BUSY`.
        assert_eq!(cause("MEDIA_MOVE_BUSY", "media"), SERVER);
        // `PLATFORM_BUSY` — площадка, не предел.
        assert_eq!(cause("PLATFORM_BUSY", "cinema"), PLATFORM);
        // `MUSIC_TIMEOUT` — площадка, хотя таймаут.
        assert_eq!(cause("MUSIC_TIMEOUT", "music"), PLATFORM);
        assert_eq!(cause("notallowederror", "device"), PERMISSION);
        assert_eq!(cause("room_full", "join"), LIMIT);
    }

    #[test]
    fn glob_matches_stars_anywhere() {
        assert!(glob("*", ""));
        assert!(glob("*", "x"));
        assert!(glob("A*", "abc"));
        assert!(glob("*C", "abc"));
        assert!(glob("a*c", "abc"));
        assert!(glob("a*b*c", "a-b-c"));
        assert!(glob("abc", "ABC"));
        assert!(!glob("abc", "abcd"));
        assert!(!glob("a*c", "abd"));
        assert!(!glob("*_FULL", "FULL"));
        assert!(!glob("HTTP_5*", "HTTP_404"));
    }

    #[test]
    fn the_group_key_is_code_scope_and_version_and_is_safe_in_a_path() {
        assert_eq!(key("ROOM_FULL", "join", "1.4"), "ROOM_FULL~join~1.4");
        assert_eq!(key("TypeError", "app", ""), "TypeError~app~-");
        assert_eq!(key("PROOF_INVALID", "guard", "core"), "PROOF_INVALID~guard~core");
        assert_eq!(key("a b/c?d", "", ""), "a_b_c_d~-~-");
        assert_eq!(key("", "app", "1.4"), "UNKNOWN~app~1.4");
        assert!(key(&"x".repeat(500), "app", "1.4").len() <= 64 + 1 + 3 + 1 + 3);
    }
}
