//! Что аналитика берёт из адреса запроса (§4.4 проекта, Р-139): страну, ASN, класс сети и необратимый
//! отпечаток подсети. Сам адрес дальше этого модуля не уходит — ни в базу, ни в журнал.
//!
//! Базы — DB-IP Lite в формате MMDB (`infra/geo/README.md`), каталог `/geo`. Нет файлов — страна и сеть
//! «неизвестно», служба работает. Файлы перечитываются, когда меняются (`Geo::refresh`).

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::SystemTime;

use chrono::{DateTime, Datelike, NaiveDate, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;

use crate::keys::Keys;

/// Класс сети: `home` | `mobile` | `hosting` | `unknown`.
pub const HOME: &str = "home";
pub const MOBILE: &str = "mobile";
pub const HOSTING: &str = "hosting";
pub const UNKNOWN: &str = "unknown";

const COUNTRY_FILE: &str = "dbip-country-lite.mmdb";
const ASN_FILE: &str = "dbip-asn-lite.mmdb";
const HOSTING_FILE: &str = "hosting-asn.txt";
const MOBILE_FILE: &str = "mobile-asn.txt";

/// Что известно о сети захода.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Network {
    /// Код страны ISO 3166-1 или пусто.
    pub country: String,
    pub asn: Option<u32>,
    pub class: &'static str,
    /// `HMAC(секрет, /24 или /48)`.
    pub subnet: String,
}

impl Network {
    /// Адреса нет (запрос не через шлюз): сеть неизвестна.
    pub fn unknown() -> Self {
        Network { country: String::new(), asn: None, class: UNKNOWN, subnet: String::new() }
    }
}

/// Адрес из текста заголовка или сокета; мусор — не адрес.
pub fn parse_ip(text: &str) -> Option<IpAddr> {
    let ip: IpAddr = text.trim().parse().ok()?;
    // Адрес IPv4, записанный как IPv6 (`::ffff:203.0.113.7`), — это IPv4.
    Some(match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    })
}

/// Ключ пределов и задачи «не робот»: IPv4 — как есть, IPv6 — сеть /64, как `ClientAddress.network` ядра
/// (провайдер выдаёт абоненту целую /64).
pub fn address_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

/// Подсеть для отпечатка: /24 у IPv4, /48 у IPv6.
pub fn subnet(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.0/24", o[0], o[1], o[2])
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}::/48", s[0], s[1], s[2])
        }
    }
}

#[derive(Deserialize)]
struct CountryRecord {
    country: Option<CountryCode>,
}

#[derive(Deserialize)]
struct CountryCode {
    iso_code: Option<String>,
}

#[derive(Deserialize)]
struct AsnRecord {
    autonomous_system_number: Option<u32>,
}

#[derive(Default)]
struct Loaded {
    country: Option<maxminddb::Reader<Vec<u8>>>,
    asn: Option<maxminddb::Reader<Vec<u8>>>,
    hosting: HashSet<u32>,
    mobile: HashSet<u32>,
    /// Время изменения каждого файла: по нему видно, что файл обновили.
    stamps: Vec<Option<SystemTime>>,
}

/// Базы адресов этой машины.
pub struct Geo {
    dir: PathBuf,
    loaded: RwLock<Arc<Loaded>>,
}

impl Geo {
    /// Базы из каталога `dir`; без каталога или файлов — пустые.
    pub fn open(dir: impl Into<PathBuf>) -> Self {
        let geo = Geo { dir: dir.into(), loaded: RwLock::new(Arc::new(Loaded::default())) };
        geo.refresh();
        geo
    }

    /// Без баз: всё «неизвестно».
    pub fn empty() -> Self {
        Geo { dir: PathBuf::new(), loaded: RwLock::new(Arc::new(Loaded::default())) }
    }

    fn files(&self) -> [PathBuf; 4] {
        [COUNTRY_FILE, ASN_FILE, HOSTING_FILE, MOBILE_FILE].map(|name| self.dir.join(name))
    }

    /// Перечитать файлы, если хоть один изменился. Зовётся при запуске и раз в минуту.
    /// Возвращает, были ли базы перечитаны.
    pub fn refresh(&self) -> bool {
        if self.dir.as_os_str().is_empty() {
            return false;
        }
        let files = self.files();
        let stamps: Vec<_> = files.iter().map(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok()).collect();
        if self.current().stamps == stamps {
            return false;
        }
        let reader = |path: &Path| match maxminddb::Reader::open_readfile(path) {
            Ok(reader) => Some(reader),
            Err(error) => {
                if path.exists() {
                    tracing::warn!(file = %path.display(), %error, "база адресов не читается");
                }
                None
            }
        };
        let loaded = Loaded {
            country: reader(&files[0]),
            asn: reader(&files[1]),
            hosting: asn_list(&files[2]),
            mobile: asn_list(&files[3]),
            stamps,
        };
        tracing::info!(
            country = loaded.country.is_some(),
            asn = loaded.asn.is_some(),
            hosting = loaded.hosting.len(),
            mobile = loaded.mobile.len(),
            "базы адресов прочитаны"
        );
        *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(loaded);
        true
    }

    fn current(&self) -> Arc<Loaded> {
        self.loaded.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Есть ли база стран и база ASN — для `/healthz` и метрик.
    pub fn status(&self) -> (bool, bool) {
        let loaded = self.current();
        (loaded.country.is_some(), loaded.asn.is_some())
    }

    /// Страна, ASN, класс сети и отпечаток подсети адреса.
    pub fn network(&self, ip: IpAddr, keys: &Keys) -> Network {
        let loaded = self.current();
        let country = loaded
            .country
            .as_ref()
            .and_then(|db| db.lookup(ip).ok()?.decode::<CountryRecord>().ok()?)
            .and_then(|record| record.country?.iso_code)
            .filter(|code| code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase()))
            .unwrap_or_default();
        let asn = loaded
            .asn
            .as_ref()
            .and_then(|db| db.lookup(ip).ok()?.decode::<AsnRecord>().ok()?)
            .and_then(|record| record.autonomous_system_number);
        let class = match asn {
            Some(n) if loaded.hosting.contains(&n) => HOSTING,
            Some(n) if loaded.mobile.contains(&n) => MOBILE,
            Some(_) => HOME,
            None => UNKNOWN,
        };
        Network { country, asn, class, subnet: keys.subnet(&subnet(ip)) }
    }
}

/// Список ASN из текста: строка — `AS12345` или `12345`, дальше что угодно; `#` — комментарий.
fn asn_list(path: &Path) -> HashSet<u32> {
    std::fs::read_to_string(path).map(|text| parse_asn_list(&text)).unwrap_or_default()
}

fn parse_asn_list(text: &str) -> HashSet<u32> {
    text.lines()
        .filter_map(|line| {
            let word = line.split('#').next()?.split_whitespace().next()?;
            let digits = word.strip_prefix("AS").or_else(|| word.strip_prefix("as")).unwrap_or(word);
            digits.parse().ok()
        })
        .collect()
}

/// Страна → её пояса (`data/zones.tab`, из tzdata).
static ZONES: LazyLock<HashMap<&'static str, Vec<Tz>>> = LazyLock::new(|| {
    let mut zones: HashMap<&'static str, Vec<Tz>> = HashMap::new();
    for line in include_str!("../data/zones.tab").lines().filter(|l| !l.starts_with('#')) {
        let Some((countries, zone)) = line.split_once('\t') else { continue };
        let Ok(zone) = zone.trim().parse::<Tz>() else { continue };
        for country in countries.split(',') {
            zones.entry(country).or_default().push(zone);
        }
    }
    zones
});

/// Смещения пояса от UTC зимой и летом года `now` — по ним сравниваются пояса.
fn offsets(zone: Tz, now: DateTime<Utc>) -> (i32, i32) {
    let at = |month: u32| {
        let day = NaiveDate::from_ymd_opt(now.year(), month, 15).unwrap_or_default().and_hms_opt(12, 0, 0);
        day.map_or(0, |moment| zone.offset_from_utc_datetime(&moment).fix().local_minus_utc())
    };
    (at(1), at(7))
}

/// Встречается ли пояс браузера в стране адреса. Пояса сравниваются по смещению зимой и летом, а не по
/// имени: у одного пояса несколько имён (`Europe/Kiev` и `Europe/Kyiv`, `Asia/Calcutta` и `Asia/Kolkata`),
/// и браузеры называют их по-разному. `None` — судить не по чему: пояс или страна неизвестны.
pub fn zone_in_country(zone: &str, country: &str, now: DateTime<Utc>) -> Option<bool> {
    let zone: Tz = zone.parse().ok()?;
    let local = ZONES.get(country)?;
    let wanted = offsets(zone, now);
    Some(local.iter().any(|z| offsets(*z, now) == wanted))
}

/// VPN или прокси — вероятно: сеть хостинга либо пояс браузера не встречается в стране адреса.
pub fn vpn_likely(network: &Network, zone: Option<&str>, now: DateTime<Utc>) -> bool {
    network.class == HOSTING
        || zone.is_some_and(|zone| zone_in_country(zone, &network.country, now) == Some(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 12, 12, 0, 0).unwrap()
    }

    #[test]
    fn the_address_key_is_the_address_or_the_64_network_like_the_core() {
        assert_eq!(address_key(parse_ip("203.0.113.7").unwrap()), "203.0.113.7");
        assert_eq!(address_key(parse_ip(" 2001:db8:0:1:aaaa:bbbb:cccc:dddd ").unwrap()), "2001:db8:0:1::/64");
        assert_eq!(address_key(parse_ip("::ffff:203.0.113.7").unwrap()), "203.0.113.7");
        assert_eq!(parse_ip("не адрес"), None);
        assert_eq!(parse_ip(""), None);
    }

    #[test]
    fn the_subnet_is_24_or_48() {
        assert_eq!(subnet(parse_ip("203.0.113.77").unwrap()), "203.0.113.0/24");
        assert_eq!(subnet(parse_ip("2001:db8:abcd:1234::1").unwrap()), "2001:db8:abcd::/48");
        // Соседи по подсети дают один отпечаток, другая подсеть — другой.
        let keys = Keys::new("s", "i", None);
        let net = |ip: &str| Geo::empty().network(parse_ip(ip).unwrap(), &keys).subnet;
        assert_eq!(net("203.0.113.1"), net("203.0.113.254"));
        assert_ne!(net("203.0.113.1"), net("203.0.114.1"));
    }

    #[test]
    fn without_the_databases_the_network_is_unknown_and_nothing_fails() {
        let keys = Keys::new("s", "i", None);
        let geo = Geo::open("/nonexistent/geo");
        let network = geo.network(parse_ip("203.0.113.7").unwrap(), &keys);
        assert_eq!((network.country.as_str(), network.asn, network.class), ("", None, UNKNOWN));
        assert_eq!(geo.status(), (false, false));
        assert!(!geo.refresh());
        assert!(!vpn_likely(&network, Some("Europe/Moscow"), now()));
    }

    #[test]
    fn asn_lists_are_plain_text_with_comments() {
        let list = parse_asn_list("# хостеры\nAS16509 # Amazon\n14061\nas24940\n\nмусор\nAS-SET\n");
        assert_eq!(list, HashSet::from([16509, 14061, 24940]));
    }

    #[test]
    fn a_browser_zone_is_compared_with_the_zones_of_the_country() {
        let now = now();
        assert_eq!(zone_in_country("Europe/Moscow", "RU", now), Some(true));
        assert_eq!(zone_in_country("Asia/Yekaterinburg", "RU", now), Some(true));
        assert_eq!(zone_in_country("Europe/Moscow", "NL", now), Some(false));
        assert_eq!(zone_in_country("America/New_York", "RU", now), Some(false));
        // Старое и новое имя одного пояса.
        assert_eq!(zone_in_country("Europe/Kiev", "UA", now), Some(true));
        assert_eq!(zone_in_country("Asia/Calcutta", "IN", now), Some(true));
        // Страна без своей строки в таблице поясов живёт по соседскому поясу.
        assert_eq!(zone_in_country("Asia/Dubai", "OM", now), Some(true));
        assert_eq!(zone_in_country("Что/Это", "RU", now), None);
        assert_eq!(zone_in_country("Europe/Moscow", "", now), None);
    }

    #[test]
    fn vpn_is_likely_on_hosting_or_when_the_zone_is_foreign_to_the_country() {
        let now = now();
        let network = |country: &str, class| Network { country: country.into(), asn: Some(1), class, subnet: String::new() };
        assert!(vpn_likely(&network("RU", HOSTING), Some("Europe/Moscow"), now));
        assert!(vpn_likely(&network("NL", HOME), Some("Europe/Moscow"), now));
        assert!(!vpn_likely(&network("RU", HOME), Some("Europe/Moscow"), now));
        assert!(!vpn_likely(&network("RU", MOBILE), None, now));
        // Неизвестная страна — не признак VPN.
        assert!(!vpn_likely(&network("", UNKNOWN), Some("Europe/Moscow"), now));
    }
}
