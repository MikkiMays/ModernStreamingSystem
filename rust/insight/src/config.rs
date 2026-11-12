//! Настройки службы из окружения — тех же переменных `.env`, что читает ядро, плюс свои.

use std::path::PathBuf;

use chrono_tz::Tz;

/// Куда подключаться: адрес базы продукта.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Database {
    pub host: String,
    pub port: u16,
    pub name: String,
    pub user: String,
    pub password: String,
}

/// Сроки хранения, дней (§7 проекта).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    /// События и сессии.
    pub events: u64,
    /// Строки «человек × день», встречи, запуски интеграций, ошибки.
    pub rollups: u64,
    /// Люди — от последнего появления.
    pub people: u64,
}

impl Default for Retention {
    fn default() -> Self {
        Retention { events: 90, rollups: 400, people: 400 }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database: Database,
    pub session_secret: String,
    pub internal_secret: String,
    pub probe_key: Option<String>,
    /// Пояс суток аналитики (`ANALYTICS_ZONE`).
    pub zone: Tz,
    /// Отпечаток устройства; `ANALYTICS_FINGERPRINT=false` оставляет только куку и профиль.
    pub fingerprint: bool,
    pub geo_dir: PathBuf,
    pub retention: Retention,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("в окружении нет {0}")]
    Missing(&'static str),
    #[error("{0}: не разобрать значение «{1}»")]
    Invalid(&'static str, String),
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from(|name| std::env::var(name).ok())
    }

    /// Настройки из произвольного источника переменных — так их проверяют тесты.
    pub fn from(get: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let get = |name: &str| get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let required = |name: &'static str| get(name).ok_or(ConfigError::Missing(name));
        fn number<T: std::str::FromStr>(name: &'static str, value: Option<String>, default: T) -> Result<T, ConfigError> {
            match value {
                Some(text) => text.parse().map_err(|_| ConfigError::Invalid(name, text)),
                None => Ok(default),
            }
        }
        let zone = get("ANALYTICS_ZONE").unwrap_or_else(|| "Europe/Moscow".to_owned());
        let defaults = Retention::default();
        Ok(Config {
            port: number("INSIGHT_PORT", get("INSIGHT_PORT"), 18300)?,
            database: database(
                &required("DATABASE_URL")?,
                get("DATABASE_USER").as_deref(),
                get("DATABASE_PASSWORD").as_deref(),
            )?,
            session_secret: required("SESSION_SECRET")?,
            internal_secret: required("INTERNAL_SECRET")?,
            probe_key: get("ANALYTICS_PROBE_KEY"),
            zone: zone.parse().map_err(|_| ConfigError::Invalid("ANALYTICS_ZONE", zone))?,
            fingerprint: !matches!(get("ANALYTICS_FINGERPRINT").as_deref(), Some("false" | "0" | "off" | "no")),
            geo_dir: get("INSIGHT_GEO_DIR").unwrap_or_else(|| "/geo".to_owned()).into(),
            retention: Retention {
                events: number("ANALYTICS_RETENTION_EVENTS", get("ANALYTICS_RETENTION_EVENTS"), defaults.events)?,
                rollups: number("ANALYTICS_RETENTION_ROLLUPS", get("ANALYTICS_RETENTION_ROLLUPS"), defaults.rollups)?,
                people: number("ANALYTICS_RETENTION_PEOPLE", get("ANALYTICS_RETENTION_PEOPLE"), defaults.people)?,
            },
        })
    }
}

/// Адрес базы из `DATABASE_URL`. В `.env` он записан для ядра — `jdbc:postgresql://127.0.0.1:5432/streaming`,
/// имя и пароль лежат отдельно (`DATABASE_USER`, `DATABASE_PASSWORD`). Принимается и обычный адрес
/// `postgres://имя:пароль@узел:порт/база` — так базу называют тесты и CI. Параметры после `?` не читаются.
pub fn database(url: &str, user: Option<&str>, password: Option<&str>) -> Result<Database, ConfigError> {
    let invalid = || ConfigError::Invalid("DATABASE_URL", "адрес базы".to_owned());
    let rest = url.strip_prefix("jdbc:").unwrap_or(url);
    let rest = rest.strip_prefix("postgresql://").or_else(|| rest.strip_prefix("postgres://")).ok_or_else(invalid)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (authority, name) = rest.split_once('/').ok_or_else(invalid)?;
    let (credentials, address) = match authority.rsplit_once('@') {
        Some((credentials, address)) => (Some(credentials), address),
        None => (None, authority),
    };
    let (host, port) = match address.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().map_err(|_| invalid())?),
        None => (address, 5432),
    };
    let (url_user, url_password) = match credentials.map(|c| c.split_once(':').unwrap_or((c, ""))) {
        Some((user, password)) => (Some(user), Some(password)),
        None => (None, None),
    };
    if host.is_empty() || name.is_empty() {
        return Err(invalid());
    }
    Ok(Database {
        host: host.to_owned(),
        port,
        name: name.to_owned(),
        user: url_user.or(user).ok_or(ConfigError::Missing("DATABASE_USER"))?.to_owned(),
        password: url_password.or(password).unwrap_or_default().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
    }

    const BASE: &[(&str, &str)] = &[
        ("DATABASE_URL", "jdbc:postgresql://127.0.0.1:5432/streaming"),
        ("DATABASE_USER", "streaming"),
        ("DATABASE_PASSWORD", "pw"),
        ("SESSION_SECRET", "s"),
        ("INTERNAL_SECRET", "i"),
    ];

    #[test]
    fn the_core_env_is_enough_and_the_rest_has_defaults() {
        let config = Config::from(env(BASE)).unwrap();
        assert_eq!(config.port, 18300);
        assert_eq!(
            config.database,
            Database { host: "127.0.0.1".into(), port: 5432, name: "streaming".into(), user: "streaming".into(), password: "pw".into() }
        );
        assert_eq!(config.zone, chrono_tz::Europe::Moscow);
        assert!(config.fingerprint);
        assert_eq!(config.probe_key, None);
        assert_eq!(config.geo_dir, PathBuf::from("/geo"));
        assert_eq!(config.retention, Retention { events: 90, rollups: 400, people: 400 });
    }

    #[test]
    fn switches_and_terms_come_from_the_environment() {
        let mut pairs = BASE.to_vec();
        pairs.extend([
            ("INSIGHT_PORT", "18301"),
            ("ANALYTICS_ZONE", "Asia/Yekaterinburg"),
            ("ANALYTICS_FINGERPRINT", "false"),
            ("ANALYTICS_PROBE_KEY", " key "),
            ("ANALYTICS_RETENTION_EVENTS", "30"),
            ("ANALYTICS_RETENTION_ROLLUPS", "200"),
            ("ANALYTICS_RETENTION_PEOPLE", "100"),
            ("INSIGHT_GEO_DIR", "/srv/geo"),
        ]);
        let config = Config::from(env(&pairs)).unwrap();
        assert_eq!((config.port, config.fingerprint), (18301, false));
        assert_eq!(config.zone, chrono_tz::Asia::Yekaterinburg);
        assert_eq!(config.probe_key.as_deref(), Some("key"));
        assert_eq!(config.retention, Retention { events: 30, rollups: 200, people: 100 });
        assert_eq!(config.geo_dir, PathBuf::from("/srv/geo"));
    }

    #[test]
    fn a_missing_secret_or_a_bad_value_is_named() {
        assert_eq!(Config::from(env(&BASE[..3])).unwrap_err(), ConfigError::Missing("SESSION_SECRET"));
        assert_eq!(Config::from(env(&BASE[1..])).unwrap_err(), ConfigError::Missing("DATABASE_URL"));
        let mut pairs = BASE.to_vec();
        pairs.push(("ANALYTICS_ZONE", "Mars/Olympus"));
        assert_eq!(
            Config::from(env(&pairs)).unwrap_err(),
            ConfigError::Invalid("ANALYTICS_ZONE", "Mars/Olympus".into())
        );
        pairs.pop();
        pairs.push(("INSIGHT_PORT", "http"));
        assert_eq!(Config::from(env(&pairs)).unwrap_err(), ConfigError::Invalid("INSIGHT_PORT", "http".into()));
    }

    #[test]
    fn the_database_address_is_read_from_jdbc_and_plain_urls() {
        let jdbc = database("jdbc:postgresql://db.internal/streaming?sslmode=disable", Some("u"), Some("p")).unwrap();
        assert_eq!((jdbc.host.as_str(), jdbc.port, jdbc.name.as_str()), ("db.internal", 5432, "streaming"));
        assert_eq!((jdbc.user.as_str(), jdbc.password.as_str()), ("u", "p"));
        // Имя и пароль в самом адресе старше отдельных переменных.
        let plain = database("postgres://postgres:secret@127.0.0.1:54321/test", Some("u"), Some("p")).unwrap();
        assert_eq!((plain.port, plain.user.as_str(), plain.password.as_str()), (54321, "postgres", "secret"));
        assert_eq!(database("mysql://x/y", Some("u"), None).unwrap_err(), ConfigError::Invalid("DATABASE_URL", "адрес базы".into()));
        assert!(database("jdbc:postgresql://127.0.0.1:5432", Some("u"), None).is_err());
        assert_eq!(
            database("jdbc:postgresql://127.0.0.1:5432/streaming", None, None).unwrap_err(),
            ConfigError::Missing("DATABASE_USER")
        );
    }
}
