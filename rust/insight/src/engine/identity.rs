//! Какой человек у сессии (§4.5 проекта).
//!
//! ```text
//! 1. кука верна и устройство известно   → это устройство (незнакомый профиль привязать)
//! 2. иначе профиль известен             → его устройство (куку выдать заново)
//! 3. иначе устройство новое; человек —
//!    3а. настольное, сила отпечатка ≥ 2, тот же отпечаток у устройства, виденного за 45 дней, того же вида
//!        клиента и семейства ОС, не активного прямо сейчас, и совпало хотя бы одно:
//!        отпечаток подсети · ASN · (страна и пояс)   → тот же человек, связь «по отпечатку»
//!    3б. иначе                                       → новый человек
//! ```
//!
//! Шаги 1 и 2 — точные и от адреса не зависят. Шаг 3а — вероятностный и только для настольных устройств:
//! у телефонов одной модели отпечатки совпадают, а адрес за мобильной сетью общий на тысячи людей.

/// Сколько дней назад могли видеть устройство, чтобы узнать его по отпечатку.
pub const FINGERPRINT_DAYS: i64 = 45;
/// Сколько признаков высокой силы нужно отпечатку.
pub const FINGERPRINT_STRENGTH: i16 = 2;

/// Как узнали человека.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Cookie,
    Profile,
    Fingerprint,
    New,
}

impl Via {
    pub fn word(self) -> &'static str {
        match self {
            Via::Cookie => "cookie",
            Via::Profile => "profile",
            Via::Fingerprint => "fingerprint",
            Via::New => "new",
        }
    }
}

/// Откуда пришла сессия — то, с чем сравнивается прежнее устройство в шаге 3а.
#[derive(Debug, Clone, Default)]
pub struct Origin {
    pub device_class: String,
    pub fp_strength: i16,
    /// Отпечаток подсети.
    pub net: String,
    pub asn: Option<i64>,
    pub country: String,
    pub tz: String,
}

/// Прежнее устройство с тем же отпечатком, видом клиента и семейством ОС, виденное за 45 дней.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Candidate {
    pub device: String,
    /// Человек устройства — тот, к кому привяжется новый (корень склейки).
    pub person: i64,
    pub net: String,
    pub asn: Option<i64>,
    pub country: String,
    pub tz: String,
    /// Устройство на связи прямо сейчас: два одинаковых компьютера в одном офисе — не один человек.
    pub active: bool,
}

/// Шаг 3а: прежнее устройство, чей человек — тот же. Кандидаты идут от недавних к давним.
pub fn fingerprint_match<'a>(origin: &Origin, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    if origin.device_class != "desktop" || origin.fp_strength < FINGERPRINT_STRENGTH {
        return None;
    }
    candidates.iter().find(|c| {
        let same_net = !origin.net.is_empty() && origin.net == c.net;
        let same_asn = origin.asn.is_some() && origin.asn == c.asn;
        let same_place =
            !origin.country.is_empty() && !origin.tz.is_empty() && origin.country == c.country && origin.tz == c.tz;
        !c.active && (same_net || same_asn || same_place)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Origin {
        Origin {
            device_class: "desktop".into(),
            fp_strength: 3,
            net: "net-a".into(),
            asn: Some(8359),
            country: "RU".into(),
            tz: "Europe/Moscow".into(),
        }
    }

    fn candidate() -> Candidate {
        Candidate {
            device: "d1".into(),
            person: 7,
            net: "net-a".into(),
            asn: Some(8359),
            country: "RU".into(),
            tz: "Europe/Moscow".into(),
            active: false,
        }
    }

    #[test]
    fn a_desktop_with_a_strong_fingerprint_seen_from_the_same_network_is_the_same_person() {
        assert_eq!(fingerprint_match(&origin(), &[candidate()]).map(|c| c.person), Some(7));
    }

    #[test]
    fn any_one_of_subnet_asn_or_country_with_zone_is_enough() {
        let elsewhere = Candidate { net: "net-b".into(), asn: Some(1), country: "DE".into(), tz: "Europe/Berlin".into(), ..candidate() };
        assert_eq!(fingerprint_match(&origin(), std::slice::from_ref(&elsewhere)), None);
        for same in [
            Candidate { net: "net-a".into(), ..elsewhere.clone() },
            Candidate { asn: Some(8359), ..elsewhere.clone() },
            Candidate { country: "RU".into(), tz: "Europe/Moscow".into(), ..elsewhere.clone() },
        ] {
            assert!(fingerprint_match(&origin(), &[same]).is_some());
        }
        // Страна без пояса и пояс без страны — не совпадение.
        let country_only = Candidate { country: "RU".into(), ..elsewhere.clone() };
        let zone_only = Candidate { tz: "Europe/Moscow".into(), ..elsewhere };
        assert_eq!(fingerprint_match(&origin(), &[country_only, zone_only]), None);
    }

    #[test]
    fn unknown_network_matches_nothing() {
        // Без баз адресов и без шлюза у обоих пусто: пустое с пустым — не «та же сеть».
        let blank = Origin { net: String::new(), asn: None, country: String::new(), tz: String::new(), ..origin() };
        let unknown = Candidate { net: String::new(), asn: None, country: String::new(), tz: String::new(), ..candidate() };
        assert_eq!(fingerprint_match(&blank, &[unknown]), None);
    }

    #[test]
    fn phones_tablets_and_tvs_are_never_merged_by_fingerprint() {
        for class in ["phone", "tablet", "tv"] {
            let mobile = Origin { device_class: class.into(), ..origin() };
            assert_eq!(fingerprint_match(&mobile, &[candidate()]), None, "{class}");
        }
    }

    #[test]
    fn a_weak_fingerprint_is_not_enough() {
        for strength in [0, 1] {
            assert_eq!(fingerprint_match(&Origin { fp_strength: strength, ..origin() }, &[candidate()]), None);
        }
        assert!(fingerprint_match(&Origin { fp_strength: 2, ..origin() }, &[candidate()]).is_some());
    }

    #[test]
    fn two_identical_office_computers_online_at_once_are_not_merged() {
        let online = Candidate { active: true, ..candidate() };
        assert_eq!(fingerprint_match(&origin(), std::slice::from_ref(&online)), None);
        // Тот, что на связи, пропускается; узнаётся прежнее устройство, которое сейчас молчит.
        let silent = Candidate { device: "d0".into(), person: 3, ..candidate() };
        assert_eq!(fingerprint_match(&origin(), &[online, silent]).map(|c| c.person), Some(3));
    }

    #[test]
    fn the_most_recent_candidate_wins() {
        let recent = Candidate { device: "new".into(), person: 9, ..candidate() };
        assert_eq!(fingerprint_match(&origin(), &[recent, candidate()]).map(|c| c.person), Some(9));
    }
}
