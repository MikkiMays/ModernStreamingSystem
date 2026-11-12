//! Общее для тестов с базой: своя база на тест и «браузер», который шлёт пачки так же, как их собирает
//! ручка HTTP.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use cord_insight::config;
use cord_insight::db;
use cord_insight::engine::{CookieHints, Engine, Options, Visit};
use cord_insight::event;
use cord_insight::fact;
use cord_insight::keys::{Cookie, Keys};
use cord_insight::metrics::Metrics;
use cord_insight::net::{self, Network};
use cord_insight::proof::Solved;
use cord_insight::ua;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgPool};

pub const ZONE: Tz = chrono_tz::Europe::Moscow;

pub const CHROME_WINDOWS: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
pub const CHROME_ANDROID: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
#[allow(dead_code)]
pub const SAFARI_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
pub const SAFARI_MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
#[allow(dead_code)]
pub const CORD_DESKTOP: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) cord/1.4.0 Chrome/130.0.6723.59 Electron/33.0.2 Safari/537.36";

/// Момент по UTC: `at("2026-11-12 10:00:00")`.
pub fn at(text: &str) -> DateTime<Utc> {
    format!("{}Z", text.replace(' ', "T")).parse().unwrap()
}

pub fn day(text: &str) -> NaiveDate {
    text.parse().unwrap()
}

/// Идентификатор сессии из короткого имени: контракт требует не меньше 16 знаков.
pub fn sid(name: &str) -> String {
    format!("{name:_<22}")
}

/// Новая пустая база с применёнными миграциями. Сервер — из `DATABASE_URL` (одноразовый PostgreSQL).
pub async fn fresh_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .expect("тестам с базой нужен DATABASE_URL одноразового PostgreSQL");
    let admin = config::database(&url, None, None).unwrap();
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).unwrap();
    let name = format!("t_{}", hex::encode(random));
    let admin_pool = db::pool(&admin);
    sqlx::query(AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&admin_pool)
        .await
        .unwrap();
    admin_pool.close().await;
    let pool = db::pool(&config::Database { name, ..admin });
    db::migrate(&pool).await.unwrap();
    pool
}

pub struct World {
    pub pool: PgPool,
    pub engine: Engine,
    pub keys: Arc<Keys>,
    pub hints: CookieHints,
    pub metrics: Arc<Metrics>,
    pub fingerprint: bool,
}

pub async fn world() -> World {
    World::on(fresh_pool().await, true)
}

impl World {
    pub fn on(pool: PgPool, fingerprint: bool) -> World {
        let keys = Arc::new(Keys::new(
            "a-test-session-secret-of-32-chars!",
            "a-test-internal-secret-of-32-chars",
            None,
        ));
        let hints: CookieHints = Arc::new(Mutex::new(HashMap::new()));
        let metrics = Arc::new(Metrics::default());
        let options = Options {
            zone: ZONE,
            fingerprint,
        };
        let engine = Engine::new(
            pool.clone(),
            keys.clone(),
            options,
            metrics.clone(),
            hints.clone(),
        );
        World {
            pool,
            engine,
            keys,
            hints,
            metrics,
            fingerprint,
        }
    }

    /// Служба перезапустилась: память пуста, база та же.
    pub async fn restart(&mut self, now: DateTime<Utc>) {
        self.flush(now).await;
        let options = Options {
            zone: ZONE,
            fingerprint: self.fingerprint,
        };
        self.engine = Engine::new(
            self.pool.clone(),
            self.keys.clone(),
            options,
            self.metrics.clone(),
            self.hints.clone(),
        );
        self.engine.load(now).await.unwrap();
    }

    pub async fn flush(&mut self, now: DateTime<Utc>) {
        self.engine.flush(now).await.unwrap();
    }

    /// Одно число из базы.
    pub async fn number(&self, sql: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(format!("SELECT v::bigint FROM ({sql}) q(v)")))
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Строки из базы текстом: запрос возвращает один текстовый столбец (`concat_ws('|', …)`).
    pub async fn text(&self, sql: &str) -> String {
        let rows: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
            .fetch_all(&self.pool)
            .await
            .unwrap();
        rows.join("\n")
    }

    /// Факты ядра: `[{type, at, …}]`; `id` ставится по порядку, если не назван.
    pub async fn facts(&mut self, now: DateTime<Utc>, facts: Value) {
        self.facts_from("core", now, facts).await;
    }

    pub async fn facts_from(&mut self, source: &str, now: DateTime<Utc>, facts: Value) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let mut facts = facts.as_array().unwrap().clone();
        for fact in &mut facts {
            let fact = fact.as_object_mut().unwrap();
            if !fact.contains_key("id") {
                let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                fact.insert("id".into(), json!(format!("fact-{id}")));
            }
            if !fact.contains_key("at") {
                fact.insert("at".into(), json!(now.timestamp_millis()));
            }
        }
        let body = json!({"source": source, "facts": facts}).to_string();
        self.engine
            .accept(fact::parse(body.as_bytes()).unwrap(), now)
            .await
            .unwrap();
    }
}

/// Сеть захода: страна, ASN, класс и отпечаток подсети (в тестах — просто слово).
pub fn network(country: &str, asn: u32, class: &'static str, subnet: &str) -> Network {
    Network {
        country: country.to_owned(),
        asn: Some(asn),
        class,
        subnet: subnet.to_owned(),
    }
}

/// Браузер или приложение человека: хранит куку и профиль, как настоящий.
#[derive(Clone)]
pub struct Browser {
    pub agent: &'static str,
    pub client: Option<&'static str>,
    pub version: &'static str,
    pub cookie: Option<String>,
    /// Секрет профиля (43 знака).
    pub profile: Option<String>,
    pub network: Network,
    pub tz: &'static str,
    pub landing: &'static str,
    pub source: &'static str,
    /// Метки кампании: `{source, medium, campaign}` или `null`.
    pub utm: Value,
    pub fp: Value,
    pub webdriver: bool,
    pub probe: bool,
    /// Сколько раз сервер выдал куку заново (узнал по профилю) или продлил её.
    pub reissued: u32,
    pub proofs: u32,
}

impl Browser {
    /// Настольный Chrome на Windows из домашней сети в России; `n` различает людей.
    pub fn desktop(n: u32) -> Browser {
        Browser {
            agent: CHROME_WINDOWS,
            client: Some("web"),
            version: "1.4.0",
            cookie: None,
            profile: Some(profile_secret(n)),
            network: network("RU", 8359, net::HOME, &format!("subnet-{n}")),
            tz: "Europe/Moscow",
            landing: "home",
            source: "",
            utm: Value::Null,
            fp: json!({
                "canvas": format!("canvas-{n}"), "gl": format!("gl-{n}"), "fonts": format!("fonts-{n}"),
                "audio": "audio", "glr": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
                "hc": 8, "dm": 8, "touch": 0, "plat": "Win32",
            }),
            webdriver: false,
            probe: false,
            reissued: 0,
            proofs: 0,
        }
    }

    /// Телефон на Android в мобильной сети: у телефонов одной модели отпечаток общий.
    pub fn phone(n: u32) -> Browser {
        Browser {
            agent: CHROME_ANDROID,
            network: network("RU", 31133, net::MOBILE, "subnet-mobile"),
            fp: json!({"canvas": "pixel8", "gl": "pixel8", "fonts": "pixel8", "audio": "a", "hc": 8, "touch": 5, "plat": "Linux armv81"}),
            ..Browser::desktop(n)
        }
    }

    pub fn pseudonym(&self, world: &World) -> Option<String> {
        self.profile
            .as_ref()
            .map(|secret| world.keys.profile(secret))
    }

    /// Послать пачку событий: `[{"n": "screen", "p": {…}}]`; без `at` — момент отправки.
    pub async fn send(&mut self, world: &mut World, sid: &str, now: DateTime<Utc>, events: Value) {
        self.send_with(world, sid, now, events, None).await;
    }

    async fn send_with(
        &mut self,
        world: &mut World,
        sid: &str,
        now: DateTime<Utc>,
        events: Value,
        proof: Option<Solved>,
    ) {
        let mut events = events.as_array().unwrap().clone();
        for event in &mut events {
            let event = event.as_object_mut().unwrap();
            if !event.contains_key("at") {
                event.insert("at".into(), json!(now.timestamp_millis()));
            }
        }
        let body = json!({"v": 1, "sid": sid, "events": events}).to_string();
        let batch = event::parse(body.as_bytes()).unwrap();
        let cookie = match &self.cookie {
            Some(id) => Cookie::Valid(id.clone()),
            None => {
                // Сервер выдал куку в ответе — браузер её запомнил.
                let id = Keys::new_device_id();
                self.cookie = Some(id.clone());
                Cookie::Issued(id)
            }
        };
        let touch = self
            .fp
            .get("touch")
            .and_then(Value::as_u64)
            .map(|t| t as u32);
        let client = ua::client_kind(self.client, self.agent);
        let visit = Visit {
            now,
            sid: sid.to_owned(),
            profile: self.pseudonym(world),
            cookie,
            agent: ua::agent(self.agent, touch),
            robot: ua::robot(self.agent),
            client,
            client_matches: ua::client_matches(client, self.agent),
            version: self.version.to_owned(),
            network: self.network.clone(),
            probe: self.probe,
            proof,
            events: batch.events,
        };
        world.engine.visit(visit).await;
        // Движок узнал устройство по профилю или продлевает куку: она придёт со следующим ответом.
        if let Some(id) = world.hints.lock().unwrap().remove(sid) {
            self.cookie = Some(id);
            self.reissued += 1;
        }
    }

    /// Открыть страницу: событие `session_start`.
    pub async fn open(&mut self, world: &mut World, sid: &str, now: DateTime<Utc>) {
        let start = json!([{"n": "session_start", "p": {
            "landing": self.landing, "ref": self.source, "utm": self.utm, "lang": "ru-RU", "tz": self.tz,
            "screen": {"w": 1920, "h": 1080, "dpr": 1, "depth": 24}, "wd": self.webdriver, "fp": self.fp,
        }}]);
        self.send(world, sid, now, start).await;
    }

    /// Человек действовал: событие `engaged` с решённой задачей.
    pub async fn engage(&mut self, world: &mut World, sid: &str, now: DateTime<Utc>) {
        self.proofs += 1;
        let proof = Solved {
            signature: format!("proof-{sid}-{}", self.proofs),
            expires_ms: (now + Duration::minutes(5)).timestamp_millis(),
        };
        self.engage_with(world, sid, now, Some(proof)).await;
    }

    pub async fn engage_with(
        &mut self,
        world: &mut World,
        sid: &str,
        now: DateTime<Utc>,
        proof: Option<Solved>,
    ) {
        let event = json!([{"n": "engaged", "p": {"proof": "решение", "ms": 1200}}]);
        self.send_with(world, sid, now, event, proof).await;
    }

    /// Зайти и проявить себя человеком: открыл страницу, через пять секунд действовал.
    pub async fn arrive(&mut self, world: &mut World, sid: &str, now: DateTime<Utc>) {
        self.open(world, sid, now).await;
        self.engage(world, sid, now + Duration::seconds(5)).await;
    }
}

/// Секрет профиля для человека `n`: 43 знака base64url.
pub fn profile_secret(n: u32) -> String {
    format!("{:A>43}", format!("profile{n}"))
}
