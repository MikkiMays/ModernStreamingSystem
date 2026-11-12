//! Отчёты пульта (`contracts/insight.md` §3, формы — `contracts/insight-reports.md`).
//!
//! Все ответы — агрегаты: ни ключей людей, ни строк сессий наружу нет. Два вида одного отчёта: «За период»
//! — всё, что произошло в выбранные дни; «Когорты» — люди, пришедшие в выбранные дни, и вся их дальнейшая
//! жизнь до сегодня. Переключатель «строго» считает узнанных по отпечатку отдельными людьми.

mod sql;

use chrono::{DateTime, Days, NaiveDate, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, PgPool};

use crate::days::{day_start, local_day};

/// Разделы отчётов.
pub const SECTIONS: [&str; 10] = [
    "pulse",
    "audience",
    "acquisition",
    "activation",
    "retention",
    "engagement",
    "integrations",
    "quality",
    "errors",
    "traffic",
];

/// Период не длиннее стольких дней.
pub const MAX_DAYS: i64 = 400;

/// Параметры запроса отчёта.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// Дни по поясу аналитики, включительно.
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// Вид «Когорты» (`view=cohort`); иначе — «За период».
    pub cohort: bool,
    /// Без склейки по отпечатку.
    pub strict: bool,
    /// Приложить прошлый период той же длины.
    pub compare: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ReportError {
    #[error("нет такого раздела")]
    UnknownSection,
    #[error("{0}")]
    BadRequest(&'static str),
    #[error("нет такой группы ошибок")]
    NotFound,
    #[error("отказ базы: {0}")]
    Database(#[from] sqlx::Error),
}

/// Дни одного расчёта.
#[derive(Debug, Clone, Copy)]
struct Range {
    from: NaiveDate,
    to: NaiveDate,
    /// Горизонт: последний день периода, а у когорт — сегодня.
    end: NaiveDate,
    cohort: bool,
    strict: bool,
}

impl Range {
    fn days(&self) -> i64 {
        (self.to - self.from).num_days() + 1
    }

    /// Прошлый период той же длины: кончается накануне этого.
    fn previous(&self) -> Range {
        let length = Days::new(self.days() as u64);
        let (from, to) = (self.from - length, self.to - length);
        Range { from, to, end: if self.cohort { self.end } else { to }, ..*self }
    }

    fn describe(&self) -> Value {
        json!({"from": self.from, "to": self.to, "days": self.days()})
    }
}

/// Дополнительный параметр запроса (`$6` и дальше).
enum Extra<'a> {
    Text(&'a str),
    Date(NaiveDate),
    Time(DateTime<Utc>),
}

#[derive(Clone)]
pub struct Reports {
    pool: PgPool,
    zone: Tz,
}

impl Reports {
    pub fn new(pool: PgPool, zone: Tz) -> Self {
        Reports { pool, zone }
    }

    /// Отчёт раздела; `key` — ключ группы ошибок для `errors/{key}`. `now` — часы службы: по ним «сегодня».
    pub async fn report(
        &self,
        section: &str,
        key: Option<&str>,
        query: &Query,
        now: DateTime<Utc>,
    ) -> Result<Value, ReportError> {
        if !SECTIONS.contains(&section) || (key.is_some() && section != "errors") {
            return Err(ReportError::UnknownSection);
        }
        if query.from > query.to {
            return Err(ReportError::BadRequest("from позже to"));
        }
        if (query.to - query.from).num_days() >= MAX_DAYS {
            return Err(ReportError::BadRequest("период длиннее 400 дней"));
        }
        let today = local_day(now, self.zone);
        let end = if query.cohort { today.max(query.to) } else { query.to };
        let range = Range { from: query.from, to: query.to, end, cohort: query.cohort, strict: query.strict };
        let mut report = json!({
            "section": match key { Some(_) => "errors/{key}", None => section },
            "range": range.describe(),
            "view": if query.cohort { "cohort" } else { "period" },
            "strict": query.strict,
            "zone": self.zone.name(),
            "generated_at": now,
            "data": self.section(section, key, &range).await?,
        });
        if query.compare {
            let previous = range.previous();
            report["previous"] = json!({"range": previous.describe(), "data": self.section(section, key, &previous).await?});
        }
        Ok(report)
    }

    async fn section(&self, section: &str, key: Option<&str>, range: &Range) -> Result<Value, ReportError> {
        // Конец горизонта моментом времени: начало следующего дня по поясу аналитики.
        let horizon = day_start(range.end + Days::new(1), self.zone);
        let value = match (section, key) {
            ("pulse", _) => self.pulse(range).await?,
            ("audience", _) => self.run(sql::audience(), range, &[]).await?,
            ("acquisition", _) => self.run(sql::acquisition(), range, &[]).await?,
            ("activation", _) => self.run(sql::activation(), range, &[Extra::Time(horizon)]).await?,
            ("retention", _) => {
                let bucket = match range.days() {
                    ..=31 => "day",
                    32..=182 => "week",
                    _ => "month",
                };
                let before = range.previous().from;
                self.run(sql::retention(), range, &[Extra::Text(bucket), Extra::Date(before)]).await?
            }
            ("engagement", _) => self.run(sql::engagement(), range, &[]).await?,
            ("integrations", _) => self.run(sql::integrations(), range, &[]).await?,
            ("quality", _) => self.run(sql::quality(), range, &[]).await?,
            ("errors", Some(key)) => match self.run(sql::error_detail(), range, &[Extra::Text(key)]).await? {
                Value::Null => return Err(ReportError::NotFound),
                detail => detail,
            },
            ("errors", None) => self.run(sql::errors(), range, &[]).await?,
            ("traffic", _) => self.run(sql::traffic(), range, &[]).await?,
            _ => return Err(ReportError::UnknownSection),
        };
        Ok(value)
    }

    /// Один запрос отчёта: общие пять параметров и свои дополнительные.
    async fn run(&self, sql: String, range: &Range, extra: &[Extra<'_>]) -> Result<Value, sqlx::Error> {
        let mut query = sqlx::query_scalar::<_, Option<Value>>(AssertSqlSafe(sql))
            .bind(range.strict)
            .bind(range.from)
            .bind(range.to)
            .bind(range.cohort)
            .bind(range.end);
        for parameter in extra {
            query = match parameter {
                Extra::Text(text) => query.bind(*text),
                Extra::Date(day) => query.bind(*day),
                Extra::Time(at) => query.bind(*at),
            };
        }
        Ok(query.fetch_one(&self.pool).await?.unwrap_or(Value::Null))
    }

    /// Пульс: плитки с изменением к прошлому периоду и ряды по дням.
    async fn pulse(&self, range: &Range) -> Result<Value, sqlx::Error> {
        let now = self.run(sql::pulse_numbers(), range, &[]).await?;
        let before = self.run(sql::pulse_numbers(), &range.previous(), &[]).await?;
        let mut tiles = Map::new();
        for (name, value) in now.as_object().into_iter().flatten() {
            let previous = before.get(name).cloned().unwrap_or(Value::Null);
            tiles.insert(name.clone(), json!({"value": value, "previous": previous, "change": change(value, &previous)}));
        }
        let series = self.run(sql::pulse_series(), range, &[]).await?;
        Ok(json!({"tiles": tiles, "series": series}))
    }
}

/// Изменение к прошлому периоду долей: `(стало − было) / было`; не с чем сравнить — `null`.
fn change(value: &Value, previous: &Value) -> Value {
    match (value.as_f64(), previous.as_f64()) {
        (Some(now), Some(before)) if before != 0.0 => json!(((now - before) / before * 10_000.0).round() / 10_000.0),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> NaiveDate {
        text.parse().unwrap()
    }

    #[test]
    fn the_previous_period_has_the_same_length_and_ends_the_day_before() {
        let range = Range { from: day("2026-11-01"), to: day("2026-11-07"), end: day("2026-11-07"), cohort: false, strict: false };
        let previous = range.previous();
        assert_eq!((previous.from, previous.to, previous.end), (day("2026-10-25"), day("2026-10-31"), day("2026-10-31")));
        assert_eq!((range.days(), previous.days()), (7, 7));
        // У когорт горизонт — сегодня: и у прошлой когорты тоже.
        let cohort = Range { end: day("2026-11-12"), cohort: true, ..range };
        assert_eq!(cohort.previous().end, day("2026-11-12"));
    }

    #[test]
    fn change_is_relative_to_the_previous_value() {
        assert_eq!(change(&json!(120), &json!(100)), json!(0.2));
        assert_eq!(change(&json!(50), &json!(100)), json!(-0.5));
        assert_eq!(change(&json!(0.25), &json!(0.2)), json!(0.25));
        assert_eq!(change(&json!(5), &json!(0)), Value::Null);
        assert_eq!(change(&json!(5), &Value::Null), Value::Null);
        assert_eq!(change(&Value::Null, &json!(5)), Value::Null);
    }
}
