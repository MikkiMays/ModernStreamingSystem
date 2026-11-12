//! Псевдонимы и ключи (`contracts/insight.md` §4): байт в байт с ядром и службами.
//!
//! Всё, что связывает аналитику с человеком, — HMAC-SHA256 секретом сервера (`SESSION_SECRET`) с меткой
//! назначения, как `Secrets.derive` ядра. Ключ фактов и отчётов — HKDF из `INTERNAL_SECRET`, как
//! `InternalKeys` ядра и `cord_services/keys.py` служб. Общие образцы — в тестах внизу.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Имя куки устройства. Префикс `__Host-` браузер принимает только с `Secure`, `Path=/` и без `Domain`.
pub const DEVICE_COOKIE: &str = "__Host-cord-did";

/// Срок куки устройства — 400 дней (больше браузеры не дают).
pub const DEVICE_COOKIE_MAX_AGE: i64 = 400 * 86_400;

const INTERNAL_SALT: &[u8] = b"cord-internal-secret";

/// HMAC-SHA256.
pub fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    // Ключ HMAC любой длины годен: ошибка здесь невозможна.
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap_or_else(|_| unreachable!());
    mac.update(message);
    mac.finalize().into_bytes().into()
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Сравнение без утечки по времени.
pub fn equal(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Ключ назначения из `INTERNAL_SECRET`: HKDF-SHA256, соль `cord-internal-secret`, 32 байта, base64url.
pub fn internal_key(secret: &str, purpose: &str) -> String {
    let mut okm = [0u8; 32];
    // 32 байта HKDF-SHA256 отдаёт всегда: предел — 255 блоков.
    Hkdf::<Sha256>::new(Some(INTERNAL_SALT), secret.as_bytes())
        .expand(purpose.as_bytes(), &mut okm)
        .unwrap_or_else(|_| unreachable!());
    b64(&okm)
}

/// Устройство из куки: что с ней делать дальше, решает правило личности (§4.5 проекта).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cookie {
    /// Кука пришла, подпись верна.
    Valid(String),
    /// Куки не было или она чужая: выдана новая.
    Issued(String),
}

impl Cookie {
    pub fn id(&self) -> &str {
        match self {
            Cookie::Valid(id) | Cookie::Issued(id) => id,
        }
    }
}

/// Ключи аналитики этой установки.
#[derive(Clone)]
pub struct Keys {
    session: Vec<u8>,
    /// Ключ фактов и отчётов (`X-Insight-Key`).
    pub insight: String,
    internal: String,
    probe: Option<Vec<u8>>,
}

impl Keys {
    pub fn new(session_secret: &str, internal_secret: &str, probe_key: Option<&str>) -> Self {
        Keys {
            session: session_secret.as_bytes().to_vec(),
            insight: internal_key(internal_secret, "insight"),
            internal: internal_secret.to_owned(),
            probe: probe_key.filter(|k| !k.is_empty()).map(|k| k.as_bytes().to_vec()),
        }
    }

    /// `Secrets.derive` ядра: base64url(HMAC-SHA256(SESSION_SECRET, scope)) без `=`.
    pub fn derive(&self, scope: &str) -> String {
        b64(&hmac(&self.session, scope.as_bytes()))
    }

    /// Псевдоним профиля из его секрета — тот же, что ядро шлёт в фактах.
    pub fn profile(&self, secret: &str) -> String {
        self.derive(&format!("analytics:{}", hex::encode(Sha256::digest(secret.as_bytes()))))
    }

    /// Псевдоним встречи: по аналитике встречу не открыть.
    pub fn room(&self, room: &str) -> String {
        self.derive(&format!("analytics-room:{room}"))
    }

    /// Отпечаток устройства из сведённых признаков.
    pub fn fingerprint(&self, features: &str) -> String {
        self.derive(&format!("analytics-fp:{features}"))
    }

    /// Отпечаток подсети (`/24` или `/48` текстом).
    pub fn subnet(&self, subnet: &str) -> String {
        self.derive(&format!("analytics-net:{subnet}"))
    }

    /// Ключ подписи задач «не робот» — свой, не ядра: ответ аналитике не годится для создания встречи.
    pub fn proof_key(&self) -> Vec<u8> {
        self.derive("analytics-proof").into_bytes()
    }

    /// Значение куки устройства для этого `id`: `v1.<id>.<подпись>`.
    pub fn cookie_value(&self, id: &str) -> String {
        let signature = hmac(&self.session, format!("analytics-device:{id}").as_bytes());
        format!("v1.{id}.{}", b64(&signature[..16]))
    }

    /// `id` устройства из куки, если подпись верна. Выдуманная кука — не устройство.
    pub fn cookie_id(&self, value: &str) -> Option<String> {
        let mut parts = value.split('.');
        let (version, id, signature) = (parts.next()?, parts.next()?, parts.next()?);
        if version != "v1" || parts.next().is_some() || id.len() != 22 {
            return None;
        }
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return None;
        }
        let expected = self.cookie_value(id);
        let expected = expected.rsplit('.').next()?;
        equal(signature, expected).then(|| id.to_owned())
    }

    /// Новое устройство: 16 случайных байт.
    pub fn new_device_id() -> String {
        let mut id = [0u8; 16];
        // Без источника случайности служба работать не должна: кука была бы предсказуемой.
        getrandom::fill(&mut id).expect("системный источник случайных чисел недоступен");
        b64(&id)
    }

    /// Строка `Set-Cookie` для устройства.
    pub fn set_cookie(&self, id: &str) -> String {
        format!(
            "{DEVICE_COOKIE}={}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={DEVICE_COOKIE_MAX_AGE}",
            self.cookie_value(id)
        )
    }

    /// Пришёл ли запрос через шлюз: только тогда `X-Real-IP` — правда.
    pub fn is_gateway(&self, header: Option<&str>) -> bool {
        header.is_some_and(|h| equal(h, &self.internal))
    }

    /// Верен ли ключ фактов и отчётов.
    pub fn is_insight(&self, header: Option<&str>) -> bool {
        header.is_some_and(|h| equal(h, &self.insight))
    }

    /// Подпись своих проверок на день `ГГГГММДД` (UTC); без ключа в окружении — `None`.
    pub fn probe(&self, day: &str) -> Option<String> {
        let key = self.probe.as_ref()?;
        Some(format!("{day}.{}", b64(&hmac(key, day.as_bytes()))))
    }

    /// Верна ли подпись своих проверок: принимается сегодняшняя и вчерашняя.
    pub fn is_probe(&self, value: &str, today: chrono::NaiveDate) -> bool {
        [today, today - chrono::Days::new(1)].iter().any(|day| {
            self.probe(&day.format("%Y%m%d").to_string()).is_some_and(|expected| equal(value.trim(), &expected))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERNAL: &str = "a-test-internal-secret-of-32-chars";
    const SESSION: &str = "a-test-session-secret-of-32-chars!";

    fn keys() -> Keys {
        Keys::new(SESSION, INTERNAL, Some("probe-key-for-tests"))
    }

    /// Общий образец с ядром (`InternalKeysTest`) и службами (`services/tests/test_keys.py`).
    #[test]
    fn internal_keys_match_the_core_and_the_services() {
        assert_eq!(internal_key(INTERNAL, "service"), "0VpQEjXyrY1j1PlleKmCpXUw0obr6f_ZvOULDAArni4");
        assert_eq!(internal_key(INTERNAL, "actor"), "qdy2X9k6l9pwl4VXq6QW8L96EYNnB24T_l-5WfS7b4g");
        assert_eq!(internal_key(INTERNAL, "insight"), "G1Fg9MiTfoQ_NdMcnjIMvBvEBHaWkECGQsccswnx-2A");
        assert_eq!(keys().insight, "G1Fg9MiTfoQ_NdMcnjIMvBvEBHaWkECGQsccswnx-2A");
    }

    /// RFC 5869, образец 1 — той же формулой, что ключи назначений.
    #[test]
    fn hkdf_rfc_5869_case_1() {
        let mut okm = [0u8; 42];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        Hkdf::<Sha256>::new(Some(&salt), &[0x0b; 22]).expand(&info, &mut okm).unwrap();
        assert_eq!(
            hex::encode(okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    /// Образцы посчитаны формулой ядра: `Secrets.derive("analytics:" + Secrets.hash(профиль))`
    /// (Python: `hmac.new(SESSION, b"analytics:" + sha256(profile).hexdigest())`, base64url без `=`).
    #[test]
    fn pseudonyms_match_the_core_formula() {
        let keys = keys();
        assert_eq!(
            keys.profile("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"),
            "ylhuoobQQh8eHR8bGXWRHE3ddrl_KLFor9zXY-DQlyU"
        );
        assert_eq!(
            keys.room("3f2c1e9a-7b54-4d1e-9a51-0c2f6f1d8e77"),
            "kBaNn9bNGqabUWZ_8xz86F8EYmHMGn4u46w5jYFp7sk"
        );
        assert_eq!(keys.subnet("203.0.113.0/24"), "14AJHTanaI8H-P_6EUZmU_DlZPB0ID0FuH12uhfeIOg");
        assert_eq!(keys.subnet("2001:db8:abcd::/48"), "xopDuuGQ9k9vZZ7y95Q6LumNdcmkAjvyirkEdtNJTpI");
        assert_eq!(keys.derive("proof"), "XW7npNzQ-dTpTBU2tI5JJNZsKpSMac3kkZfkCxK6t2U");
    }

    #[test]
    fn the_device_cookie_is_signed_and_a_made_up_one_is_not_a_device() {
        let keys = keys();
        let id = "AAECAwQFBgcICQoLDA0ODw";
        let value = keys.cookie_value(id);
        assert_eq!(value, "v1.AAECAwQFBgcICQoLDA0ODw.ownB1DIxI7D5DAnk2309gQ");
        assert_eq!(keys.cookie_id(&value).as_deref(), Some(id));
        // Чужая подпись, чужой id, другая версия, лишняя часть, другой секрет.
        assert_eq!(keys.cookie_id("v1.AAECAwQFBgcICQoLDA0ODw.AAAAAAAAAAAAAAAAAAAAAA"), None);
        assert_eq!(keys.cookie_id("v1.BAECAwQFBgcICQoLDA0ODw.ownB1DIxI7D5DAnk2309gQ"), None);
        assert_eq!(keys.cookie_id("v2.AAECAwQFBgcICQoLDA0ODw.ownB1DIxI7D5DAnk2309gQ"), None);
        assert_eq!(keys.cookie_id(&format!("{value}.x")), None);
        assert_eq!(keys.cookie_id(""), None);
        assert_eq!(Keys::new("another-secret", INTERNAL, None).cookie_id(&value), None);
    }

    #[test]
    fn a_new_device_gets_a_cookie_the_service_accepts_back() {
        let keys = keys();
        let id = Keys::new_device_id();
        assert_eq!(id.len(), 22);
        assert_ne!(id, Keys::new_device_id());
        let header = keys.set_cookie(&id);
        assert!(header.starts_with("__Host-cord-did=v1."));
        assert!(header.ends_with("; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000"));
        let value = header.split(';').next().unwrap().split_once('=').unwrap().1;
        assert_eq!(keys.cookie_id(value), Some(id));
    }

    #[test]
    fn the_probe_signature_is_valid_today_and_yesterday_only() {
        let keys = keys();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
        let signed = "20261112.Z6bTCiwBvff2fFdEbbYtLX_3UlTXUpKh0whB8YeG4JU";
        assert_eq!(keys.probe("20261112").as_deref(), Some(signed));
        assert!(keys.is_probe(signed, today));
        assert!(keys.is_probe(signed, today + chrono::Days::new(1)));
        assert!(!keys.is_probe(signed, today + chrono::Days::new(2)));
        assert!(!keys.is_probe(signed, today - chrono::Days::new(1)));
        assert!(!keys.is_probe("20261112.AAAA", today));
        // Ключа в окружении нет — заголовок не действует.
        let without = Keys::new(SESSION, INTERNAL, None);
        assert!(!without.is_probe(signed, today));
        assert!(!Keys::new(SESSION, INTERNAL, Some("")).is_probe(signed, today));
    }

    #[test]
    fn only_the_right_header_is_the_gateway_or_the_core() {
        let keys = keys();
        assert!(keys.is_gateway(Some(INTERNAL)));
        assert!(!keys.is_gateway(Some("x")));
        assert!(!keys.is_gateway(None));
        assert!(keys.is_insight(Some("G1Fg9MiTfoQ_NdMcnjIMvBvEBHaWkECGQsccswnx-2A")));
        // Сам секрет установки и ключ службы ключом фактов не являются.
        assert!(!keys.is_insight(Some(INTERNAL)));
        assert!(!keys.is_insight(Some("0VpQEjXyrY1j1PlleKmCpXUw0obr6f_ZvOULDAArni4")));
        assert!(!keys.is_insight(None));
    }
}
