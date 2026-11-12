//! База: схема `insight` базы продукта, свои миграции, разделы событий.

use std::time::Duration;

use chrono::{Datelike, Months, NaiveDate};
use sqlx::migrate::{Migration, MigrationType, Migrator};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{AssertSqlSafe, PgPool, SqlSafeStr};

use crate::config::Database;
use crate::days::month_bounds;

/// Схема службы в базе продукта.
pub const SCHEMA: &str = "insight";

/// Соединения с базой. Пул ленивый: служба поднимается и без базы, а первый запрос её ищет.
/// `search_path` — только своя схема: таблицы ядра службе не видны.
pub fn pool(database: &Database) -> PgPool {
    let options = PgConnectOptions::new_without_pgpass()
        .host(&database.host)
        .port(database.port)
        .database(&database.name)
        .username(&database.user)
        .password(&database.password)
        // База — на той же машине, по петле: TLS не нужен и в сборку не входит.
        .ssl_mode(PgSslMode::Disable)
        .application_name("cord-insight")
        // Запрос, застрявший в базе, не должен держать движок: через полминуты он отменяется.
        .options([("search_path", SCHEMA), ("statement_timeout", "30000")]);
    PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(300))
        .connect_lazy_with(options)
}

/// Миграции вшиты в файл службы. Применённую миграцию править нельзя: sqlx сверяет её отпечаток.
fn migrator() -> Migrator {
    let mut migrator = Migrator::with_migrations(vec![Migration::new(
        1,
        "init".into(),
        MigrationType::Simple,
        include_str!("../migrations/0001_init.sql").into_sql_str(),
        false,
    )]);
    migrator.create_schema(SCHEMA);
    migrator
}

/// Создать схему и применить недостающие миграции.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    migrator().run(pool).await
}

/// Имя раздела событий месяца: `an_events_y2026m11`.
pub fn partition_name(month: NaiveDate) -> String {
    format!("an_events_y{:04}m{:02}", month.year(), month.month())
}

/// Завести раздел событий на месяц, в который попадает `day`, если его ещё нет.
pub async fn ensure_partition(pool: &PgPool, day: NaiveDate) -> Result<(), sqlx::Error> {
    let (from, to) = month_bounds(day);
    // Имя и границы собраны из чисел даты — подставлять в текст запроса безопасно.
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS {} PARTITION OF an_events FOR VALUES FROM ('{from}') TO ('{to}')",
        partition_name(from)
    );
    sqlx::query(AssertSqlSafe(sql))
        .execute(pool)
        .await
        .map(|_| ())
}

/// Разделы заранее: прошлый месяц (события с часами клиента «сутки назад»), текущий и два следующих.
pub async fn ensure_partitions_ahead(pool: &PgPool, today: NaiveDate) -> Result<(), sqlx::Error> {
    let first = month_bounds(today).0;
    ensure_partition(pool, first - Months::new(1)).await?;
    for ahead in 0..=2 {
        ensure_partition(pool, first + Months::new(ahead)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitions_are_named_by_month() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
        assert_eq!(partition_name(month_bounds(day).0), "an_events_y2026m11");
        assert_eq!(
            partition_name(NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()),
            "an_events_y2027m01"
        );
    }
}
