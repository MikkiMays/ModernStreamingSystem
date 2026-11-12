//! Метрики самой службы для профиля `monitoring` (`GET /metrics`, текст Prometheus).
//!
//! В метках — только слова из перечислений службы (класс, причина, тип факта): ни адресов, ни ключей.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::Mutex;

/// Границы корзин времени записи в базу, секунды.
const BUCKETS: [f64; 9] = [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 10.0];

/// Имена и описания рядов: по ним печатаются `# HELP` и `# TYPE`.
const SERIES: &[(&str, &str, &str)] = &[
    ("insight_batches_total", "counter", "Пачки событий клиента по итогу приёма"),
    ("insight_events_accepted_total", "counter", "События клиента, принятые в обработку"),
    ("insight_events_dropped_total", "counter", "События клиента, отброшенные по причине"),
    ("insight_sessions_total", "counter", "Сессии по классу и причине"),
    ("insight_identity_total", "counter", "Как узнан человек у сессии"),
    ("insight_engaged_refused_total", "counter", "Событие engaged, не сделавшее сессию человеком"),
    ("insight_facts_accepted_total", "counter", "Факты ядра и служб по типу"),
    ("insight_facts_dropped_total", "counter", "Факты, отброшенные по причине"),
    ("insight_db_errors_total", "counter", "Отказы базы по месту"),
    ("insight_live_sessions", "gauge", "Сессий в памяти"),
    ("insight_queue_depth", "gauge", "Команд в очереди движка"),
    ("insight_facts_lag_seconds", "gauge", "Отставание последнего обработанного факта от часов службы"),
    ("insight_geo_loaded", "gauge", "Прочитана ли база адресов"),
];

#[derive(Default)]
struct Inner {
    values: BTreeMap<String, f64>,
    write_buckets: [u64; BUCKETS.len()],
    write_count: u64,
    write_sum: f64,
}

#[derive(Default)]
pub struct Metrics {
    inner: Mutex<Inner>,
}

/// Имя ряда с метками: `series("insight_x_total", &[("reason", "queue_full")])`.
pub fn series(name: &str, labels: &[(&str, &str)]) -> String {
    if labels.is_empty() {
        return name.to_owned();
    }
    let labels: Vec<String> = labels.iter().map(|(k, v)| format!("{k}=\"{}\"", v.replace(['"', '\\', '\n'], "_"))).collect();
    format!("{name}{{{}}}", labels.join(","))
}

impl Metrics {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Прибавить к счётчику.
    pub fn add(&self, name: &str, labels: &[(&str, &str)], by: u64) {
        *self.inner().values.entry(series(name, labels)).or_default() += by as f64;
    }

    pub fn inc(&self, name: &str, labels: &[(&str, &str)]) {
        self.add(name, labels, 1);
    }

    /// Поставить значение.
    pub fn set(&self, name: &str, labels: &[(&str, &str)], value: f64) {
        self.inner().values.insert(series(name, labels), value);
    }

    /// Запись в базу заняла столько секунд.
    pub fn observe_write(&self, seconds: f64) {
        let mut inner = self.inner();
        for (bucket, limit) in inner.write_buckets.iter_mut().zip(BUCKETS) {
            if seconds <= limit {
                *bucket += 1;
            }
        }
        inner.write_count += 1;
        inner.write_sum += seconds;
    }

    /// Значение ряда — для тестов и `/healthz`.
    pub fn get(&self, name: &str, labels: &[(&str, &str)]) -> f64 {
        self.inner().values.get(&series(name, labels)).copied().unwrap_or(0.0)
    }

    /// Все ряды текстом Prometheus.
    pub fn render(&self) -> String {
        let inner = self.inner();
        let mut out = String::new();
        for (name, kind, help) in SERIES {
            let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}");
            let own = |key: &&String| key.as_str() == *name || key.starts_with(&format!("{name}{{"));
            for key in inner.values.keys().filter(own) {
                let _ = writeln!(out, "{key} {}", inner.values[key]);
            }
        }
        let name = "insight_db_write_seconds";
        let _ = writeln!(out, "# HELP {name} Время записи пачки в базу\n# TYPE {name} histogram");
        for (count, limit) in inner.write_buckets.iter().zip(BUCKETS) {
            let _ = writeln!(out, "{name}_bucket{{le=\"{limit}\"}} {count}");
        }
        let _ = writeln!(out, "{name}_bucket{{le=\"+Inf\"}} {}", inner.write_count);
        let _ = writeln!(out, "{name}_sum {}\n{name}_count {}", inner.write_sum, inner.write_count);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_gauges_and_the_write_histogram_are_rendered_as_prometheus_text() {
        let metrics = Metrics::default();
        metrics.inc("insight_events_dropped_total", &[("reason", "queue_full")]);
        metrics.add("insight_events_dropped_total", &[("reason", "queue_full")], 2);
        metrics.add("insight_events_accepted_total", &[], 7);
        metrics.inc("insight_sessions_total", &[("class", "bot"), ("reason", "robot")]);
        metrics.set("insight_facts_lag_seconds", &[], 1.5);
        metrics.observe_write(0.03);
        metrics.observe_write(3.0);
        let text = metrics.render();
        for line in [
            "# TYPE insight_events_dropped_total counter",
            "insight_events_dropped_total{reason=\"queue_full\"} 3",
            "insight_events_accepted_total 7",
            "insight_sessions_total{class=\"bot\",reason=\"robot\"} 1",
            "# TYPE insight_facts_lag_seconds gauge",
            "insight_facts_lag_seconds 1.5",
            "# TYPE insight_db_write_seconds histogram",
            "insight_db_write_seconds_bucket{le=\"0.02\"} 0",
            "insight_db_write_seconds_bucket{le=\"0.05\"} 1",
            "insight_db_write_seconds_bucket{le=\"10\"} 2",
            "insight_db_write_seconds_bucket{le=\"+Inf\"} 2",
            "insight_db_write_seconds_count 2",
        ] {
            assert!(text.lines().any(|l| l == line), "нет строки «{line}» в:\n{text}");
        }
        assert_eq!(metrics.get("insight_events_dropped_total", &[("reason", "queue_full")]), 3.0);
        assert_eq!(metrics.get("insight_events_dropped_total", &[("reason", "другая")]), 0.0);
    }
}
