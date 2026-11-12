//! Что `User-Agent` говорит о заходе: вид клиента, система, семейство браузера, класс устройства — и не
//! робот ли это. Строка агента целиком не хранится нигде: из неё берутся только слова из перечислений.

use std::sync::LazyLock;

use regex::RegexSet;

/// Робот из списка: имя для суточного трафика и то, чем он является.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Robot {
    pub name: &'static str,
    pub kind: RobotKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RobotKind {
    /// Поисковый, предпросмотр ссылок, сканер SEO, ИИ-сборщик, библиотека HTTP, монитор доступности.
    Crawler,
    /// Браузер под управлением программы.
    Automation,
}

use RobotKind::{Automation, Crawler};

/// Список роботов: имя, вид, выражение (без учёта регистра). Порядок важен — берётся первое совпадение,
/// поэтому точные имена стоят выше общих слов. Новый робот — новая строка в своём разделе.
const ROBOTS: &[(&str, RobotKind, &str)] = &[
    // ── Поисковые ────────────────────────────────────────────────────────────────────────────────
    (
        "google",
        Crawler,
        r"googlebot|google-inspectiontool|googleother|storebot-google|adsbot-google|mediapartners-google|apis-google|feedfetcher-google|google-read-aloud|google-site-verification|google-pagerenderer|googleweblight",
    ),
    // «YaBrowser» и «YandexSearch» — браузеры людей, поэтому роботы Яндекса названы поимённо.
    (
        "yandex",
        Crawler,
        r"yandex\w*bot|yandex(?:images|video|media|blogs|news|market|metrika|webmaster|favicons|pagechecker|direct|turbo|imageresizer)|yadirectfetcher",
    ),
    (
        "bing",
        Crawler,
        r"bingbot|bingpreview|msnbot|adidxbot|microsoftpreview",
    ),
    (
        "duckduckgo",
        Crawler,
        r"duckduckbot|duckduckgo-favicons-bot",
    ),
    ("baidu", Crawler, r"baiduspider"),
    ("mailru", Crawler, r"mail\.ru_bot"),
    ("apple", Crawler, r"applebot"),
    ("yahoo", Crawler, r"yahoo! slurp|yahoo link preview"),
    ("petal", Crawler, r"petalbot"),
    ("seznam", Crawler, r"seznambot"),
    ("naver", Crawler, r"\byeti/|naverbot"),
    ("sogou", Crawler, r"sogou[a-z ]*spider"),
    (
        "search-other",
        Crawler,
        r"qwantbot|qwantify|mojeekbot|coccocbot|360spider|exabot|statonlinerubot|amazonbot",
    ),
    // ── ИИ-сборщики ──────────────────────────────────────────────────────────────────────────────
    ("openai", Crawler, r"gptbot|chatgpt-user|oai-searchbot"),
    (
        "anthropic",
        Crawler,
        r"claudebot|claude-web|claude-user|claude-searchbot|anthropic-ai",
    ),
    ("perplexity", Crawler, r"perplexitybot|perplexity-user"),
    ("bytedance", Crawler, r"bytespider|tiktokspider"),
    ("commoncrawl", Crawler, r"ccbot"),
    (
        "meta-ai",
        Crawler,
        r"meta-externalagent|meta-externalfetcher",
    ),
    (
        "ai-other",
        Crawler,
        r"google-extended|cohere-ai|cohere-training-data-crawler|diffbot|imagesiftbot|omgili|youbot|timpibot|ai2bot|duckassistbot|mistralai-user|pangubot|webzio-extended|friendlycrawler|iaskspider|brightbot|kangaroo bot",
    ),
    // ── Предпросмотр ссылок ──────────────────────────────────────────────────────────────────────
    ("telegram", Crawler, r"telegrambot"),
    ("whatsapp", Crawler, r"^whatsapp/"),
    (
        "facebook",
        Crawler,
        r"facebookexternalhit|facebot|facebookcatalog",
    ),
    ("vk", Crawler, r"vkshare|vkrobot"),
    ("twitter", Crawler, r"twitterbot"),
    ("discord", Crawler, r"discordbot"),
    ("slack", Crawler, r"slackbot|slack-imgproxy"),
    ("linkedin", Crawler, r"linkedinbot"),
    (
        "preview-other",
        Crawler,
        r"skypeuripreview|pinterestbot|redditbot|embedly|iframely|odklbot|bitlybot|mastodon/|ms-office|microsoft office",
    ),
    // ── Сканеры SEO, архивы и сканеры безопасности ───────────────────────────────────────────────
    ("ahrefs", Crawler, r"ahrefsbot|ahrefssiteaudit"),
    (
        "semrush",
        Crawler,
        r"semrushbot|siteauditbot|splitsignalbot",
    ),
    ("majestic", Crawler, r"mj12bot"),
    ("moz", Crawler, r"dotbot|rogerbot"),
    (
        "seo-other",
        Crawler,
        r"blexbot|serpstatbot|seokicks|dataforseobot|screaming frog|seobilitybot|linkdexbot|megaindex|zoominfobot|barkrowler|backlinksextendedbot|serankingbacklinksbot|sitecheckerbotcrawler|xovibot|sistrix",
    ),
    ("archive", Crawler, r"ia_archiver|archive\.org_bot|wayback"),
    (
        "scanner",
        Crawler,
        r"censys|expanse|zgrab|masscan|nmap|internetmeasurement|shodan|nuclei|l9explore|l9tcpid|netcraftsurveyagent|bitsightbot|securityscorecard|palo alto networks|project_patchwatch|nessus|qualys|acunetix|nikto|sqlmap|wpscan|dirbuster|gobuster",
    ),
    // ── Мониторы доступности ─────────────────────────────────────────────────────────────────────
    (
        "monitor",
        Crawler,
        r"uptimerobot|pingdom|statuscake|site24x7|uptime-kuma|betterstack|better uptime|datadog|newrelicpinger|newrelicsynthetics|zabbix|nagios|check_http|gatus|blackbox exporter|prometheus|hetrixtools|updown\.io|monitis|freshping|checkly|catchpoint|kube-probe|elb-healthchecker|route53-health-check|googlestackdrivermonitoring|googlehc|cloudflare-healthchecks|cloudflare-traffic-manager|alwayson|hosttracker|ping-admin",
    ),
    // ── Браузеры под управлением ─────────────────────────────────────────────────────────────────
    (
        "headless",
        Automation,
        r"headlesschrome|phantomjs|puppeteer|playwright|selenium|cypress|slimerjs|htmlunit|jsdom|prerender|rendertron|browsershot|nightmare|casperjs|zombie\.js|\bsplash\b",
    ),
    (
        "audit",
        Automation,
        r"chrome-lighthouse|pagespeed|google page speed|gtmetrix|\bptst\b|webpagetest",
    ),
    // ── Библиотеки HTTP ──────────────────────────────────────────────────────────────────────────
    ("curl", Crawler, r"^curl/|libcurl"),
    ("wget", Crawler, r"^wget/"),
    (
        "python",
        Crawler,
        r"python-requests|python-urllib|python-httpx|aiohttp|^python/|scrapy|httpx/",
    ),
    (
        "go",
        Crawler,
        r"go-http-client|^go http package|fasthttp|colly",
    ),
    (
        "java",
        Crawler,
        r"^java/|apache-httpclient|apache-httpasyncclient|jakarta commons-httpclient",
    ),
    (
        "node",
        Crawler,
        r"node-fetch|undici|axios/|^got |^node\b|^deno/|^bun/",
    ),
    (
        "http-other",
        Crawler,
        r"libwww-perl|guzzlehttp|^php/|symfony|^ruby|faraday|rest-client|httpie|postmanruntime|insomnia|reqwest|^hyper/|^dart/|^k6/|typhoeus|lua-resty-http|winhttp",
    ),
    // ── Всё, что само называет себя роботом ──────────────────────────────────────────────────────
    // Адрес в агенте (`+http://…`) браузеры не пишут; «bot» — отдельным словом или перед номером версии
    // (телефоны CUBOT под правило не попадают).
    (
        "other",
        Crawler,
        r"\+https?://|(?:^|[^a-z])bot(?:[^a-z]|$)|[a-z]bot/|crawler|spider|scraper",
    ),
];

static ROBOT_SET: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new(
        ROBOTS
            .iter()
            .map(|(_, _, pattern)| format!("(?i){pattern}")),
    )
    .expect("выражения списка роботов должны разбираться")
});

/// Робот ли это по `User-Agent`. Пустой агент — тоже робот: браузер без него не ходит.
pub fn robot(agent: &str) -> Option<Robot> {
    if agent.trim().is_empty() {
        return Some(Robot {
            name: "no-agent",
            kind: Crawler,
        });
    }
    let first = ROBOT_SET.matches(agent).iter().next()?;
    let (name, kind, _) = ROBOTS[first];
    Some(Robot { name, kind })
}

/// Что агент говорит об устройстве.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    /// `windows` | `macos` | `linux` | `android` | `ios` | `other` — как `ClientKind` ядра.
    pub os: &'static str,
    /// Семейство браузера: `chrome`, `safari`, `firefox`, `edge`, `opera`, `yandex`, `samsung`, `webview`,
    /// `electron` (оболочка Cord для Windows), `other`. Версия не хранится.
    pub browser: &'static str,
    /// `desktop` | `phone` | `tablet` | `tv`.
    pub device: &'static str,
    /// Есть ли в агенте оболочка Electron: без неё клиент `desktop` — не приложение Cord.
    pub electron: bool,
}

/// Разобрать агент. `touch` — число точек касания из признаков клиента: iPad называет себя Macintosh,
/// и отличает его от Mac только касание.
pub fn agent(agent: &str, touch: Option<u32>) -> Agent {
    let has = |word: &str| agent.contains(word);
    let ipad_as_mac = has("Macintosh") && touch.is_some_and(|t| t >= 2);
    let os = if has("Windows") {
        "windows"
    } else if has("Android") {
        "android"
    } else if has("iPhone") || has("iPad") || has("iOS") || ipad_as_mac {
        "ios"
    } else if has("Mac OS") || has("Macintosh") {
        "macos"
    } else if has("Linux") || has("X11") {
        "linux"
    } else {
        "other"
    };
    let lower = agent.to_ascii_lowercase();
    let tv = [
        "smart-tv",
        "smarttv",
        "tizen",
        "web0s",
        "netcast",
        "appletv",
        "googletv",
        "android tv",
        "bravia",
        "hbbtv",
        "crkey",
        "roku",
    ]
    .iter()
    .any(|word| lower.contains(word));
    let device = if tv {
        "tv"
    } else if has("iPad") || ipad_as_mac || (has("Android") && !has("Mobile")) || has("Tablet") {
        "tablet"
    } else if has("iPhone") || has("iPod") || has("Mobile") || has("Windows Phone") {
        "phone"
    } else {
        "desktop"
    };
    let electron = has("Electron/");
    let browser = if electron {
        "electron"
    } else if has("YaBrowser") || has("YaSearchBrowser") || has("YandexSearch") {
        "yandex"
    } else if has("Edg/") || has("EdgA/") || has("EdgiOS/") || has("Edge/") {
        "edge"
    } else if has("OPR/") || has("OPT/") || has("Opera") {
        "opera"
    } else if has("SamsungBrowser") {
        "samsung"
    } else if has("Firefox/") || has("FxiOS") {
        "firefox"
    } else if has("; wv)") {
        "webview"
    } else if has("Chrome/") || has("CriOS") || has("Chromium") {
        "chrome"
    } else if has("Safari/") && has("Version/") {
        "safari"
    } else if os == "ios" && has("AppleWebKit") {
        "webview"
    } else {
        "other"
    };
    Agent {
        os,
        browser,
        device,
        electron,
    }
}

/// Вид клиента: слово из тела или заголовка `X-Cord-Client`; без него — догадка по агенту, как у ядра.
pub fn client_kind(claimed: Option<&str>, agent: &str) -> &'static str {
    match claimed.map(|c| c.trim().to_ascii_lowercase()).as_deref() {
        Some("web") => "web",
        Some("desktop") => "desktop",
        Some("android") => "android",
        Some("telegram") => "telegram",
        _ if agent.contains("Electron/") => "desktop",
        _ if agent.trim().is_empty() => "other",
        _ => "web",
    }
}

/// Сходится ли названный вид клиента с агентом: `desktop` — только в оболочке Cord (Electron), `android` —
/// только на Android. Не сходится — это не наш клиент, а программа, назвавшаяся им.
pub fn client_matches(kind: &str, agent: &str) -> bool {
    match kind {
        "desktop" => agent.contains("Electron/"),
        "android" => agent.contains("Android"),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME_WIN: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const SAFARI_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
    const SAFARI_MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    const CHROME_ANDROID: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    const CORD_DESKTOP: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) cord/1.3.7 Chrome/130.0.6723.59 Electron/33.0.2 Safari/537.36";

    fn name(agent: &str) -> Option<&'static str> {
        robot(agent).map(|r| r.name)
    }

    #[test]
    fn browsers_of_people_are_not_robots() {
        for agent in [
            CHROME_WIN,
            SAFARI_IPHONE,
            SAFARI_MAC,
            CHROME_ANDROID,
            CORD_DESKTOP,
            "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
            // Браузер и приложение Яндекса — люди, хотя в агенте есть «Yandex».
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36",
            "Mozilla/5.0 (Linux; arm_64; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 YaApp_Android/24.90.1 YaSearchBrowser/24.90.1 BroPP/1.0 SA/3 Mobile Safari/537.36",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 YaBrowser/24.7.0 YandexSearch/24.70 Mobile/15E148 Safari/604.1",
            // Телефон CUBOT: «bot» внутри слова.
            "Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
            // Встроенный браузер Telegram на Android — обычный WebView.
            "Mozilla/5.0 (Linux; Android 14; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36",
        ] {
            assert_eq!(robot(agent), None, "{agent}");
        }
    }

    #[test]
    fn robots_are_named_by_family() {
        for (agent, expected) in [
            (
                "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
                "google",
            ),
            // Мобильный робот Google называет себя Android — на этом и погорела первая аналитика.
            (
                "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
                "google",
            ),
            (
                "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
                "yandex",
            ),
            (
                "Mozilla/5.0 (compatible; YandexRenderResourcesBot/1.0; +http://yandex.com/bots)",
                "yandex",
            ),
            (
                "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
                "bing",
            ),
            (
                "Mozilla/5.0 (compatible; Mail.RU_Bot/2.0; +http://go.mail.ru/help/robots)",
                "mailru",
            ),
            ("TelegramBot (like TwitterBot)", "telegram"),
            ("WhatsApp/2.23.20.0 A", "whatsapp"),
            (
                "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
                "facebook",
            ),
            (
                "Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)",
                "vk",
            ),
            (
                "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
                "ahrefs",
            ),
            (
                "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
                "semrush",
            ),
            (
                "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
                "openai",
            ),
            (
                "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
                "anthropic",
            ),
            (
                "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
                "bytedance",
            ),
            ("curl/8.5.0", "curl"),
            ("python-requests/2.32.3", "python"),
            ("Go-http-client/2.0", "go"),
            ("axios/1.7.7", "node"),
            (
                "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
                "monitor",
            ),
            ("Gatus/1.0", "monitor"),
            (
                "Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)",
                "scanner",
            ),
            (
                "Mozilla/5.0 (compatible; SomeNewBot/0.1; +https://example.test/about)",
                "other",
            ),
            ("MyCrawler", "other"),
            ("", "no-agent"),
        ] {
            assert_eq!(name(agent), Some(expected), "{agent}");
        }
    }

    #[test]
    fn a_driven_browser_is_automation_not_a_crawler() {
        let headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36";
        assert_eq!(
            robot(headless),
            Some(Robot {
                name: "headless",
                kind: Automation
            })
        );
        let lighthouse = "Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse";
        assert_eq!(
            robot(lighthouse),
            Some(Robot {
                name: "audit",
                kind: Automation
            })
        );
        assert_eq!(robot("curl/8.5.0").map(|r| r.kind), Some(Crawler));
    }

    #[test]
    fn the_agent_names_the_system_the_browser_and_the_device_class() {
        let cases = [
            (CHROME_WIN, None, ("windows", "chrome", "desktop")),
            (SAFARI_IPHONE, None, ("ios", "safari", "phone")),
            (SAFARI_MAC, None, ("macos", "safari", "desktop")),
            // iPad в режиме «как на компьютере» называет себя Macintosh: выдаёт касание.
            (SAFARI_MAC, Some(5), ("ios", "safari", "tablet")),
            (CHROME_ANDROID, None, ("android", "chrome", "phone")),
            (CORD_DESKTOP, None, ("windows", "electron", "desktop")),
            (
                "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                None,
                ("android", "chrome", "tablet"),
            ),
            (
                "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
                None,
                ("ios", "safari", "tablet"),
            ),
            (
                "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
                None,
                ("linux", "firefox", "desktop"),
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
                None,
                ("windows", "edge", "desktop"),
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36",
                None,
                ("windows", "yandex", "desktop"),
            ),
            (
                "Mozilla/5.0 (Linux; Android 14; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36",
                None,
                ("android", "webview", "phone"),
            ),
            (
                "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36",
                None,
                ("linux", "other", "tv"),
            ),
            (
                "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                None,
                ("android", "chrome", "tv"),
            ),
            ("что-то", None, ("other", "other", "desktop")),
        ];
        for (text, touch, (os, browser, device)) in cases {
            let parsed = agent(text, touch);
            assert_eq!(
                (parsed.os, parsed.browser, parsed.device),
                (os, browser, device),
                "{text}"
            );
        }
    }

    #[test]
    fn the_client_kind_is_the_claimed_word_or_a_guess_and_must_match_the_agent() {
        assert_eq!(client_kind(Some("web"), CHROME_WIN), "web");
        assert_eq!(client_kind(Some(" Desktop "), CORD_DESKTOP), "desktop");
        assert_eq!(client_kind(Some("чужое"), CHROME_WIN), "web");
        assert_eq!(client_kind(None, CORD_DESKTOP), "desktop");
        assert_eq!(client_kind(None, ""), "other");
        assert_eq!(client_kind(Some("telegram"), SAFARI_IPHONE), "telegram");
        // «desktop · linux» из прежней аналитики: назвался приложением, а оболочки Cord нет.
        assert!(client_matches("desktop", CORD_DESKTOP));
        assert!(!client_matches(
            "desktop",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
        ));
        assert!(client_matches("android", CHROME_ANDROID));
        assert!(!client_matches("android", CHROME_WIN));
        assert!(client_matches("web", CHROME_WIN));
        assert!(client_matches("telegram", SAFARI_IPHONE));
    }
}
