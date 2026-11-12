//! Движок аналитики: одна задача, которой принадлежит всё состояние.
//!
//! Ручки HTTP только чистят вход и кладут команду в ограниченную очередь — базы они не ждут. Движок
//! разбирает команды по одной: держит в памяти живые сессии, решает, человек ли это и какой (§4.5, §5
//! проекта), копит прибавки к суточным строкам и раз в пару секунд пишет их одной транзакцией
//! (`store::Pending`). Время приходит вместе с командой: тесты и образцы отчётов идут на своих часах.

pub mod facts;
pub mod identity;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::classify::{self, Class, Guard, Signals, reason};
use crate::days::{from_ms, local_day};
use crate::errors;
use crate::event::{self, Event};
use crate::fact::Facts;
use crate::keys::{Cookie, Keys};
use crate::metrics::Metrics;
use crate::net::{self, Network};
use crate::proof::Solved;
use crate::ua::{Agent, Robot};

use facts::{Meeting, Run};
use identity::{Candidate, Origin, Via};
use store::{ErrorDelta, ErrorDims, EventRow, Pending, SessionUpdate, TrafficKey};

/// Сессия — вкладка или запуск приложения до 30 минут тишины.
pub const SESSION_IDLE_MINUTES: i64 = 30;
/// Кука устройства продлевается раз в 30 дней.
const COOKIE_RENEW_DAYS: i64 = 30;
/// Сколько событий сессии «неясно» ждёт в памяти, пока человек себя не проявит, — и сколько их ждёт всего.
const HELD_EVENTS: usize = 50;
const HELD_TOTAL: usize = 20_000;
/// Пределы против раздувания. Ручка событий открыта всем, а имена возможностей, площадок и коды ошибок
/// приходят от клиента: без пределов одна сессия завела бы сколько угодно строк и групп.
/// Живых сессий в памяти; сверх — вытесняются самые давние из не-людей.
const LIVE_SESSIONS: usize = 40_000;
/// Событий одной сессии.
const SESSION_EVENTS: u32 = 5_000;
/// Разных возможностей и площадок — и разных ошибок — у одной сессии.
const SESSION_NAMES: usize = 30;
/// Разных ошибок у сессии «неясно» и новых групп ошибок от всех таких сессий за час.
const UNCLEAR_ERRORS: usize = 3;
const UNCLEAR_ERRORS_PER_HOUR: usize = 200;
/// Сколько помнится профиль своей проверки или робота: его факты в цифры не идут.
const OUTSIDER_HOURS: i64 = 24;
/// Сколько подряд неудачных записей терпим, прежде чем выбросить накопленное: одна «ядовитая» строка не
/// должна остановить запись навсегда.
const FAILED_FLUSHES: u32 = 10;

/// Куки, которые надо выдать сессии со следующим ответом: движок узнал устройство по профилю или кука
/// старше 30 дней. Сессия → id устройства.
pub type CookieHints = Arc<Mutex<HashMap<String, String>>>;

/// Пачка событий клиента, как её видит движок: всё, что зависит от адреса и агента, уже сведено к словам.
#[derive(Debug, Clone)]
pub struct Visit {
    pub now: DateTime<Utc>,
    pub sid: String,
    /// Псевдоним профиля устройства.
    pub profile: Option<String>,
    pub cookie: Cookie,
    pub agent: Agent,
    pub robot: Option<Robot>,
    pub client: &'static str,
    pub client_matches: bool,
    pub version: String,
    pub network: Network,
    /// Верная подпись своих проверок.
    pub probe: bool,
    /// Проверенный ответ на задачу «не робот» из события `engaged`.
    pub proof: Option<Solved>,
    pub events: Vec<Event>,
}

/// Чем сессия доказала, что за ней человек.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Evidence {
    /// Действие, видимая страница и решённая задача.
    Engaged,
    /// Соединение с медиаузлом.
    Media,
}

/// Человек и его устройство.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub person: i64,
    pub device: String,
}

/// Признаки сессии для строки `an_sessions` и срезов.
#[derive(Debug, Clone, Default)]
struct Attrs {
    client: &'static str,
    version: String,
    os: &'static str,
    browser: &'static str,
    device_class: &'static str,
    country: String,
    asn: Option<i64>,
    net: &'static str,
    vpn: bool,
    landing: String,
    source: String,
    utm: [String; 3],
}

/// Живая сессия.
struct Live {
    first_seen: DateTime<Utc>,
    last_seen: DateTime<Utc>,
    /// Начало по часам клиента (принятым) и его сырое значение — от него считается «страница видна ≥ 3 с».
    started_at: DateTime<Utc>,
    start_raw: Option<i64>,
    started: bool,
    day: NaiveDate,
    attrs: Attrs,
    /// Устройство: id из куки, а когда человек узнан — id его устройства.
    device: String,
    cookie_valid: bool,
    profile: Option<String>,
    fp: Option<String>,
    fp_strength: i16,
    tz: String,
    subnet: String,
    webdriver: bool,
    renderer: Option<String>,
    probe: bool,
    class: Class,
    reason: &'static str,
    bot: &'static str,
    /// Под каким классом сессия посчитана в суточном трафике.
    counted: Option<TrafficKey>,
    demoted: bool,
    held: Vec<(Event, DateTime<Utc>, bool)>,
    want: Option<Evidence>,
    proof: Option<Solved>,
    proof_spent: bool,
    who: Option<i64>,
    via: Via,
    step: i16,
    errors: i32,
    error_keys: HashSet<String>,
    error_session_counted: bool,
    /// Возможности и площадки, которые сессия уже называла.
    names: HashSet<String>,
    /// Сколько событий сессия прислала.
    events: u32,
    dirty: bool,
}

impl Live {
    fn open(v: &Visit, day: NaiveDate) -> Self {
        Live {
            first_seen: v.now,
            last_seen: v.now,
            started_at: v.now,
            start_raw: None,
            started: false,
            day,
            attrs: Attrs {
                client: v.client,
                version: v.version.clone(),
                os: v.agent.os,
                browser: v.agent.browser,
                device_class: v.agent.device,
                country: v.network.country.clone(),
                asn: v.network.asn.map(i64::from),
                net: v.network.class,
                ..Attrs::default()
            },
            device: v.cookie.id().to_owned(),
            cookie_valid: false,
            profile: None,
            fp: None,
            fp_strength: 0,
            tz: String::new(),
            subnet: v.network.subnet.clone(),
            webdriver: false,
            renderer: None,
            probe: false,
            class: Class::Unclear,
            reason: reason::SILENT,
            bot: "",
            counted: None,
            demoted: false,
            held: Vec::new(),
            want: None,
            proof: None,
            proof_spent: false,
            who: None,
            via: Via::New,
            step: 1,
            errors: 0,
            error_keys: HashSet::new(),
            error_session_counted: false,
            names: HashSet::new(),
            events: 0,
            dirty: false,
        }
    }

    /// Событие `session_start`: откуда пришёл, пояс, признаки отпечатка.
    fn start(&mut self, start: &Event, v: &Visit, keys: &Keys, fingerprint: bool, zone: Tz) {
        let now_ms = v.now.timestamp_millis();
        self.started = true;
        self.start_raw = Some(start.at);
        self.started_at = from_ms(event::moment(start.at, now_ms));
        self.day = local_day(self.started_at, zone);
        let text = |key: &str| start.text(key).unwrap_or_default().to_owned();
        self.attrs.landing = text("landing");
        self.attrs.source = text("ref");
        if let Some(utm) = start.object("utm") {
            let part = |key: &str| {
                utm.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            self.attrs.utm = [part("source"), part("medium"), part("campaign")];
        }
        self.tz = text("tz");
        self.webdriver = start.flag("wd");
        let tz = (!self.tz.is_empty()).then_some(self.tz.as_str());
        self.attrs.vpn = net::vpn_likely(&v.network, tz, v.now);
        let Some(fp) = start.object("fp") else { return };
        self.renderer = fp.get("glr").and_then(Value::as_str).map(str::to_owned);
        if !fingerprint {
            return;
        }
        // Сила — сколько пришло признаков высокой силы: рисунок canvas, видеокарта, набор шрифтов.
        self.fp_strength = ["canvas", "gl", "fonts"]
            .iter()
            .filter(|key| fp.contains_key(**key))
            .count() as i16;
        // Признаки сводятся в одну строку в постоянном порядке; версии браузера среди них нет.
        let mut features = String::new();
        for key in [
            "canvas", "gl", "fonts", "audio", "hc", "dm", "touch", "plat",
        ] {
            features.push_str(&format!(
                "{key}={}\n",
                fp.get(key).map(Value::to_string).unwrap_or_default()
            ));
        }
        let screen = start
            .object("screen")
            .map(|s| Value::Object(s.clone()).to_string())
            .unwrap_or_default();
        features.push_str(&format!(
            "screen={screen}\ntz={}\nlang={}\nbrowser={}\nos={}",
            self.tz,
            text("lang"),
            self.attrs.browser,
            self.attrs.os
        ));
        self.fp = Some(keys.fingerprint(&features));
    }

    fn traffic_key(&self) -> TrafficKey {
        TrafficKey {
            day: self.day,
            class: self.class.traffic(),
            bot: self.bot,
            client: self.attrs.client,
            os: self.attrs.os,
            country: self.attrs.country.clone(),
            net: self.attrs.net,
        }
    }

    fn error_dims(&self) -> ErrorDims {
        ErrorDims {
            client: self.attrs.client.to_owned(),
            os: self.attrs.os.to_owned(),
            browser: self.attrs.browser.to_owned(),
            version: self.attrs.version.clone(),
            node: String::new(),
        }
    }
}

/// Ошибка для группы.
struct ErrorNote<'a> {
    code: &'a str,
    scope: &'a str,
    version: &'a str,
    source: &'static str,
    at: DateTime<Utc>,
    day: NaiveDate,
    dims: ErrorDims,
    first_in_session: bool,
    person: Option<i64>,
    sample: Value,
    count: i64,
}

/// Учесть ошибку в группе, в срезах дня и у человека. Возвращает ключ группы.
fn note_error(pending: &mut Pending, note: ErrorNote) -> String {
    let key = errors::key(note.code, note.scope, note.version);
    let first = i64::from(note.first_in_session);
    let group = pending
        .errors
        .entry(key.clone())
        .or_insert_with(|| ErrorDelta {
            code: errors::clean_code(note.code),
            scope: note.scope.to_owned(),
            version: note.version.to_owned(),
            source: note.source,
            cause: errors::cause(note.code, note.scope),
            first_at: note.at,
            last_at: note.at,
            count: 0,
            sessions: 0,
            sample: Value::Null,
        });
    group.count += note.count;
    group.sessions += first;
    group.first_at = group.first_at.min(note.at);
    if note.at >= group.last_at || group.sample.is_null() {
        group.last_at = group.last_at.max(note.at);
        group.sample = note.sample;
    }
    let day = pending
        .error_days
        .entry((key.clone(), note.day, note.dims))
        .or_default();
    day.0 += note.count;
    day.1 += first;
    if let Some(person) = note.person {
        *pending
            .error_people
            .entry((key.clone(), note.day, person))
            .or_default() += note.count;
    }
    key
}

/// Что движку нужно знать об установке.
pub struct Options {
    pub zone: Tz,
    /// Отпечаток устройства включён (`ANALYTICS_FINGERPRINT`).
    pub fingerprint: bool,
}

pub struct Engine {
    pool: PgPool,
    keys: Arc<Keys>,
    zone: Tz,
    fingerprint: bool,
    metrics: Arc<Metrics>,
    hints: CookieHints,
    /// Самое позднее время, которое движок видел.
    now: DateTime<Utc>,
    sessions: HashMap<String, Live>,
    by_profile: HashMap<String, Vec<String>>,
    guard: Guard,
    /// Профили, соединившиеся с медиаузлом раньше, чем пришла их сессия.
    confirmed: HashMap<String, DateTime<Utc>>,
    known: HashMap<String, Who>,
    unknown: HashMap<String, DateTime<Utc>>,
    meetings: HashMap<String, Meeting>,
    /// Закрытые встречи, ждущие записи.
    finished: Vec<Meeting>,
    runs: HashMap<String, Run>,
    /// (псевдоним встречи, вид) → идущий запуск.
    open_runs: HashMap<(String, String), String>,
    pending: Pending,
    /// Факты, принятые после последней записи: повтор пачки до записи тоже ничего не удваивает.
    fact_seen: HashSet<String>,
    partitions: HashSet<NaiveDate>,
    failed_flushes: u32,
    /// Сколько событий сессий «неясно» ждёт в памяти.
    held_total: usize,
    /// Группы ошибок, заведённые сессиями «неясно» в этом часу: час и ключи.
    unclear_errors: (i64, HashSet<String>),
    /// Профили своих проверок, роботов и автоматики: их встречи и входы в цифры не идут (§11 проекта).
    outsiders: HashMap<String, DateTime<Utc>>,
}

impl Engine {
    pub fn new(
        pool: PgPool,
        keys: Arc<Keys>,
        options: Options,
        metrics: Arc<Metrics>,
        hints: CookieHints,
    ) -> Self {
        Engine {
            pool,
            keys,
            zone: options.zone,
            fingerprint: options.fingerprint,
            metrics,
            hints,
            now: DateTime::<Utc>::MIN_UTC,
            sessions: HashMap::new(),
            by_profile: HashMap::new(),
            guard: Guard::new(),
            confirmed: HashMap::new(),
            known: HashMap::new(),
            unknown: HashMap::new(),
            meetings: HashMap::new(),
            finished: Vec::new(),
            runs: HashMap::new(),
            open_runs: HashMap::new(),
            pending: Pending::default(),
            fact_seen: HashSet::new(),
            partitions: HashSet::new(),
            failed_flushes: 0,
            held_total: 0,
            unclear_errors: (0, HashSet::new()),
            outsiders: HashMap::new(),
        }
    }

    fn db_error(&self, place: &'static str, error: &sqlx::Error) {
        self.metrics
            .inc("insight_db_errors_total", &[("at", place)]);
        tracing::warn!(place, %error, "отказ базы");
    }

    fn today(&self, now: DateTime<Utc>) -> NaiveDate {
        local_day(now, self.zone)
    }

    /// Класс и причина живой сессии — для тестов и отладки.
    pub fn session_class(&self, sid: &str) -> Option<(Class, &'static str)> {
        self.sessions.get(sid).map(|live| (live.class, live.reason))
    }

    pub fn live_sessions(&self) -> usize {
        self.sessions.len()
    }

    // ── События клиента ──────────────────────────────────────────────────────────────────────────────

    /// Принять пачку событий сессии.
    pub async fn visit(&mut self, mut v: Visit) {
        self.now = self.now.max(v.now);
        let today = self.today(v.now);
        let sid = v.sid.clone();
        let start = v.events.iter().position(|e| e.name == "session_start");
        if !self.sessions.contains_key(&sid) {
            if self.sessions.len() >= LIVE_SESSIONS {
                self.evict();
            }
            let mut live = Live::open(&v, today);
            // Сессия без начала, которой нет в памяти: служба перезапускалась. Сессия человека лежит в базе.
            if start.is_none() {
                match self.restore(&sid).await {
                    Ok(Some(saved)) => saved.apply(&mut live),
                    Ok(None) => {}
                    Err(error) => self.db_error("restore", &error),
                }
            }
            self.sessions.insert(sid.clone(), live);
        }
        let Some(live) = self.sessions.get_mut(&sid) else {
            return;
        };
        live.last_seen = v.now;
        live.probe |= v.probe;
        if live.who.is_none() {
            // Браузеру выдана кука в ответе на прошлую пачку — с этой он её предъявляет.
            live.device = v.cookie.id().to_owned();
            live.cookie_valid = matches!(v.cookie, Cookie::Valid(_));
        }
        if live.profile.is_none()
            && let Some(profile) = v.profile.take()
        {
            self.by_profile
                .entry(profile.clone())
                .or_default()
                .push(sid.clone());
            live.profile = Some(profile);
        }
        if let Some(index) = start.filter(|_| !live.started) {
            live.start(
                &v.events[index],
                &v,
                &self.keys,
                self.fingerprint,
                self.zone,
            );
        }

        // Класс по признакам захода — пока человек себя не проявил.
        if live.who.is_none() {
            let verdict = classify::baseline(&Signals {
                probe: live.probe,
                robot: v.robot,
                webdriver: live.webdriver,
                renderer: live.renderer.as_deref(),
                network: live.attrs.net,
                client_matches: v.client_matches,
            });
            if live.counted.is_none() {
                // Сессии устройства считаются и по куке, и по профилю: одна из опор может быть потеряна.
                if live.cookie_valid {
                    live.demoted |= self.guard.session_opened(&live.device, v.now, today);
                }
                if let Some(profile) = &live.profile {
                    live.demoted |= self.guard.session_opened(profile, v.now, today);
                }
            }
            live.class = verdict.class;
            live.bot = verdict.bot;
            live.reason = if live.demoted && verdict.class == Class::Unclear {
                reason::TOO_MANY_SESSIONS
            } else {
                verdict.reason
            };
            // Суточный трафик: заход считается при первом появлении; сменился класс — переносится.
            let key = live.traffic_key();
            if live.counted.as_ref() != Some(&key) {
                if let Some(old) = live.counted.replace(key.clone()) {
                    self.pending.traffic(old, -1);
                } else {
                    let labels = [("class", live.class.traffic()), ("reason", live.reason)];
                    self.metrics.inc("insight_sessions_total", &labels);
                }
                self.pending.traffic(key, 1);
            }
            // Профиль уже соединялся с медиаузлом — сессия догнала свой звонок.
            if live.class == Class::Unclear
                && live
                    .profile
                    .as_ref()
                    .is_some_and(|p| self.confirmed.contains_key(p))
            {
                live.want = Some(Evidence::Media);
            }
            // Своя проверка, робот или автоматика: факты ядра об этом профиле в цифры не пойдут.
            if matches!(live.class, Class::Own | Class::Bot | Class::Automation)
                && let Some(profile) = &live.profile
            {
                self.outsiders.insert(profile.clone(), v.now);
            }
        }

        let events = std::mem::take(&mut v.events);
        self.metrics
            .add("insight_events_accepted_total", &[], events.len() as u64);
        let now_ms = v.now.timestamp_millis();
        for mut event in events {
            let Some(live) = self.sessions.get_mut(&sid) else {
                break;
            };
            live.events += 1;
            if live.events > SESSION_EVENTS {
                self.metrics.inc(
                    "insight_events_dropped_total",
                    &[("reason", "session_full")],
                );
                continue;
            }
            let at = from_ms(event::moment(event.at, now_ms));
            match event.name {
                "engaged" => {
                    self.engaged(&sid, event.at, v.proof.take(), v.now);
                    event.props.remove("proof");
                }
                // Признаки отпечатка сведены в HMAC; сами они не хранятся.
                "session_start" => {
                    event.props.remove("fp");
                }
                _ => {}
            }
            if self
                .sessions
                .get(&sid)
                .is_some_and(|live| live.who.is_some())
            {
                self.record(&sid, event, at, false);
            } else {
                self.hold(&sid, event, at);
            }
        }
        if self
            .sessions
            .get(&sid)
            .is_some_and(|live| live.want.is_some())
            && let Err(error) = self.promote(&sid, v.now).await
        {
            // Сессия остаётся ждать: следующая запись попробует снова.
            self.db_error("promote", &error);
        }
    }

    /// Забыть сессию: её изменения — в запись, её события, ждавшие человека, — прочь.
    fn forget(&mut self, sid: &str) {
        let Some(live) = self.sessions.remove(sid) else {
            return;
        };
        if live.who.is_some() && live.dirty {
            self.pending
                .sessions
                .insert(sid.to_owned(), session_update(&live));
        }
        self.held_total = self.held_total.saturating_sub(live.held.len());
        if let Some(sids) = live
            .profile
            .as_ref()
            .and_then(|p| self.by_profile.get_mut(p))
        {
            sids.retain(|other| other != sid);
        }
    }

    /// Памяти под сессии больше нет: вытеснить десятую часть — самые давние из тех, кто не человек.
    fn evict(&mut self) {
        let mut idle: Vec<(DateTime<Utc>, String)> = self
            .sessions
            .iter()
            .filter(|(_, live)| live.who.is_none() && live.want.is_none())
            .map(|(sid, live)| (live.last_seen, sid.clone()))
            .collect();
        idle.sort();
        idle.truncate(LIVE_SESSIONS / 10);
        self.metrics
            .add("insight_sessions_evicted_total", &[], idle.len() as u64);
        for (_, sid) in idle {
            self.forget(&sid);
        }
    }

    /// Событие `engaged`: человек действовал. Принимается у сессии «неясно», если задача решена и страница
    /// была видна не меньше трёх секунд (по часам службы или по разнице часов клиента).
    fn engaged(&mut self, sid: &str, at_raw: i64, proof: Option<Solved>, now: DateTime<Utc>) {
        let Some(live) = self.sessions.get_mut(sid) else {
            return;
        };
        if live.class != Class::Unclear || live.who.is_some() || live.want.is_some() {
            return;
        }
        let visible = (now - live.first_seen).num_milliseconds() >= classify::MIN_VISIBLE_MS
            || live
                .start_raw
                .is_some_and(|start| at_raw - start >= classify::MIN_VISIBLE_MS);
        let refusal = if live.demoted {
            Some("demoted")
        } else if proof.is_none() {
            Some("proof")
        } else if !visible {
            Some("early")
        } else {
            None
        };
        match refusal {
            Some(why) => self
                .metrics
                .inc("insight_engaged_refused_total", &[("reason", why)]),
            None => {
                live.want = Some(Evidence::Engaged);
                live.proof = proof;
            }
        }
    }

    /// Событие сессии, которая (пока) не человек. У «неясно» события ждут в памяти: проявит себя человек —
    /// запишутся. Ошибка «неясно» считается сразу: сбой при открытии страницы случается раньше любого действия.
    fn hold(&mut self, sid: &str, event: Event, at: DateTime<Utc>) {
        let Some(live) = self.sessions.get_mut(sid) else {
            return;
        };
        if live.class != Class::Unclear {
            self.metrics
                .inc("insight_events_dropped_total", &[("reason", "not_human")]);
            return;
        }
        let mut counted = false;
        if event.name == "error" {
            let code = event.text("code").unwrap_or("UNKNOWN").to_owned();
            let scope = event.text("scope").unwrap_or("app").to_owned();
            let version = event::version_series(&live.attrs.version);
            let key = errors::key(&code, &scope, &version);
            // Сессия «неясно» ничем не доказала, что за ней человек: разных ошибок от неё — немного, а новых
            // групп от всех таких сессий — не больше двухсот в час.
            let hour = at.timestamp() / 3600;
            if self.unclear_errors.0 != hour {
                self.unclear_errors = (hour, HashSet::new());
            }
            let known = live.error_keys.contains(&key);
            let room = live.error_keys.len() < UNCLEAR_ERRORS
                && (self.unclear_errors.1.contains(&key)
                    || self.unclear_errors.1.len() < UNCLEAR_ERRORS_PER_HOUR);
            if !known && !room {
                self.metrics.inc(
                    "insight_events_dropped_total",
                    &[("reason", "too_many_names")],
                );
                return;
            }
            self.unclear_errors.1.insert(key.clone());
            let first = live.error_keys.insert(key);
            live.errors += 1;
            let sample = error_sample(live, &event, at);
            let day = local_day(at, self.zone);
            let note = ErrorNote {
                code: &code,
                scope: &scope,
                version: &version,
                source: "client",
                at,
                day,
                dims: live.error_dims(),
                first_in_session: first,
                person: None,
                sample,
                count: 1,
            };
            note_error(&mut self.pending, note);
            counted = true;
        }
        if live.held.len() >= HELD_EVENTS || self.held_total >= HELD_TOTAL {
            self.metrics
                .inc("insight_events_dropped_total", &[("reason", "held_full")]);
            return;
        }
        self.held_total += 1;
        live.held.push((event, at, counted));
    }

    /// Событие сессии человека: строка события и прибавки к суточным строкам.
    fn record(&mut self, sid: &str, event: Event, at: DateTime<Utc>, counted: bool) {
        let Some(live) = self.sessions.get_mut(sid) else {
            return;
        };
        let Some(person) = live.who else { return };
        let day = local_day(at, self.zone);
        let pending = &mut self.pending;
        let name = event.name;
        let mut props = event.props;
        let word = |props: &serde_json::Map<String, Value>, key: &str| {
            props
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let number = |props: &serde_json::Map<String, Value>, key: &str| {
            props.get(key).and_then(Value::as_i64).unwrap_or(0)
        };
        let mut room = None;
        match name {
            "engaged" => live.step = live.step.max(2),
            "screen" => {
                let screen = word(&props, "name");
                pending.count(day, "screen", &screen, "", 1);
                if screen == "prejoin" {
                    live.step = live.step.max(3);
                }
            }
            "prejoin" => {
                pending.count(day, "prejoin", &word(&props, "from"), "", 1);
                live.step = live.step.max(3);
            }
            "permission" => {
                let (device, result) = (word(&props, "device"), word(&props, "result"));
                pending.count(day, "permission", &device, &result, 1);
                if result == "granted" && device != "screen" {
                    live.step = live.step.max(4);
                }
            }
            "feature" => {
                let feature = word(&props, "name");
                let tag = format!("f:{feature}");
                if !live.names.contains(&tag) {
                    if live.names.len() >= SESSION_NAMES {
                        self.metrics.inc(
                            "insight_events_dropped_total",
                            &[("reason", "too_many_names")],
                        );
                        return;
                    }
                    live.names.insert(tag);
                    pending.count(day, "feature_sessions", &feature, "", 1);
                }
                pending.count(day, "feature", &feature, "", number(&props, "count").max(1));
            }
            "integration_view" => {
                // Номер встречи заменяется псевдонимом и в полях события не остаётся.
                room = props
                    .remove("room")
                    .and_then(|r| r.as_str().map(|r| self.keys.room(r)));
                let (kind, variant) = (word(&props, "kind"), word(&props, "variant"));
                let tag = format!("v:{kind}/{variant}");
                if !live.names.contains(&tag) {
                    if live.names.len() >= SESSION_NAMES {
                        self.metrics.inc(
                            "insight_events_dropped_total",
                            &[("reason", "too_many_names")],
                        );
                        return;
                    }
                    live.names.insert(tag);
                }
                let view = [
                    number(&props, "seconds"),
                    number(&props, "stalls"),
                    number(&props, "stall_ms"),
                ];
                if event::KINDS.contains(&kind.as_str()) {
                    pending.day(person, day).add(&format!("{kind}_s"), view[0]);
                    let total = pending
                        .integration_days
                        .entry((day, kind.clone(), variant, person))
                        .or_default();
                    for (sum, part) in total.iter_mut().zip(view) {
                        *sum += part;
                    }
                    let run = room
                        .as_ref()
                        .and_then(|room| self.open_runs.get(&(room.clone(), kind)));
                    if let Some(run) = run.and_then(|id| self.runs.get_mut(id)) {
                        run.viewed(person, at, view);
                    }
                }
            }
            "error" => {
                let code = word(&props, "code");
                let code = if code.is_empty() {
                    "UNKNOWN".to_owned()
                } else {
                    code
                };
                let scope = word(&props, "scope");
                let scope = if scope.is_empty() {
                    "app".to_owned()
                } else {
                    scope
                };
                let version = event::version_series(&live.attrs.version);
                // На каком шаге воронки человек увидел ошибку — и в какую группу она попала: по ключу отчёт
                // об одной группе находит её последние образцы.
                let key = errors::key(&code, &scope, &version);
                if !counted
                    && !live.error_keys.contains(&key)
                    && live.error_keys.len() >= SESSION_NAMES
                {
                    self.metrics.inc(
                        "insight_events_dropped_total",
                        &[("reason", "too_many_names")],
                    );
                    return;
                }
                props.insert("step".to_owned(), json!(live.step));
                props.insert("key".to_owned(), json!(key));
                if counted {
                    *pending.error_people.entry((key, day, person)).or_default() += 1;
                } else {
                    let first = live.error_keys.insert(key);
                    live.errors += 1;
                    let sample = error_sample(
                        live,
                        &Event {
                            name,
                            at: 0,
                            props: props.clone(),
                        },
                        at,
                    );
                    let note = ErrorNote {
                        code: &code,
                        scope: &scope,
                        version: &version,
                        source: "client",
                        at,
                        day,
                        dims: live.error_dims(),
                        first_in_session: first,
                        person: Some(person),
                        sample,
                        count: 1,
                    };
                    note_error(pending, note);
                }
                let delta = pending.day(person, day);
                delta.add("errors", 1);
                if !live.error_session_counted {
                    live.error_session_counted = true;
                    delta.add("error_sessions", 1);
                }
            }
            "invite" => {
                pending.day(person, day).add("invites", 1);
                pending.count(day, "invite", &word(&props, "how"), "", 1);
            }
            "leave" => pending.count(day, "leave", &word(&props, "reason"), "", 1),
            _ => {}
        }
        // Человек был в этот день, даже если сессия началась вчера.
        pending.day(person, day);
        live.dirty = true;
        pending.event(EventRow {
            at,
            day,
            sid: Some(sid.to_owned()),
            person: Some(person),
            name,
            room,
            props: Value::Object(props),
        });
    }

    // ── Человек ──────────────────────────────────────────────────────────────────────────────────────

    /// Сессия проявила себя человеком: узнать, какой это человек, и завести его строки.
    async fn promote(&mut self, sid: &str, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        let today = self.today(now);
        let Some(live) = self.sessions.get_mut(sid) else {
            return Ok(());
        };
        let Some(evidence) = live.want else {
            return Ok(());
        };
        if live.who.is_some() || live.class != Class::Unclear {
            live.want = None;
            return Ok(());
        }
        // Ответ на задачу годится один раз — и после перезапуска службы тоже.
        if evidence == Evidence::Engaged && !live.proof_spent {
            let Some(proof) = live.proof.clone() else {
                live.want = None;
                return Ok(());
            };
            let fresh = sqlx::query(
                "INSERT INTO an_proofs (signature, expires_at) VALUES ($1, $2) ON CONFLICT (signature) DO NOTHING",
            )
            .bind(&proof.signature)
            .bind(from_ms(proof.expires_ms))
            .execute(&self.pool)
            .await?
            .rows_affected()
                == 1;
            let Some(live) = self.sessions.get_mut(sid) else {
                return Ok(());
            };
            if !fresh {
                live.want = None;
                self.metrics.inc(
                    "insight_engaged_refused_total",
                    &[("reason", "proof_reused")],
                );
                return Ok(());
            }
            live.proof_spent = true;
        }
        let Some(live) = self.sessions.get(sid) else {
            return Ok(());
        };
        let arrival = Arrival {
            device: live.device.clone(),
            cookie_valid: live.cookie_valid,
            profile: live.profile.clone(),
            fp: live.fp.clone(),
            origin: Origin {
                device_class: live.attrs.device_class.to_owned(),
                fp_strength: live.fp_strength,
                net: live.subnet.clone(),
                asn: live.attrs.asn,
                country: live.attrs.country.clone(),
                tz: live.tz.clone(),
            },
            attrs: live.attrs.clone(),
            started_at: live.started_at,
            day: live.day,
            step: live.step,
            errors: live.errors,
        };
        let found = self.resolve(&arrival, now).await?;
        // Понижение подсети: новым устройствам строки не заводятся. Дозвонившегося это не касается —
        // соединение с медиаузлом не подделать.
        let new_device = matches!(found.via, Via::Fingerprint | Via::New);
        if new_device
            && evidence == Evidence::Engaged
            && !self.guard.new_device(&arrival.origin.net, now, today)
        {
            if let Some(live) = self.sessions.get_mut(sid) {
                live.want = None;
                live.reason = reason::SUBNET_FLOOD;
            }
            self.metrics
                .inc("insight_engaged_refused_total", &[("reason", "subnet")]);
            return Ok(());
        }
        let reissue = found.device != arrival.device;
        let renew = found
            .cookie_at
            .is_some_and(|at| now - at >= Duration::days(COOKIE_RENEW_DAYS));
        let human = if evidence == Evidence::Media {
            Class::Confirmed
        } else {
            Class::Engaged
        };
        let why = if evidence == Evidence::Media {
            reason::MEDIA
        } else {
            reason::ENGAGED
        };
        let person = self
            .enroll(sid, &arrival, &found, human, why, reissue || renew, now)
            .await?;

        let Some(live) = self.sessions.get_mut(sid) else {
            return Ok(());
        };
        live.who = Some(person);
        live.device = found.device.clone();
        live.via = found.via;
        live.want = None;
        live.class = human;
        live.reason = why;
        live.step = live
            .step
            .max(if evidence == Evidence::Media { 6 } else { 2 });
        let key = live.traffic_key();
        if let Some(old) = live.counted.replace(key.clone()) {
            self.pending.traffic(old, -1);
        }
        self.pending.traffic(key, 1);
        self.metrics.inc(
            "insight_sessions_total",
            &[("class", human.human()), ("reason", why)],
        );
        self.metrics
            .inc("insight_identity_total", &[("via", found.via.word())]);
        let day = live.day;
        let delta = self.pending.day(person, day);
        delta.add("sessions", 1);
        if live.attrs.vpn {
            delta.add("vpn_sessions", 1);
        }
        if evidence == Evidence::Media {
            delta.confirmed = true;
            let first = self.pending.called.entry(person).or_insert(day);
            *first = (*first).min(day);
            self.guard.call(&live.subnet, now);
        }
        if let Some(profile) = &live.profile {
            self.known.insert(
                profile.clone(),
                Who {
                    person,
                    device: found.device.clone(),
                },
            );
            self.unknown.remove(profile);
        }
        if reissue || renew {
            self.hints
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sid.to_owned(), found.device.clone());
        }
        let held = std::mem::take(&mut live.held);
        self.held_total = self.held_total.saturating_sub(held.len());
        for (event, at, counted) in held {
            self.record(sid, event, at, counted);
        }
        Ok(())
    }

    /// Правило личности §4.5: только чтение.
    async fn resolve(&self, arrival: &Arrival, now: DateTime<Utc>) -> Result<Found, sqlx::Error> {
        // 1. Кука верна и устройство известно.
        if arrival.cookie_valid {
            let known: Option<(i64, DateTime<Utc>)> =
                sqlx::query_as("SELECT person_id, cookie_at FROM an_devices WHERE id = $1")
                    .bind(&arrival.device)
                    .fetch_optional(&self.pool)
                    .await?;
            if let Some((person, cookie_at)) = known {
                return Ok(Found {
                    via: Via::Cookie,
                    device: arrival.device.clone(),
                    person: Some(person),
                    root: None,
                    cookie_at: Some(cookie_at),
                });
            }
        }
        // 2. Профиль известен: его устройство, кука выдаётся заново.
        if let Some(profile) = &arrival.profile {
            let known: Option<(String, i64, DateTime<Utc>)> = sqlx::query_as(
                "SELECT d.id, d.person_id, d.cookie_at FROM an_profiles p JOIN an_devices d ON d.id = p.device_id \
                 WHERE p.profile = $1",
            )
            .bind(profile)
            .fetch_optional(&self.pool)
            .await?;
            if let Some((device, person, cookie_at)) = known {
                return Ok(Found {
                    via: Via::Profile,
                    device,
                    person: Some(person),
                    root: None,
                    cookie_at: Some(cookie_at),
                });
            }
        }
        // 3. Устройство новое. 3а — узнать человека по отпечатку.
        let new = |via, root| Found {
            via,
            device: arrival.device.clone(),
            person: None,
            root,
            cookie_at: None,
        };
        let Some(fp) = arrival.fp.as_ref().filter(|_| self.fingerprint) else {
            return Ok(new(Via::New, None));
        };
        let rows: Vec<(String, i64, String, Option<i64>, String, String)> = sqlx::query_as(
            "SELECT d.id, COALESCE(p.merged_into, p.id), d.net, d.asn, d.country, d.tz \
             FROM an_devices d JOIN an_persons p ON p.id = d.person_id \
             WHERE d.fp = $1 AND d.class = 'desktop' AND d.client = $2 AND d.os = $3 AND d.last_at >= $4 \
             ORDER BY d.last_at DESC LIMIT 20",
        )
        .bind(fp)
        .bind(arrival.attrs.client)
        .bind(arrival.attrs.os)
        .bind(now - Duration::days(identity::FINGERPRINT_DAYS))
        .fetch_all(&self.pool)
        .await?;
        let candidates: Vec<Candidate> = rows
            .into_iter()
            .map(|(device, person, net, asn, country, tz)| {
                let active = self.active_now(&device, now);
                Candidate {
                    device,
                    person,
                    net,
                    asn,
                    country,
                    tz,
                    active,
                }
            })
            .collect();
        Ok(
            match identity::fingerprint_match(&arrival.origin, &candidates) {
                Some(same) => new(Via::Fingerprint, Some(same.person)),
                None => new(Via::New, None),
            },
        )
    }

    /// На связи ли устройство прямо сейчас: живая сессия или присутствие во встрече.
    fn active_now(&self, device: &str, now: DateTime<Utc>) -> bool {
        let session = self.sessions.values().any(|live| {
            live.who.is_some()
                && live.device == device
                && now - live.last_seen < Duration::minutes(SESSION_IDLE_MINUTES)
        });
        session || self.meetings.values().any(|m| m.has_device(device))
    }

    /// Завести строки человека, устройства, профиля и сессии одной транзакцией. Возвращает человека.
    #[allow(clippy::too_many_arguments)]
    async fn enroll(
        &self,
        sid: &str,
        arrival: &Arrival,
        found: &Found,
        human: Class,
        why: &'static str,
        fresh_cookie: bool,
        now: DateTime<Utc>,
    ) -> Result<i64, sqlx::Error> {
        let a = &arrival.attrs;
        let mut tx = self.pool.begin().await?;
        let person = match found.person {
            Some(person) => {
                sqlx::query(
                    "UPDATE an_devices SET last_at = $2, net = $3, asn = $4, country = $5, tz = $6, \
                       fp = COALESCE($7, fp), fp_strength = CASE WHEN $7 IS NULL THEN fp_strength ELSE $8 END, \
                       link = CASE WHEN link = 'fingerprint' OR NOT $9 THEN link ELSE 'profile' END, \
                       cookie_at = CASE WHEN $10 THEN $2 ELSE cookie_at END \
                     WHERE id = $1",
                )
                .bind(&found.device)
                .bind(now)
                .bind(&arrival.origin.net)
                .bind(a.asn)
                .bind(&a.country)
                .bind(&arrival.origin.tz)
                .bind(&arrival.fp)
                .bind(arrival.origin.fp_strength)
                .bind(found.via == Via::Profile)
                .bind(fresh_cookie)
                .execute(&mut *tx)
                .await?;
                person
            }
            None => {
                let person: i64 = sqlx::query_scalar(
                    "INSERT INTO an_persons (merged_into, first_at, first_day, last_day, landing, source, \
                       utm_source, utm_medium, utm_campaign, client, os, country) \
                     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
                )
                .bind(found.root)
                .bind(arrival.started_at)
                .bind(arrival.day)
                .bind(&a.landing)
                .bind(&a.source)
                .bind(&a.utm[0])
                .bind(&a.utm[1])
                .bind(&a.utm[2])
                .bind(a.client)
                .bind(a.os)
                .bind(&a.country)
                .fetch_one(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO an_devices (id, person_id, client, os, browser, class, fp, fp_strength, link, \
                       created_at, last_at, cookie_at, net, asn, country, tz) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10, $11, $12, $13, $14)",
                )
                .bind(&found.device)
                .bind(person)
                .bind(a.client)
                .bind(a.os)
                .bind(a.browser)
                .bind(a.device_class)
                .bind(&arrival.fp)
                .bind(arrival.origin.fp_strength)
                .bind(if found.via == Via::Fingerprint { "fingerprint" } else { "cookie" })
                .bind(now)
                .bind(&arrival.origin.net)
                .bind(a.asn)
                .bind(&a.country)
                .bind(&arrival.origin.tz)
                .execute(&mut *tx)
                .await?;
                person
            }
        };
        // Незнакомый профиль привязывается к устройству; знакомый остаётся у своего.
        if let Some(profile) = &arrival.profile {
            sqlx::query(
                "INSERT INTO an_profiles (profile, device_id, created_at) VALUES ($1, $2, $3) \
                 ON CONFLICT (profile) DO NOTHING",
            )
            .bind(profile)
            .bind(&found.device)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO an_sessions (sid, person_id, device_id, started_at, last_at, day, client, version, os, \
               browser, class, country, asn, net, vpn, landing, source, utm_source, utm_medium, utm_campaign, \
               human, reason, via, step, errors) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, \
               $21, $22, $23, $24, $25) \
             ON CONFLICT (sid) DO NOTHING",
        )
        .bind(sid)
        .bind(person)
        .bind(&found.device)
        .bind(arrival.started_at)
        .bind(now)
        .bind(arrival.day)
        .bind(a.client)
        .bind(&a.version)
        .bind(a.os)
        .bind(a.browser)
        .bind(a.device_class)
        .bind(&a.country)
        .bind(a.asn)
        .bind(a.net)
        .bind(a.vpn)
        .bind(&a.landing)
        .bind(&a.source)
        .bind(&a.utm[0])
        .bind(&a.utm[1])
        .bind(&a.utm[2])
        .bind(human.human())
        .bind(why)
        .bind(found.via.word())
        .bind(arrival.step)
        .bind(arrival.errors)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(person)
    }

    /// Сессия человека из базы — после перезапуска службы.
    async fn restore(&self, sid: &str) -> Result<Option<Saved>, sqlx::Error> {
        let row: Option<SavedRow> = sqlx::query_as(
            "SELECT person_id, device_id, human, step, errors, started_at, day FROM an_sessions WHERE sid = $1",
        )
        .bind(sid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(
            |(person, device, human, step, errors, started_at, day)| Saved {
                person,
                device,
                confirmed: human == "confirmed",
                step,
                errors,
                started_at,
                day,
            },
        ))
    }

    /// Человек и устройство профиля. Незнакомый профиль минуту не переспрашивается.
    async fn who(&mut self, profile: &str) -> Result<Option<Who>, sqlx::Error> {
        if let Some(who) = self.known.get(profile) {
            return Ok(Some(who.clone()));
        }
        if self
            .unknown
            .get(profile)
            .is_some_and(|at| self.now - *at < Duration::seconds(60))
        {
            return Ok(None);
        }
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT d.person_id, d.id FROM an_profiles p JOIN an_devices d ON d.id = p.device_id WHERE p.profile = $1",
        )
        .bind(profile)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some((person, device)) => {
                let who = Who { person, device };
                self.known.insert(profile.to_owned(), who.clone());
                Some(who)
            }
            None => {
                self.unknown.insert(profile.to_owned(), self.now);
                None
            }
        })
    }

    /// Самая свежая живая сессия профиля.
    fn live_of(&self, profile: &str) -> Option<&String> {
        let sids = self.by_profile.get(profile)?;
        sids.iter()
            .filter(|sid| self.sessions.contains_key(*sid))
            .max_by_key(|sid| self.sessions[*sid].last_seen)
    }

    /// Сессии человека с этим профилем дошли до шага воронки.
    fn advance(&mut self, profile: &str, step: i16) {
        for sid in self.by_profile.get(profile).into_iter().flatten() {
            if let Some(live) = self
                .sessions
                .get_mut(sid)
                .filter(|live| live.who.is_some() && live.step < step)
            {
                live.step = step;
                live.dirty = true;
            }
        }
    }

    // ── Уборка и запись ──────────────────────────────────────────────────────────────────────────────

    /// Забыть то, что устарело: сессии после 30 минут тишины, счётчики понижения, зависшие встречи.
    pub fn sweep(&mut self, now: DateTime<Utc>) {
        self.now = self.now.max(now);
        let today = self.today(now);
        let idle = Duration::minutes(SESSION_IDLE_MINUTES);
        let expired: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, live)| now - live.last_seen >= idle)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in expired {
            self.forget(&sid);
        }
        self.outsiders
            .retain(|_, at| now - *at < Duration::hours(OUTSIDER_HOURS));
        self.by_profile.retain(|_, sids| !sids.is_empty());
        self.guard.sweep(now, today);
        self.confirmed.retain(|_, at| now - *at < idle);
        self.unknown
            .retain(|_, at| now - *at < Duration::seconds(60));
        if self.known.len() > 100_000 {
            self.known.clear();
        }
        self.hints
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|sid, _| self.sessions.contains_key(sid));
        self.sweep_meetings(now);
        self.metrics
            .set("insight_live_sessions", &[], self.sessions.len() as f64);
    }

    /// Записать накопленное. Отказ базы оставляет всё в памяти до следующего раза.
    pub async fn flush(&mut self, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        self.now = self.now.max(now);
        // Сессии, чьё повышение не удалось из-за базы, пробуют снова.
        let waiting: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, live)| live.want.is_some())
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in waiting {
            if let Err(error) = self.promote(&sid, now).await {
                self.db_error("promote", &error);
                break;
            }
        }
        for (sid, live) in self
            .sessions
            .iter_mut()
            .filter(|(_, live)| live.dirty && live.who.is_some())
        {
            self.pending
                .sessions
                .insert(sid.clone(), session_update(live));
            live.dirty = false;
        }
        let idle = self.pending.is_empty()
            && self.finished.is_empty()
            && !self.meetings.values().any(|m| m.dirty)
            && !self.runs.values().any(|r| r.dirty);
        if idle {
            return Ok(());
        }
        let started = Instant::now();
        let written = self.write().await;
        self.metrics.observe_write(started.elapsed().as_secs_f64());
        if self.pending.lost_events > 0 {
            self.metrics.add(
                "insight_events_dropped_total",
                &[("reason", "db")],
                self.pending.lost_events,
            );
            self.pending.lost_events = 0;
        }
        match written {
            Ok(()) => {
                self.failed_flushes = 0;
                self.pending = Pending::default();
                self.fact_seen.clear();
                Ok(())
            }
            Err(error) => {
                self.db_error("flush", &error);
                self.failed_flushes += 1;
                if self.failed_flushes >= FAILED_FLUSHES {
                    tracing::error!(%error, "запись не удалась много раз подряд: накопленное выброшено");
                    self.metrics.add(
                        "insight_events_dropped_total",
                        &[("reason", "db")],
                        self.pending.events.len() as u64,
                    );
                    self.failed_flushes = 0;
                    self.pending = Pending::default();
                    self.fact_seen.clear();
                    self.discard_meetings();
                }
                Err(error)
            }
        }
    }

    async fn write(&mut self) -> Result<(), sqlx::Error> {
        let months: HashSet<NaiveDate> = self
            .pending
            .events
            .iter()
            .map(|e| crate::days::month_bounds(e.day).0)
            .collect();
        for month in months {
            if !self.partitions.contains(&month) {
                crate::db::ensure_partition(&self.pool, month).await?;
                self.partitions.insert(month);
            }
        }
        let mut tx = self.pool.begin().await?;
        self.pending.write(&mut tx, self.now).await?;
        let ids = self.write_meetings(&mut tx).await?;
        self.write_runs(&mut tx).await?;
        tx.commit().await?;
        self.settle_meetings(ids);
        Ok(())
    }

    /// Принять пачку фактов; `Err` — базе плохо, отправитель повторит.
    pub async fn accept(&mut self, facts: Facts, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        let result = self.facts(facts, now).await;
        if let Err(error) = &result {
            self.db_error("facts", error);
        }
        result
    }
}

/// Что сессия принесла к моменту, когда стала человеком.
struct Arrival {
    device: String,
    cookie_valid: bool,
    profile: Option<String>,
    fp: Option<String>,
    origin: Origin,
    attrs: Attrs,
    started_at: DateTime<Utc>,
    day: NaiveDate,
    step: i16,
    errors: i32,
}

/// Итог правила личности.
struct Found {
    via: Via,
    device: String,
    /// Человек известного устройства; у нового устройства — `None`.
    person: Option<i64>,
    /// К кому привязать нового человека, узнанного по отпечатку.
    root: Option<i64>,
    cookie_at: Option<DateTime<Utc>>,
}

/// Строка `an_sessions`: человек, устройство, класс, шаг, ошибок, начало, день.
type SavedRow = (i64, String, String, i16, i32, DateTime<Utc>, NaiveDate);

/// Сессия человека, сохранённая до перезапуска.
struct Saved {
    person: i64,
    device: String,
    confirmed: bool,
    step: i16,
    errors: i32,
    started_at: DateTime<Utc>,
    day: NaiveDate,
}

impl Saved {
    fn apply(self, live: &mut Live) {
        live.who = Some(self.person);
        live.device = self.device;
        live.class = if self.confirmed {
            Class::Confirmed
        } else {
            Class::Engaged
        };
        live.reason = if self.confirmed {
            reason::MEDIA
        } else {
            reason::ENGAGED
        };
        live.step = self.step;
        live.errors = self.errors;
        live.error_session_counted = self.errors > 0;
        live.started_at = self.started_at;
        live.day = self.day;
        live.started = true;
        // Заход уже посчитан до перезапуска.
        live.counted = Some(live.traffic_key());
    }
}

/// Что изменилось у строки сессии с прошлой записи.
fn session_update(live: &Live) -> SessionUpdate {
    SessionUpdate {
        last_at: live.last_seen,
        human: live.class.human(),
        reason: live.reason,
        step: live.step,
        errors: live.errors,
    }
}

/// Образец ошибки для пульта: машинные поля события и срезы сессии — без ключей человека.
fn error_sample(live: &Live, event: &Event, at: DateTime<Utc>) -> Value {
    json!({
        "at": at,
        "screen": event.text("screen"),
        "fatal": event.flag("fatal"),
        "detail": event.text("detail"),
        "client": live.attrs.client,
        "version": live.attrs.version,
        "os": live.attrs.os,
        "browser": live.attrs.browser,
        "step": live.step,
    })
}

/// Команда движку.
pub enum Command {
    Visit(Box<Visit>),
    /// Факты и ответ отправителю: `true` — приняты.
    Facts(Facts, DateTime<Utc>, tokio::sync::oneshot::Sender<bool>),
}

/// Крутить движок, пока жива очередь команд: разбирать команды, писать раз в две секунды, убирать раз в
/// полминуты. Очередь закрылась (служба останавливается) — записать остаток.
pub async fn run(mut engine: Engine, mut commands: tokio::sync::mpsc::Receiver<Command>) {
    let mut flush = tokio::time::interval(std::time::Duration::from_secs(2));
    let mut sweep = tokio::time::interval(std::time::Duration::from_secs(30));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Visit(visit)) => engine.visit(*visit).await,
                Some(Command::Facts(facts, now, answer)) => {
                    let accepted = engine.accept(facts, now).await.is_ok();
                    let _ = answer.send(accepted);
                }
                None => break,
            },
            _ = flush.tick() => {
                let _ = engine.flush(Utc::now()).await;
                engine.metrics.set("insight_queue_depth", &[], commands.len() as f64);
            }
            _ = sweep.tick() => engine.sweep(Utc::now()),
        }
    }
    if let Err(error) = engine.flush(Utc::now()).await {
        tracing::error!(%error, "остаток не записан при остановке");
    }
}
