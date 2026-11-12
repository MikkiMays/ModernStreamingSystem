//! Ручки службы: коды ответов, кука устройства, пределы, ключ фактов и отчётов — и весь путь от события до
//! отчёта через HTTP.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use chrono::Utc;
use cord_insight::engine::{self, CookieHints, Engine, Options};
use cord_insight::http::{self, App};
use cord_insight::keys::Keys;
use cord_insight::metrics::Metrics;
use cord_insight::net::Geo;
use cord_insight::proof;
use cord_insight::reports::Reports;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::task::JoinHandle;
use tower::ServiceExt;

use crate::common::*;

const INTERNAL: &str = "a-test-internal-secret-of-32-chars";
const SESSION: &str = "a-test-session-secret-of-32-chars!";
/// Ключ фактов и отчётов для `INTERNAL` — общий образец с `keys.rs`.
const INSIGHT_KEY: &str = "G1Fg9MiTfoQ_NdMcnjIMvBvEBHaWkECGQsccswnx-2A";

/// Служба целиком: ручки и движок на своей базе.
struct Service {
    router: Router,
    pool: PgPool,
    keys: Arc<Keys>,
    engine: JoinHandle<()>,
}

async fn service() -> Service {
    let pool = fresh_pool().await;
    let keys = Arc::new(Keys::new(SESSION, INTERNAL, Some("probe-key")));
    let metrics = Arc::new(Metrics::default());
    let hints: CookieHints = Arc::new(Mutex::new(HashMap::new()));
    let (commands, queue) = tokio::sync::mpsc::channel(256);
    let options = Options {
        zone: ZONE,
        fingerprint: true,
    };
    let engine = Engine::new(
        pool.clone(),
        keys.clone(),
        options,
        metrics.clone(),
        hints.clone(),
    );
    let engine = tokio::spawn(engine::run(engine, queue));
    let reports = Reports::new(pool.clone(), ZONE);
    let app = App::new(
        keys.clone(),
        Arc::new(Geo::empty()),
        metrics,
        hints,
        commands,
        reports,
        pool.clone(),
    );
    Service {
        router: http::router(app),
        pool,
        keys,
        engine,
    }
}

impl Service {
    async fn call(&self, request: Request<Body>) -> Response<Body> {
        self.router.clone().oneshot(request).await.unwrap()
    }

    /// Запрос через шлюз: с адресом человека и секретом шлюза.
    fn through_gateway(&self, method: &str, path: &str, ip: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(path)
            .header("x-real-ip", ip)
            .header("x-internal-secret", INTERNAL)
            .header("user-agent", CHROME_WINDOWS)
    }

    async fn events(&self, ip: &str, cookie: Option<&str>, body: Value) -> Response<Body> {
        let mut request = self.through_gateway("POST", "/api/v1/t", ip);
        if let Some(cookie) = cookie {
            request = request.header("cookie", format!("theme=dark; __Host-cord-did={cookie}"));
        }
        self.call(request.body(Body::from(body.to_string())).unwrap())
            .await
    }

    async fn internal(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(key) = key {
            request = request.header("x-insight-key", key);
        }
        let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
        let response = self.call(request.body(body).unwrap()).await;
        let status = response.status();
        (
            status,
            serde_json::from_slice(&bytes(response).await).unwrap_or(Value::Null),
        )
    }

    /// Остановить службу, как при `docker stop`: ручек больше нет, движок дописывает остаток.
    async fn stop(self) -> PgPool {
        drop(self.router);
        self.engine.await.unwrap();
        self.pool
    }
}

async fn bytes(response: Response<Body>) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

fn set_cookie(response: &Response<Body>) -> Option<String> {
    response
        .headers()
        .get("set-cookie")
        .map(|value| value.to_str().unwrap().to_owned())
}

/// Значение куки устройства из `Set-Cookie`.
fn cookie_value(header: &str) -> String {
    header
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_owned()
}

fn batch(session: &str, events: Value) -> Value {
    json!({"v": 1, "sid": sid(session), "client": {"kind": "web", "version": "1.4.0"}, "events": events})
}

#[tokio::test]
async fn a_batch_is_answered_204_and_the_device_cookie_is_issued_only_when_missing() {
    let service = service().await;
    let first = service
        .events(
            "203.0.113.7",
            None,
            batch(
                "s1",
                json!([{"n": "session_start", "at": 1, "p": {"landing": "home"}}]),
            ),
        )
        .await;
    assert_eq!(first.status(), StatusCode::NO_CONTENT);
    let issued = set_cookie(&first).expect("куки не было — она выдана");
    assert!(issued.starts_with("__Host-cord-did=v1."), "{issued}");
    assert!(
        issued.ends_with("; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000"),
        "{issued}"
    );
    assert!(service.keys.cookie_id(&cookie_value(&issued)).is_some());

    // С выданной кукой — без `Set-Cookie`.
    let second = service
        .events(
            "203.0.113.7",
            Some(&cookie_value(&issued)),
            batch("s1", json!([])),
        )
        .await;
    assert_eq!(
        (second.status(), set_cookie(&second)),
        (StatusCode::NO_CONTENT, None)
    );
    // Выдуманная кука — не устройство: выдаётся настоящая.
    let forged = service
        .events(
            "203.0.113.7",
            Some("v1.AAECAwQFBgcICQoLDA0ODw.AAAAAAAAAAAAAAAAAAAAAA"),
            batch("s2", json!([])),
        )
        .await;
    assert_eq!(forged.status(), StatusCode::NO_CONTENT);
    assert_ne!(
        cookie_value(&set_cookie(&forged).unwrap()),
        "v1.AAECAwQFBgcICQoLDA0ODw.AAAAAAAAAAAAAAAAAAAAAA"
    );
}

#[tokio::test]
async fn a_bad_body_is_400_a_big_one_is_413_and_more_than_60_a_minute_is_429() {
    let service = service().await;
    // Предел считается по минутам часов: тест не должен начаться на её исходе.
    let second = Utc::now().timestamp() % 60;
    if second >= 50 {
        tokio::time::sleep(std::time::Duration::from_secs((61 - second) as u64)).await;
    }
    let post = |ip: &'static str, body: String| {
        let request = service
            .through_gateway("POST", "/api/v1/t", ip)
            .body(Body::from(body))
            .unwrap();
        async { service.call(request).await.status() }
    };
    assert_eq!(
        post("203.0.113.1", "не JSON".into()).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post("203.0.113.1", r#"{"v": 1, "events": []}"#.into()).await,
        StatusCode::BAD_REQUEST
    );
    // Незнакомые поля и события — не ошибка: клиент новее службы не ломает приём.
    assert_eq!(
        post(
            "203.0.113.1",
            batch("s", json!([{"n": "from_the_future", "p": {"x": 1}}])).to_string()
        )
        .await,
        StatusCode::NO_CONTENT
    );
    let big = batch(
        "s",
        json!([{"n": "error", "p": {"detail": "x".repeat(33 * 1024)}}]),
    )
    .to_string();
    assert_eq!(
        post("203.0.113.1", big).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );

    // Предел — на адрес: с одного 60 пачек в минуту, сосед не страдает. Четыре запроса уже были.
    let body = batch("s", json!([])).to_string();
    for n in 5..=60 {
        assert_eq!(
            post("203.0.113.1", body.clone()).await,
            StatusCode::NO_CONTENT,
            "пачка {n}"
        );
    }
    assert_eq!(
        post("203.0.113.1", body.clone()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        post("203.0.113.2", body.clone()).await,
        StatusCode::NO_CONTENT
    );
    // IPv6 считается сетью /64: соседний адрес той же сети — тот же абонент.
    for _ in 0..60 {
        post("2001:db8:1:2::1", body.clone()).await;
    }
    assert_eq!(
        post("2001:db8:1:2:ffff::9", body.clone()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        post("2001:db8:1:3::1", body.clone()).await,
        StatusCode::NO_CONTENT
    );
    // `X-Real-IP` без секрета шлюза ничего не значит: такие запросы — один адрес (сокет).
    let direct = |ip: &'static str| {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/t")
            .header("x-real-ip", ip)
            .body(Body::from(body.clone()))
            .unwrap();
        async { service.call(request).await.status() }
    };
    for _ in 0..60 {
        direct("198.51.100.1").await;
    }
    assert_eq!(direct("198.51.100.2").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn the_challenge_has_the_format_of_the_core_and_is_bound_to_the_address() {
    let service = service().await;
    let response = service
        .call(
            service
                .through_gateway("GET", "/api/v1/t/proof", "203.0.113.7")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let challenge: Value = serde_json::from_slice(&bytes(response).await).unwrap();
    assert_eq!(
        (
            challenge["algorithm"].as_str(),
            challenge["maxnumber"].as_u64()
        ),
        (Some("SHA-256"), Some(20_000))
    );
    let salt = challenge["salt"].as_str().unwrap();
    assert!(
        salt.contains("?expires=") && salt.contains("&for=engaged&k="),
        "{salt}"
    );
    assert_eq!(challenge.as_object().unwrap().len(), 5);
    // Решается тем же перебором, что в `web/src/core/proof-solve.ts`.
    let number =
        (0..=20_000u64).find(|n| proof::hash(salt, *n) == challenge["challenge"].as_str().unwrap());
    assert!(number.is_some());
}

#[tokio::test]
async fn facts_and_reports_need_the_insight_key() {
    let service = service().await;
    let facts = json!({"source": "core", "facts": [{"id": "f1", "at": Utc::now().timestamp_millis(), "type": "refusal", "code": "RATE_LIMITED", "count": 2}]});
    let report = "/internal/reports/pulse?from=2026-11-01&to=2026-11-07";
    // Без ключа, с секретом установки и с ключом службы — отказ: ключ у `insight` свой.
    for key in [
        None,
        Some(INTERNAL),
        Some("0VpQEjXyrY1j1PlleKmCpXUw0obr6f_ZvOULDAArni4"),
    ] {
        assert_eq!(
            service
                .internal("POST", "/internal/facts", key, Some(facts.clone()))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            service.internal("GET", report, key, None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        service
            .internal(
                "POST",
                "/internal/facts",
                Some(INSIGHT_KEY),
                Some(facts.clone())
            )
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        service
            .internal("POST", "/internal/facts", Some(INSIGHT_KEY), Some(facts))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        service
            .internal(
                "POST",
                "/internal/facts",
                Some(INSIGHT_KEY),
                Some(json!([1]))
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    let (status, pulse) = service
        .internal("GET", report, Some(INSIGHT_KEY), None)
        .await;
    assert_eq!(
        (status, pulse["section"].as_str(), pulse["view"].as_str()),
        (StatusCode::OK, Some("pulse"), Some("period"))
    );
    for (path, expected, message) in [
        (
            "/internal/reports/pulse",
            StatusCode::BAD_REQUEST,
            "нужен from: день ГГГГ-ММ-ДД",
        ),
        (
            "/internal/reports/pulse?from=2026-11-01&to=вчера",
            StatusCode::BAD_REQUEST,
            "нужен to: день ГГГГ-ММ-ДД",
        ),
        (
            "/internal/reports/pulse?from=2026-11-01&to=2026-11-07&view=ltv",
            StatusCode::BAD_REQUEST,
            "view — period или cohort",
        ),
        (
            "/internal/reports/pulse?from=2026-11-01&to=2026-11-07&strict=да",
            StatusCode::BAD_REQUEST,
            "strict и compare — 0 или 1",
        ),
        (
            "/internal/reports/pulse?from=2026-11-07&to=2026-11-01",
            StatusCode::BAD_REQUEST,
            "from позже to",
        ),
        (
            "/internal/reports/visitors?from=2026-11-01&to=2026-11-07",
            StatusCode::NOT_FOUND,
            "нет такого раздела",
        ),
        (
            "/internal/reports/errors/NOPE~app~1.4?from=2026-11-01&to=2026-11-07",
            StatusCode::NOT_FOUND,
            "нет такой группы ошибок",
        ),
    ] {
        let (status, body) = service.internal("GET", path, Some(INSIGHT_KEY), None).await;
        assert_eq!(
            (status, body["error"].as_str()),
            (expected, Some(message)),
            "{path}"
        );
    }
    let (status, cohort) = service
        .internal(
            "GET",
            &format!("{report}&view=cohort&strict=1&compare=1"),
            Some(INSIGHT_KEY),
            None,
        )
        .await;
    assert_eq!(
        (status, cohort["view"].as_str(), cohort["strict"].as_bool()),
        (StatusCode::OK, Some("cohort"), Some(true))
    );
    assert!(cohort["previous"]["data"].is_object());

    // Повтор пачки фактов ничего не удвоил.
    let pool = service.stop().await;
    let refusals: i64 =
        sqlx::query_scalar("SELECT sum(n)::bigint FROM an_counts WHERE metric = 'refusal'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(refusals, 2);
}

#[tokio::test]
async fn from_an_event_to_a_report_a_person_a_robot_and_our_own_probe() {
    let service = service().await;
    let now = Utc::now().timestamp_millis();
    let today = cord_insight::days::local_day(Utc::now(), ZONE);
    let profile = profile_secret(1);

    // Человек: открыл страницу, получил куку и задачу, решил её и действовал через пять секунд (по своим часам).
    let mut opened = batch(
        "human",
        json!([{"n": "session_start", "at": now - 5000, "p": {"landing": "invite", "tz": "Europe/Moscow"}}]),
    );
    opened["profile"] = json!(profile);
    let cookie =
        cookie_value(&set_cookie(&service.events("203.0.113.7", None, opened).await).unwrap());
    let response = service
        .call(
            service
                .through_gateway("GET", "/api/v1/t/proof", "203.0.113.7")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let challenge: Value = serde_json::from_slice(&bytes(response).await).unwrap();
    let salt = challenge["salt"].as_str().unwrap();
    let number = (0..=20_000u64)
        .find(|n| proof::hash(salt, *n) == challenge["challenge"].as_str().unwrap())
        .unwrap();
    let answer = json!({"algorithm": "SHA-256", "challenge": challenge["challenge"], "number": number, "salt": salt, "signature": challenge["signature"]});
    let answer = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        answer.to_string(),
    );
    let acted = batch(
        "human",
        json!([
            {"n": "engaged", "at": now, "p": {"proof": answer, "ms": 900}},
            {"n": "screen", "at": now, "p": {"name": "prejoin"}},
        ]),
    );
    assert_eq!(
        service
            .events("203.0.113.7", Some(&cookie), acted)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );

    // Робот по агенту и своя проверка с подписанным `X-Cord-Probe`.
    let robot = Request::builder().method("POST").uri("/api/v1/t").header(
        "user-agent",
        "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    );
    service
        .call(
            robot
                .body(Body::from(
                    batch("robot", json!([{"n": "session_start", "at": now, "p": {}}])).to_string(),
                ))
                .unwrap(),
        )
        .await;
    let signed = service
        .keys
        .probe(&Utc::now().format("%Y%m%d").to_string())
        .unwrap();
    let probe = service
        .through_gateway("POST", "/api/v1/t", "203.0.113.9")
        .header("x-cord-probe", signed);
    service
        .call(
            probe
                .body(Body::from(
                    batch("probe", json!([{"n": "session_start", "at": now, "p": {}}])).to_string(),
                ))
                .unwrap(),
        )
        .await;

    // Ядро сообщает о входе и соединении человека — псевдонимом профиля, как его считает ядро.
    let pseudonym = service.keys.profile(&profile);
    let facts = json!({"source": "core", "facts": [
        {"id": "j1", "at": now, "type": "join", "room": "room-1", "profile": pseudonym, "member": "m1", "how": "link", "node": "fra", "client": "web"},
        {"id": "u1", "at": now, "type": "media_up", "room": "room-1", "profile": pseudonym, "member": "m1", "node": "fra"},
    ]});
    assert_eq!(
        service
            .internal("POST", "/internal/facts", Some(INSIGHT_KEY), Some(facts))
            .await
            .0,
        StatusCode::NO_CONTENT
    );

    // Здоровье и метрики.
    let (status, health) = service.internal("GET", "/healthz", None, None).await;
    assert_eq!(
        (
            status,
            health["status"].as_str(),
            health["database"].as_bool()
        ),
        (StatusCode::OK, Some("ok"), Some(true))
    );
    let metrics = String::from_utf8(
        bytes(
            service
                .call(Request::get("/metrics").body(Body::empty()).unwrap())
                .await,
        )
        .await,
    )
    .unwrap();
    for line in [
        "insight_batches_total{result=\"accepted\"} 4",
        "insight_facts_accepted_total{type=\"media_up\"} 1",
        "insight_sessions_total{class=\"bot\",reason=\"robot\"} 1",
        "insight_sessions_total{class=\"own\",reason=\"probe\"} 1",
    ] {
        assert!(
            metrics.lines().any(|l| l == line),
            "нет «{line}» в метриках:\n{metrics}"
        );
    }

    // Служба остановлена — остаток записан. В базе — один человек, подтверждённый звонком; робот и проба — в трафике.
    let keys = service.keys.clone();
    let pool = service.stop().await;
    let text = async |sql: &str| {
        sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.to_owned()))
            .fetch_all(&pool)
            .await
            .unwrap()
            .join("\n")
    };
    assert_eq!(
        text("SELECT concat_ws('|', human, reason, via, landing, step) FROM an_sessions").await,
        "confirmed|media|new|invite|6"
    );
    assert_eq!(
        text("SELECT id FROM an_devices").await,
        keys.cookie_id(&cookie).unwrap()
    );
    assert_eq!(text("SELECT concat_ws('|', class, NULLIF(bot, ''), visits) FROM an_traffic_days WHERE visits <> 0 ORDER BY class").await, "bot|yandex|1\nhuman|1\nown|1");
    assert_eq!(
        text("SELECT name FROM an_events ORDER BY at, name").await,
        "session_start\nengaged\njoin\nscreen"
    );
    // Ни адреса, ни секрета профиля, ни агента в базе нет.
    let dump = text("SELECT row_to_json(t)::text FROM (SELECT * FROM an_devices, an_sessions, an_persons) t UNION ALL SELECT row_to_json(e)::text FROM an_events e").await;
    for secret in ["203.0.113", profile.as_str(), "Mozilla", "room-1"] {
        assert!(!dump.contains(secret), "в базе нашлось «{secret}»");
    }

    // Отчёт видит человека сегодня.
    let reports = Reports::new(pool, ZONE);
    let query = cord_insight::reports::Query {
        from: today,
        to: today,
        cohort: false,
        strict: false,
        compare: false,
    };
    let pulse = reports
        .report("pulse", None, &query, Utc::now())
        .await
        .unwrap();
    assert_eq!(
        (
            pulse["data"]["tiles"]["people"]["value"].clone(),
            pulse["data"]["tiles"]["confirmed"]["value"].clone()
        ),
        (json!(1), json!(1))
    );
    let traffic = reports
        .report("traffic", None, &query, Utc::now())
        .await
        .unwrap();
    assert_eq!(
        traffic["data"]["totals"],
        json!({"visits": 3, "human": 1, "unclear": 0, "bot": 1, "automation": 0, "own": 1, "human_share": 0.3333})
    );
}
