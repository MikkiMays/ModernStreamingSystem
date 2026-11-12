//! Человек или нет (§5 проекта). Каждая сессия получает класс и причину; строки людей создаёт только класс
//! «человек», всё остальное уходит в суточный трафик.

use std::collections::{HashMap, VecDeque};

use chrono::{DateTime, Duration, NaiveDate, Utc};

use crate::net::HOSTING;
use crate::ua::{Robot, RobotKind};

/// Класс сессии. Слова — как в отчётах (`contracts/insight-reports.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Class {
    /// «свои»: автотесты, дымовые и нагрузочные проверки, пробы мониторинга — подписанный `X-Cord-Probe`.
    Own,
    /// «робот · поисковый»: агент из списка роботов.
    Bot,
    /// «робот · автоматика»: браузер под управлением программы.
    Automation,
    /// «неясно»: признаков робота нет, признаков человека тоже.
    Unclear,
    /// «человек · вовлечён»: настоящее действие, страница видна ≥ 3 с, задача «не робот» решена.
    Engaged,
    /// «человек · подтверждён»: соединился с медиаузлом — это видел сервер.
    Confirmed,
}

impl Class {
    pub fn is_human(self) -> bool {
        matches!(self, Class::Engaged | Class::Confirmed)
    }

    /// Слово класса в суточном трафике: у людей оно одно.
    pub fn traffic(self) -> &'static str {
        match self {
            Class::Own => "own",
            Class::Bot => "bot",
            Class::Automation => "automation",
            Class::Unclear => "unclear",
            Class::Engaged | Class::Confirmed => "human",
        }
    }

    /// Слово класса человека в строке сессии.
    pub fn human(self) -> &'static str {
        match self {
            Class::Confirmed => "confirmed",
            _ => "engaged",
        }
    }
}

/// Причины классов — для строки сессии и метрик службы.
pub mod reason {
    pub const PROBE: &str = "probe";
    pub const ROBOT: &str = "robot";
    pub const HEADLESS: &str = "headless";
    pub const WEBDRIVER: &str = "webdriver";
    pub const SOFTWARE_GL: &str = "software_gl";
    pub const CLIENT_MISMATCH: &str = "client_mismatch";
    pub const SILENT: &str = "silent";
    pub const TOO_MANY_SESSIONS: &str = "too_many_sessions";
    pub const SUBNET_FLOOD: &str = "subnet_flood";
    pub const ENGAGED: &str = "engaged";
    pub const MEDIA: &str = "media";
}

/// Что известно о заходе до каких-либо действий человека.
#[derive(Debug, Clone, Default)]
pub struct Signals<'a> {
    /// Верная подпись своих проверок.
    pub probe: bool,
    /// Робот по `User-Agent`.
    pub robot: Option<Robot>,
    /// `navigator.webdriver`.
    pub webdriver: bool,
    /// Модель видеокарты из признаков клиента (`fp.glr`).
    pub renderer: Option<&'a str>,
    /// Класс сети адреса.
    pub network: &'a str,
    /// Сходится ли названный вид клиента с агентом.
    pub client_matches: bool,
}

/// Класс, причина и имя робота.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    pub class: Class,
    pub reason: &'static str,
    pub bot: &'static str,
}

/// Программная отрисовка: видеокарты нет, картинку считает процессор — так выглядит браузер на сервере.
pub fn software_renderer(renderer: &str) -> bool {
    let renderer = renderer.to_ascii_lowercase();
    ["swiftshader", "llvmpipe", "softpipe", "software rasterizer"]
        .iter()
        .any(|word| renderer.contains(word))
}

/// Класс захода по его признакам — до действий человека. Порядок правил — порядок таблицы §5: свои,
/// робот по агенту, автоматика, иначе «неясно».
pub fn baseline(signals: &Signals) -> Verdict {
    let verdict = |class, reason, bot| Verdict { class, reason, bot };
    if signals.probe {
        return verdict(Class::Own, reason::PROBE, "");
    }
    match signals.robot {
        Some(Robot {
            name,
            kind: RobotKind::Crawler,
        }) => return verdict(Class::Bot, reason::ROBOT, name),
        Some(Robot {
            kind: RobotKind::Automation,
            ..
        }) => return verdict(Class::Automation, reason::HEADLESS, ""),
        None => {}
    }
    if signals.webdriver {
        return verdict(Class::Automation, reason::WEBDRIVER, "");
    }
    // Программная отрисовка бывает и у человека (старый ноутбук, виртуальная машина) — автоматика это
    // только из сети хостинга.
    if signals.network == HOSTING && signals.renderer.is_some_and(software_renderer) {
        return verdict(Class::Automation, reason::SOFTWARE_GL, "");
    }
    if !signals.client_matches {
        return verdict(Class::Automation, reason::CLIENT_MISMATCH, "");
    }
    verdict(Class::Unclear, reason::SILENT, "")
}

/// Сколько мс страница должна быть видна, прежде чем действие считается человеческим.
pub const MIN_VISIBLE_MS: i64 = 3000;

/// Понижение (§5): устройство, открывшее больше 20 сессий в час, и подсеть, из которой за час пришло
/// больше 30 новых устройств без единого звонка, — «неясно» до конца суток, строки не создаются.
pub struct Guard {
    sessions: HashMap<String, VecDeque<DateTime<Utc>>>,
    devices: HashMap<String, NaiveDate>,
    arrivals: HashMap<String, VecDeque<DateTime<Utc>>>,
    calls: HashMap<String, DateTime<Utc>>,
    subnets: HashMap<String, NaiveDate>,
}

pub const SESSIONS_PER_HOUR: usize = 20;
pub const NEW_DEVICES_PER_HOUR: usize = 30;

impl Default for Guard {
    fn default() -> Self {
        Self::new()
    }
}

impl Guard {
    pub fn new() -> Self {
        Guard {
            sessions: HashMap::new(),
            devices: HashMap::new(),
            arrivals: HashMap::new(),
            calls: HashMap::new(),
            subnets: HashMap::new(),
        }
    }

    /// Устройство открыло сессию. Возвращает, понижено ли оно (сейчас или раньше сегодня).
    pub fn session_opened(&mut self, device: &str, now: DateTime<Utc>, today: NaiveDate) -> bool {
        let recent = self.sessions.entry(device.to_owned()).or_default();
        trim(recent, now);
        recent.push_back(now);
        if recent.len() > SESSIONS_PER_HOUR {
            self.devices.insert(device.to_owned(), today);
        }
        self.device_demoted(device, today)
    }

    pub fn device_demoted(&self, device: &str, today: NaiveDate) -> bool {
        self.devices.get(device).is_some_and(|day| *day >= today)
    }

    /// Из подсети пришло новое устройство. Возвращает, можно ли заводить ему строку.
    pub fn new_device(&mut self, subnet: &str, now: DateTime<Utc>, today: NaiveDate) -> bool {
        if subnet.is_empty() {
            return true;
        }
        if self.subnet_demoted(subnet, today) {
            return false;
        }
        let recent = self.arrivals.entry(subnet.to_owned()).or_default();
        trim(recent, now);
        recent.push_back(now);
        let called = self
            .calls
            .get(subnet)
            .is_some_and(|at| now - *at < Duration::hours(1));
        if recent.len() > NEW_DEVICES_PER_HOUR && !called {
            self.subnets.insert(subnet.to_owned(), today);
            return false;
        }
        true
    }

    pub fn subnet_demoted(&self, subnet: &str, today: NaiveDate) -> bool {
        self.subnets.get(subnet).is_some_and(|day| *day >= today)
    }

    /// Устройство из подсети соединилось с медиаузлом: в подсети есть настоящие люди, понижение снимается.
    pub fn call(&mut self, subnet: &str, now: DateTime<Utc>) {
        if !subnet.is_empty() {
            self.calls.insert(subnet.to_owned(), now);
            self.subnets.remove(subnet);
        }
    }

    /// Забыть всё старше часа и понижения прошлых суток.
    pub fn sweep(&mut self, now: DateTime<Utc>, today: NaiveDate) {
        for map in [&mut self.sessions, &mut self.arrivals] {
            map.retain(|_, recent| {
                trim(recent, now);
                !recent.is_empty()
            });
        }
        self.calls.retain(|_, at| now - *at < Duration::hours(1));
        self.devices.retain(|_, day| *day >= today);
        self.subnets.retain(|_, day| *day >= today);
    }
}

fn trim(recent: &mut VecDeque<DateTime<Utc>>, now: DateTime<Utc>) {
    while recent
        .front()
        .is_some_and(|at| now - *at >= Duration::hours(1))
    {
        recent.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{HOME, MOBILE};
    use chrono::TimeZone;

    fn human() -> Signals<'static> {
        Signals {
            network: HOME,
            client_matches: true,
            ..Signals::default()
        }
    }

    fn class(signals: &Signals) -> (Class, &'static str) {
        let verdict = baseline(signals);
        (verdict.class, verdict.reason)
    }

    #[test]
    fn an_ordinary_visit_is_unclear_until_a_person_acts() {
        assert_eq!(class(&human()), (Class::Unclear, reason::SILENT));
        assert!(!Class::Unclear.is_human());
        assert_eq!(Class::Unclear.traffic(), "unclear");
    }

    #[test]
    fn a_signed_probe_is_ours_whatever_else_it_looks_like() {
        let robot = crate::ua::robot("curl/8.5.0");
        let signals = Signals {
            probe: true,
            robot,
            webdriver: true,
            ..human()
        };
        assert_eq!(class(&signals), (Class::Own, reason::PROBE));
    }

    #[test]
    fn a_listed_agent_is_a_named_robot() {
        let robot =
            crate::ua::robot("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)");
        let verdict = baseline(&Signals { robot, ..human() });
        assert_eq!(
            (verdict.class, verdict.reason, verdict.bot),
            (Class::Bot, reason::ROBOT, "yandex")
        );
        assert_eq!(verdict.class.traffic(), "bot");
    }

    #[test]
    fn a_driven_browser_is_automation() {
        let headless = crate::ua::robot(
            "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0.0.0 Safari/537.36",
        );
        assert_eq!(
            class(&Signals {
                robot: headless,
                ..human()
            }),
            (Class::Automation, reason::HEADLESS)
        );
        assert_eq!(
            class(&Signals {
                webdriver: true,
                ..human()
            }),
            (Class::Automation, reason::WEBDRIVER)
        );
        assert_eq!(
            class(&Signals {
                client_matches: false,
                ..human()
            }),
            (Class::Automation, reason::CLIENT_MISMATCH)
        );
    }

    #[test]
    fn software_rendering_is_automation_only_from_a_hosting_network() {
        let swiftshader =
            Some("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)");
        let llvmpipe = Some("llvmpipe (LLVM 15.0.7, 256 bits)");
        assert_eq!(
            class(&Signals {
                renderer: swiftshader,
                network: HOSTING,
                ..human()
            }),
            (Class::Automation, reason::SOFTWARE_GL)
        );
        assert_eq!(
            class(&Signals {
                renderer: llvmpipe,
                network: HOSTING,
                ..human()
            }),
            (Class::Automation, reason::SOFTWARE_GL)
        );
        // Тот же рисовальщик из домашней сети — человек на слабой машине.
        assert_eq!(
            class(&Signals {
                renderer: llvmpipe,
                network: HOME,
                ..human()
            })
            .0,
            Class::Unclear
        );
        // Настоящая видеокарта из хостинга — человек через VPN.
        let nvidia =
            Some("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
        assert_eq!(
            class(&Signals {
                renderer: nvidia,
                network: HOSTING,
                ..human()
            })
            .0,
            Class::Unclear
        );
        assert_eq!(
            class(&Signals {
                renderer: None,
                network: MOBILE,
                ..human()
            })
            .0,
            Class::Unclear
        );
    }

    #[test]
    fn human_classes_share_one_traffic_word() {
        assert!(Class::Engaged.is_human() && Class::Confirmed.is_human());
        assert_eq!(
            (Class::Engaged.traffic(), Class::Confirmed.traffic()),
            ("human", "human")
        );
        assert_eq!(
            (Class::Engaged.human(), Class::Confirmed.human()),
            ("engaged", "confirmed")
        );
        assert_eq!(
            (Class::Own.traffic(), Class::Automation.traffic()),
            ("own", "automation")
        );
    }

    fn at(minute: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 12, 9, 0, 0).unwrap() + Duration::minutes(minute)
    }

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
    }

    #[test]
    fn a_device_with_more_than_20_sessions_an_hour_is_demoted_until_the_end_of_the_day() {
        let mut guard = Guard::new();
        for n in 0..20 {
            assert!(!guard.session_opened("d", at(n), day(12)), "сессия {n}");
        }
        assert!(guard.session_opened("d", at(20), day(12)));
        // До конца суток — даже если сессии стали редкими; назавтра — снова человек.
        assert!(guard.session_opened("d", at(300), day(12)));
        assert!(guard.device_demoted("d", day(12)));
        assert!(!guard.device_demoted("d", day(13)));
        assert!(!guard.device_demoted("другое", day(12)));
    }

    #[test]
    fn twenty_sessions_spread_over_hours_are_fine() {
        let mut guard = Guard::new();
        for n in 0..60 {
            assert!(!guard.session_opened("d", at(n * 4), day(12)), "сессия {n}");
        }
    }

    #[test]
    fn a_subnet_with_more_than_30_new_devices_an_hour_and_no_call_is_demoted() {
        let mut guard = Guard::new();
        for n in 0..30 {
            assert!(guard.new_device("net", at(n), day(12)), "устройство {n}");
        }
        assert!(!guard.new_device("net", at(30), day(12)));
        assert!(guard.subnet_demoted("net", day(12)));
        assert!(!guard.new_device("net", at(400), day(12)));
        assert!(guard.new_device("net", at(400), day(13)));
        assert!(guard.new_device("соседняя", at(31), day(12)));
        // Без адреса (запрос не через шлюз) правило подсети не действует.
        for n in 0..100 {
            assert!(guard.new_device("", at(n), day(12)));
        }
    }

    #[test]
    fn a_call_from_the_subnet_shows_real_people_and_lifts_the_demotion() {
        let mut guard = Guard::new();
        guard.call("office", at(0));
        for n in 0..50 {
            assert!(guard.new_device("office", at(n), day(12)), "устройство {n}");
        }
        // Звонок был больше часа назад — правило снова в силе.
        assert!(!guard.new_device("office", at(61), day(12)));
        guard.call("office", at(62));
        assert!(!guard.subnet_demoted("office", day(12)));
    }

    #[test]
    fn the_guard_forgets_what_is_older_than_an_hour() {
        let mut guard = Guard::new();
        guard.session_opened("d", at(0), day(12));
        guard.new_device("net", at(0), day(12));
        guard.call("net", at(0));
        guard.sweep(at(61), day(12));
        assert!(guard.sessions.is_empty() && guard.arrivals.is_empty() && guard.calls.is_empty());
    }
}
