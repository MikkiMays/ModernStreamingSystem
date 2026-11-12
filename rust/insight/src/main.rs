//! `cord-insight` — служба аналитики Cord.
//!
//! - `cord-insight` — служба: слушает `127.0.0.1:${INSIGHT_PORT:-18300}`;
//! - `cord-insight healthcheck` — проверка здоровья для compose (в образе нет ни оболочки, ни wget);
//! - `cord-insight geo <адрес>` — что базы адресов говорят об адресе: проверка после `infra/geo/update.sh`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use cord_insight::config::Config;
use cord_insight::days::local_day;
use cord_insight::engine::{self, CookieHints, Engine, Options};
use cord_insight::http::{self, App};
use cord_insight::keys::Keys;
use cord_insight::metrics::Metrics;
use cord_insight::net::{self, Geo};
use cord_insight::reports::Reports;
use cord_insight::{db, retention};
use sqlx::PgPool;

/// Очередь команд движка: больше — отбрасывается со счётчиком.
const QUEUE: usize = 4096;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("healthcheck") => healthcheck(),
        Some("geo") => geo(arguments.get(1).map(String::as_str)),
        None | Some("serve") => serve(),
        Some(other) => {
            eprintln!("неизвестная команда «{other}»: есть serve, healthcheck, geo <адрес>");
            ExitCode::from(2)
        }
    }
}

fn port() -> u16 {
    std::env::var("INSIGHT_PORT").ok().and_then(|p| p.trim().parse().ok()).unwrap_or(18300)
}

/// Спросить у работающей службы `/healthz`: код выхода 0 — ответила `200`.
fn healthcheck() -> ExitCode {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port()));
    let ask = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
        let mut head = [0u8; 12];
        stream.read_exact(&mut head)?;
        Ok(&head == b"HTTP/1.1 200")
    };
    if matches!(ask(), Ok(true)) { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Страна, ASN и класс сети адреса по базам этой машины.
fn geo(address: Option<&str>) -> ExitCode {
    let Some(ip) = address.and_then(net::parse_ip) else {
        eprintln!("cord-insight geo <адрес>");
        return ExitCode::from(2);
    };
    let directory = std::env::var("INSIGHT_GEO_DIR").unwrap_or_else(|_| "/geo".to_owned());
    let geo = Geo::open(&directory);
    let (country, asn) = geo.status();
    let network = geo.network(ip, &Keys::new("-", "-", None));
    println!(
        "каталог {directory}: база стран — {}, база ASN — {}\nстрана: {}\nASN: {}\nкласс сети: {}",
        if country { "есть" } else { "нет" },
        if asn { "есть" } else { "нет" },
        if network.country.is_empty() { "неизвестно" } else { &network.country },
        network.asn.map_or("неизвестно".to_owned(), |asn| asn.to_string()),
        network.class,
    );
    ExitCode::SUCCESS
}

fn serve() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("INSIGHT_LOG").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(%error, "служба не настроена");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "не запустить среду исполнения");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run(config))
}

async fn run(config: Config) -> ExitCode {
    let pool = db::pool(&config.database);
    let keys = Arc::new(Keys::new(&config.session_secret, &config.internal_secret, config.probe_key.as_deref()));
    let geo = Arc::new(Geo::open(&config.geo_dir));
    let metrics = Arc::new(Metrics::default());
    let hints: CookieHints = Arc::new(Mutex::new(HashMap::new()));
    let (commands, queue) = tokio::sync::mpsc::channel(QUEUE);

    let options = Options { zone: config.zone, fingerprint: config.fingerprint };
    let engine = Engine::new(pool.clone(), keys.clone(), options, metrics.clone(), hints.clone());
    let engine = tokio::spawn(run_engine(engine, queue, pool.clone(), config.clone()));
    let upkeep = tokio::spawn(upkeep(pool.clone(), geo.clone(), config.clone()));

    let reports = Reports::new(pool.clone(), config.zone);
    let app = App::new(keys, geo, metrics, hints, commands, reports, pool);
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, config.port));
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%address, %error, "порт занят");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(%address, zone = config.zone.name(), fingerprint = config.fingerprint, "служба аналитики слушает");
    let service = http::router(app).into_make_service_with_connect_info::<SocketAddr>();
    let served = axum::serve(listener, service).with_graceful_shutdown(stop()).await;
    // Ручки остановлены и очередь закрыта: движок дописывает остаток и выходит.
    upkeep.abort();
    if tokio::time::timeout(Duration::from_secs(15), engine).await.is_err() {
        tracing::warn!("движок не успел дописать остаток");
    }
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "ручки остановились с ошибкой");
            ExitCode::FAILURE
        }
    }
}

/// Движок ждёт базу: пока миграции не применены, команды копятся в очереди (и отбрасываются сверх неё).
async fn run_engine(mut engine: Engine, queue: tokio::sync::mpsc::Receiver<engine::Command>, pool: PgPool, config: Config) {
    loop {
        let ready = async {
            db::migrate(&pool).await.map_err(|e| e.to_string())?;
            let now = Utc::now();
            db::ensure_partitions_ahead(&pool, local_day(now, config.zone)).await.map_err(|e| e.to_string())?;
            engine.load(now).await.map_err(|e| e.to_string())
        };
        match ready.await {
            Ok(()) => break,
            Err(error) => {
                tracing::warn!(%error, "база не готова, жду");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
    tracing::info!("схема базы готова");
    engine::run(engine, queue).await;
}

/// Раз в минуту — перечитать базы адресов, если их обновили; раз в час — сроки хранения и разделы событий
/// на два месяца вперёд.
async fn upkeep(pool: PgPool, geo: Arc<Geo>, config: Config) {
    let mut minute = tokio::time::interval(Duration::from_secs(60));
    let mut tick = 0u64;
    loop {
        minute.tick().await;
        geo.refresh();
        if tick % 60 == 5 {
            let now = Utc::now();
            let today = local_day(now, config.zone);
            if let Err(error) = db::ensure_partitions_ahead(&pool, today).await {
                tracing::warn!(%error, "разделы событий не заведены");
            }
            match retention::sweep(&pool, config.retention, today, now).await {
                Ok(removed) => tracing::info!(?removed, "сроки хранения применены"),
                Err(error) => tracing::warn!(%error, "сроки хранения не применены"),
            }
        }
        tick += 1;
    }
}

/// Ждать SIGTERM (docker stop) или Ctrl-C.
async fn stop() {
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = terminate => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    tracing::info!("останавливаюсь");
}
