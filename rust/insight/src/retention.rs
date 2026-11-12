//! Сроки хранения (§7 проекта): сырые события живут недолго, итоги — долго.
//!
//! События и сессии — 90 дней; строки «человек × день», встречи, запуски интеграций и ошибки — 400 дней;
//! люди — 400 дней от последнего появления (вместе с устройствами и профилями). Суточный трафик и суточные
//! счётчики бессрочны: в них нет ничего о человеке. Сроки — из окружения (`config::Retention`).

use chrono::{DateTime, Days, NaiveDate, Utc};
use sqlx::{AssertSqlSafe, PgPool};

use crate::config::Retention;
use crate::days::month_bounds;

/// Сколько дней помнятся принятые факты: повтор пачки позже этого срока ядро не шлёт.
const FACT_IDS_DAYS: u64 = 3;

/// Сколько строк убрано — для журнала.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Removed {
    pub partitions: u64,
    pub events: u64,
    pub sessions: u64,
    pub rollups: u64,
    pub people: u64,
}

/// Убрать всё, что старше своих сроков. `today` — день по поясу аналитики.
pub async fn sweep(
    pool: &PgPool,
    terms: Retention,
    today: NaiveDate,
    now: DateTime<Utc>,
) -> Result<Removed, sqlx::Error> {
    let mut removed = Removed::default();
    let events_from = today - Days::new(terms.events);
    let rollups_from = today - Days::new(terms.rollups);
    let people_from = today - Days::new(terms.people);

    // События: раздел, целиком ушедший за срок, удаляется как таблица; из граничного — строки.
    let partitions: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid \
         JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = p.relnamespace \
         WHERE p.relname = 'an_events' AND n.nspname = current_schema()",
    )
    .fetch_all(pool)
    .await?;
    for name in partitions {
        let Some(month) = partition_month(&name) else {
            continue;
        };
        if month_bounds(month).1 <= events_from {
            // Имя раздела прошло разбор: `an_events_y` + год + `m` + месяц, ничего больше.
            sqlx::query(AssertSqlSafe(format!("DROP TABLE {name}")))
                .execute(pool)
                .await?;
            removed.partitions += 1;
        }
    }
    removed.events = delete(pool, "DELETE FROM an_events WHERE day < $1", events_from).await?;
    removed.sessions = delete(pool, "DELETE FROM an_sessions WHERE day < $1", events_from).await?;

    for sql in [
        "DELETE FROM an_person_days WHERE day < $1",
        "DELETE FROM an_meetings WHERE day < $1",
        "DELETE FROM an_integration_runs WHERE day < $1",
        "DELETE FROM an_integration_days WHERE day < $1",
        "DELETE FROM an_error_days WHERE day < $1",
        "DELETE FROM an_error_people WHERE day < $1",
        "DELETE FROM an_errors e WHERE NOT EXISTS (SELECT 1 FROM an_error_days d WHERE d.key = e.key) AND e.last_at::date < $1",
    ] {
        removed.rollups += delete(pool, sql, rollups_from).await?;
    }

    // Люди. У человека, к которому привязаны узнанные по отпечатку, срок может выйти раньше, чем у них:
    // тогда корнем становится самый ранний из оставшихся, и остальные привязываются к нему.
    let mut tx = pool.begin().await?;
    sqlx::query(
        "WITH gone AS (SELECT id FROM an_persons WHERE last_day < $1 AND merged_into IS NULL), \
         heirs AS (SELECT DISTINCT ON (p.merged_into) p.merged_into AS old, p.id AS heir FROM an_persons p \
                   JOIN gone g ON g.id = p.merged_into WHERE p.last_day >= $1 ORDER BY p.merged_into, p.first_at, p.id) \
         UPDATE an_persons p SET merged_into = CASE WHEN p.id = h.heir THEN NULL ELSE h.heir END \
         FROM heirs h WHERE p.merged_into = h.old AND p.last_day >= $1",
    )
    .bind(people_from)
    .execute(&mut *tx)
    .await?;
    removed.people = sqlx::query("DELETE FROM an_persons WHERE last_day < $1")
        .bind(people_from)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;

    sqlx::query("DELETE FROM an_fact_ids WHERE at < $1")
        .bind(now - Days::new(FACT_IDS_DAYS))
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM an_proofs WHERE expires_at < $1")
        .bind(now)
        .execute(pool)
        .await?;
    Ok(removed)
}

async fn delete(pool: &PgPool, sql: &'static str, before: NaiveDate) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(sql)
        .bind(before)
        .execute(pool)
        .await?
        .rows_affected())
}

/// Месяц раздела по его имени: `an_events_y2026m11` → 1 ноября 2026.
fn partition_month(name: &str) -> Option<NaiveDate> {
    let (year, month) = name.strip_prefix("an_events_y")?.split_once('m')?;
    if year.len() != 4 || month.len() != 2 {
        return None;
    }
    NaiveDate::from_ymd_opt(year.parse().ok()?, month.parse().ok()?, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partition_name_names_its_month_and_nothing_else_is_a_partition() {
        assert_eq!(
            partition_month("an_events_y2026m11"),
            NaiveDate::from_ymd_opt(2026, 11, 1)
        );
        assert_eq!(
            partition_month(&crate::db::partition_name(
                NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()
            )),
            NaiveDate::from_ymd_opt(2027, 1, 1)
        );
        for odd in [
            "an_events",
            "an_events_y2026m13",
            "an_events_y26m1",
            "an_events_y2026m11; DROP TABLE an_persons",
            "other_y2026m11",
        ] {
            assert_eq!(partition_month(odd), None, "{odd}");
        }
    }
}
