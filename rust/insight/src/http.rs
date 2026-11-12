//! Ручки службы (`contracts/insight.md`): события клиента и задача «не робот» — через шлюз; факты, отчёты,
//! здоровье и метрики — только с петли.
//!
//! Ручки базы не ждут: событие чистится, сводится к словам (страна, сеть, вид клиента — адрес и агент дальше
//! не идут) и кладётся в ограниченную очередь движка. Очередь полна — пачка отбрасывается со счётчиком, а
//! человеку всё равно `204`: аналитика не мешает встрече.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, SET_COOKIE, USER_AGENT};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::{mpsc, oneshot};

use crate::engine::{Command, CookieHints, Visit};
use crate::event::{self, BatchError};
use crate::fact;
use crate::keys::{Cookie, DEVICE_COOKIE, Keys};
use crate::metrics::Metrics;
use crate::net::{self, Geo, Network};
use crate::proof::Proof;
use crate::reports::{Query as ReportQuery, ReportError, Reports};
use crate::ua;

/// Тело пачки событий — не больше 32 КиБ (тот же предел держит шлюз).
pub const MAX_EVENTS_BODY: usize = 32 * 1024;
/// Тело пачки фактов: 500 фактов с запасом.
const MAX_FACTS_BODY: usize = 2 * 1024 * 1024;
/// Пачек событий и задач «не робот» в минуту с адреса.
pub const PER_MINUTE: u32 = 60;
/// Сколько ручка фактов ждёт движок, прежде чем сказать отправителю «повтори».
const FACTS_WAIT: Duration = Duration::from_secs(5);

/// Всё, что нужно ручкам.
pub struct App {
    pub keys: Arc<Keys>,
    pub proof: Proof,
    pub geo: Arc<Geo>,
    pub metrics: Arc<Metrics>,
    pub hints: CookieHints,
    pub commands: mpsc::Sender<Command>,
    pub reports: Reports,
    pub pool: PgPool,
    limits: Mutex<HashMap<String, (i64, u32)>>,
}

impl App {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        keys: Arc<Keys>,
        geo: Arc<Geo>,
        metrics: Arc<Metrics>,
        hints: CookieHints,
        commands: mpsc::Sender<Command>,
        reports: Reports,
        pool: PgPool,
    ) -> Arc<App> {
        let proof = Proof::new(keys.proof_key());
        Arc::new(App {
            keys,
            proof,
            geo,
            metrics,
            hints,
            commands,
            reports,
            pool,
            limits: Mutex::new(HashMap::new()),
        })
    }

    /// Предел в минуту на адрес. Ключ — HMAC ключа адреса: сам адрес в памяти не лежит.
    fn allowed(&self, bucket: &str, address: &str, now: DateTime<Utc>) -> bool {
        let key = self
            .keys
            .derive(&format!("analytics-rate:{bucket}:{address}"));
        let minute = now.timestamp() / 60;
        let mut limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        if limits.len() > 20_000 {
            limits.retain(|_, (seen, _)| *seen == minute);
        }
        let slot = limits.entry(key).or_insert((minute, 0));
        if slot.0 != minute {
            *slot = (minute, 0);
        }
        slot.1 += 1;
        slot.1 <= PER_MINUTE
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/v1/t", post(events))
        .route("/api/v1/t/proof", get(challenge))
        .route("/internal/facts", post(facts))
        .route("/internal/reports/{section}", get(report))
        .route("/internal/reports/errors/{key}", get(error_report))
        .route("/healthz", get(health))
        .route("/metrics", get(metrics))
        .with_state(app)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

/// Адрес человека: `X-Real-IP` шлюза, если шлюз доказал себя секретом, иначе адрес сокета — как у ядра.
fn client_ip(app: &App, headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    let forwarded = header(headers, "x-real-ip")
        .filter(|_| app.keys.is_gateway(header(headers, "x-internal-secret")));
    forwarded
        .and_then(net::parse_ip)
        .or(peer.map(|peer| peer.ip()))
}

fn peer(request: &Request) -> Option<SocketAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0)
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [
            (CONTENT_TYPE, "application/json"),
            (CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

fn problem(status: StatusCode, message: &str) -> Response {
    json_response(status, &json!({"error": message}))
}

/// `POST /api/v1/t` — пачка событий клиента.
async fn events(State(app): State<Arc<App>>, request: Request) -> Response {
    let now = Utc::now();
    let peer = peer(&request);
    let (parts, body) = request.into_parts();
    let headers = parts.headers;
    let outcome = |result: &str| {
        app.metrics
            .inc("insight_batches_total", &[("result", result)])
    };
    // Предел — раньше чтения тела: лишняя пачка не стоит службе ничего.
    let ip = client_ip(&app, &headers, peer);
    let address = ip.map(net::address_key).unwrap_or_default();
    if !app.allowed("t", &address, now) {
        outcome("rate_limited");
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Ok(body) = axum::body::to_bytes(body, MAX_EVENTS_BODY).await else {
        outcome("too_large");
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let batch = match event::parse(&body) {
        Ok(batch) => batch,
        Err(BatchError::NotJson | BatchError::NoSession) => {
            outcome("invalid");
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    app.metrics.add(
        "insight_events_dropped_total",
        &[("reason", "unknown")],
        batch.dropped as u64,
    );

    // Кука устройства: верная — устройство, иначе выдаётся новая. Подпись проверяется без базы.
    let presented = header(&headers, COOKIE.as_str()).and_then(|cookies| {
        cookies
            .split(';')
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == DEVICE_COOKIE)
    });
    let cookie = match presented.and_then(|(_, value)| app.keys.cookie_id(value)) {
        Some(id) => Cookie::Valid(id),
        None => Cookie::Issued(Keys::new_device_id()),
    };
    // Движок узнал устройство по профилю или кука старше 30 дней — она уходит с этим ответом.
    let hinted = app
        .hints
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&batch.sid);
    let set_cookie = match (&hinted, &cookie) {
        (Some(device), _) => Some(app.keys.set_cookie(device)),
        (None, Cookie::Issued(id)) => Some(app.keys.set_cookie(id)),
        (None, Cookie::Valid(_)) => None,
    };

    let agent_text: String = header(&headers, USER_AGENT.as_str())
        .unwrap_or_default()
        .chars()
        .take(512)
        .collect();
    let start = batch.events.iter().find(|e| e.name == "session_start");
    let touch = start
        .and_then(|s| s.object("fp"))
        .and_then(|fp| fp.get("touch"))
        .and_then(Value::as_u64);
    let claimed = batch
        .client_kind
        .as_deref()
        .or(header(&headers, "x-cord-client"));
    let client = ua::client_kind(claimed, &agent_text);
    let profile = batch
        .profile
        .as_deref()
        .or(header(&headers, "x-cord-profile").filter(|p| p.len() == 43));
    let probe = batch.probe.as_deref().or(header(&headers, "x-cord-probe"));
    let answer = batch
        .events
        .iter()
        .find(|e| e.name == "engaged")
        .and_then(|e| e.text("proof"));
    let visit = Visit {
        now,
        sid: batch.sid.clone(),
        profile: profile.map(|secret| app.keys.profile(secret)),
        cookie,
        agent: ua::agent(&agent_text, touch.map(|t| t as u32)),
        robot: ua::robot(&agent_text),
        client,
        client_matches: ua::client_matches(client, &agent_text),
        version: batch.client_version.clone(),
        network: ip.map_or_else(Network::unknown, |ip| app.geo.network(ip, &app.keys)),
        probe: probe.is_some_and(|value| app.keys.is_probe(value, now.date_naive())),
        proof: answer.and_then(|answer| app.proof.verify(answer, &address, now.timestamp_millis())),
        events: batch.events,
    };
    let count = visit.events.len() as u64;
    match app.commands.try_send(Command::Visit(Box::new(visit))) {
        Ok(()) => outcome("accepted"),
        Err(_) => {
            outcome("queue_full");
            app.metrics.add(
                "insight_events_dropped_total",
                &[("reason", "queue_full")],
                count,
            );
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Some(value) = set_cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok()) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    response
}

/// `GET /api/v1/t/proof` — задача «не робот» для события `engaged`.
async fn challenge(State(app): State<Arc<App>>, request: Request) -> Response {
    let now = Utc::now();
    let address = client_ip(&app, request.headers(), peer(&request))
        .map(net::address_key)
        .unwrap_or_default();
    if !app.allowed("proof", &address, now) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let challenge = app.proof.issue(&address, now.timestamp_millis());
    json_response(StatusCode::OK, &json!(challenge))
}

fn authorised(app: &App, headers: &HeaderMap) -> bool {
    app.keys.is_insight(header(headers, "x-insight-key"))
}

/// `POST /internal/facts` — факты ядра и служб. `204` — приняты; `503` — движок или база не готовы,
/// отправитель повторит пачку с теми же `id`.
async fn facts(State(app): State<Arc<App>>, headers: HeaderMap, body: Body) -> Response {
    if !authorised(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(body): Result<Bytes, _> = axum::body::to_bytes(body, MAX_FACTS_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let Some(batch) = fact::parse(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let count = batch.facts.len() as u64;
    let (answer, accepted) = oneshot::channel();
    let busy = |reason: &str| {
        app.metrics
            .add("insight_facts_dropped_total", &[("reason", reason)], count);
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    };
    if app
        .commands
        .try_send(Command::Facts(batch, Utc::now(), answer))
        .is_err()
    {
        return busy("queue_full");
    }
    match tokio::time::timeout(FACTS_WAIT, accepted).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        _ => busy("not_ready"),
    }
}

/// `GET /internal/reports/{раздел}`.
async fn report(
    State(app): State<Arc<App>>,
    Path(section): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    reply(&app, &headers, &section, None, &params).await
}

/// `GET /internal/reports/errors/{key}`.
async fn error_report(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    reply(&app, &headers, "errors", Some(&key), &params).await
}

async fn reply(
    app: &App,
    headers: &HeaderMap,
    section: &str,
    key: Option<&str>,
    params: &HashMap<String, String>,
) -> Response {
    if !authorised(app, headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let query = match report_query(params) {
        Ok(query) => query,
        Err(message) => return problem(StatusCode::BAD_REQUEST, message),
    };
    match app.reports.report(section, key, &query, Utc::now()).await {
        Ok(report) => json_response(StatusCode::OK, &report),
        Err(error @ ReportError::BadRequest(_)) => {
            problem(StatusCode::BAD_REQUEST, &error.to_string())
        }
        Err(error @ (ReportError::UnknownSection | ReportError::NotFound)) => {
            problem(StatusCode::NOT_FOUND, &error.to_string())
        }
        Err(ReportError::Database(error)) => {
            app.metrics
                .inc("insight_db_errors_total", &[("at", "report")]);
            tracing::warn!(section, %error, "отчёт не построен");
            problem(StatusCode::SERVICE_UNAVAILABLE, "база не ответила")
        }
    }
}

/// Параметры отчёта: `from`, `to` (дни), `view=period|cohort`, `strict=0|1`, `compare=0|1`.
pub fn report_query(params: &HashMap<String, String>) -> Result<ReportQuery, &'static str> {
    let day = |name: &str| {
        params
            .get(name)
            .and_then(|text| text.parse::<NaiveDate>().ok())
    };
    let flag = |name: &str| match params.get(name).map(String::as_str) {
        None | Some("0" | "false" | "") => Ok(false),
        Some("1" | "true") => Ok(true),
        Some(_) => Err("strict и compare — 0 или 1"),
    };
    Ok(ReportQuery {
        from: day("from").ok_or("нужен from: день ГГГГ-ММ-ДД")?,
        to: day("to").ok_or("нужен to: день ГГГГ-ММ-ДД")?,
        cohort: match params.get("view").map(String::as_str) {
            None | Some("period") => false,
            Some("cohort") => true,
            Some(_) => return Err("view — period или cohort"),
        },
        strict: flag("strict")?,
        compare: flag("compare")?,
    })
}

/// `GET /healthz` — служба жива. База и базы адресов — сведения, а не условие: без них служба работает.
async fn health(State(app): State<Arc<App>>) -> Response {
    let ping = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&app.pool);
    let database = matches!(
        tokio::time::timeout(Duration::from_secs(1), ping).await,
        Ok(Ok(1))
    );
    let (country, asn) = app.geo.status();
    json_response(
        StatusCode::OK,
        &json!({"status": "ok", "database": database, "geo": {"country": country, "asn": asn}}),
    )
}

/// `GET /metrics` — текст Prometheus.
async fn metrics(State(app): State<Arc<App>>) -> Response {
    let (country, asn) = app.geo.status();
    app.metrics.set(
        "insight_geo_loaded",
        &[("db", "country")],
        f64::from(u8::from(country)),
    );
    app.metrics.set(
        "insight_geo_loaded",
        &[("db", "asn")],
        f64::from(u8::from(asn)),
    );
    app.metrics.set(
        "insight_queue_depth",
        &[],
        (app.commands.max_capacity() - app.commands.capacity()) as f64,
    );
    (
        [(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        app.metrics.render(),
    )
        .into_response()
}
