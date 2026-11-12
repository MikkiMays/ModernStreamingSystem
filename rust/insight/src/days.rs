//! Дни аналитики: сутки считаются по поясу `ANALYTICS_ZONE`, а не по UTC.

use chrono::{DateTime, Days, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

/// День по поясу аналитики, на который приходится момент.
pub fn local_day(at: DateTime<Utc>, zone: Tz) -> NaiveDate {
    at.with_timezone(&zone).date_naive()
}

/// Момент из мс эпохи; чего не бывает — начало эпохи.
pub fn from_ms(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// Начало дня по поясу аналитики — в UTC.
pub fn day_start(day: NaiveDate, zone: Tz) -> DateTime<Utc> {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap_or_default();
    // Полночи, которой нет (перевод часов), соответствует первый существующий момент после неё.
    match zone.from_local_datetime(&midnight).earliest() {
        Some(start) => start.with_timezone(&Utc),
        None => zone.from_utc_datetime(&midnight).with_timezone(&Utc),
    }
}

/// Секунды отрезка `[from, to)` по дням пояса аналитики: отрезок через полночь делится на два дня.
pub fn split_days(from: DateTime<Utc>, to: DateTime<Utc>, zone: Tz) -> Vec<(NaiveDate, i64)> {
    let mut out = Vec::new();
    let mut cursor = from;
    while cursor < to {
        let day = local_day(cursor, zone);
        let next = day_start(day + Days::new(1), zone);
        let end = if next > cursor { next.min(to) } else { to };
        let seconds = (end - cursor).num_seconds();
        if seconds > 0 {
            out.push((day, seconds));
        }
        cursor = end;
    }
    out
}

/// Первый день месяца и первый день следующего — границы раздела событий.
pub fn month_bounds(day: NaiveDate) -> (NaiveDate, NaiveDate) {
    use chrono::Datelike;
    let first = day.with_day(1).unwrap_or(day);
    let next = if first.month() == 12 {
        NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
    };
    (first, next.unwrap_or(first))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::{Berlin, Moscow};

    fn utc(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn day(text: &str) -> NaiveDate {
        text.parse().unwrap()
    }

    #[test]
    fn the_day_is_the_day_of_the_analytics_zone() {
        // 22:30 UTC — уже завтра по Москве.
        assert_eq!(
            local_day(utc("2026-11-12T22:30:00Z"), Moscow),
            day("2026-11-13")
        );
        assert_eq!(
            local_day(utc("2026-11-12T20:59:59Z"), Moscow),
            day("2026-11-12")
        );
        assert_eq!(
            day_start(day("2026-11-13"), Moscow),
            utc("2026-11-12T21:00:00Z")
        );
    }

    #[test]
    fn an_interval_within_one_day_is_one_piece() {
        let pieces = split_days(
            utc("2026-11-12T10:00:00Z"),
            utc("2026-11-12T10:01:00Z"),
            Moscow,
        );
        assert_eq!(pieces, vec![(day("2026-11-12"), 60)]);
        assert_eq!(
            split_days(
                utc("2026-11-12T10:00:00Z"),
                utc("2026-11-12T10:00:00Z"),
                Moscow
            ),
            vec![]
        );
        assert_eq!(
            split_days(
                utc("2026-11-12T10:00:01Z"),
                utc("2026-11-12T10:00:00Z"),
                Moscow
            ),
            vec![]
        );
    }

    #[test]
    fn an_interval_across_local_midnight_is_split_between_the_days() {
        // Полночь по Москве — 21:00 UTC: 40 секунд до неё и 20 после.
        let pieces = split_days(
            utc("2026-11-12T20:59:20Z"),
            utc("2026-11-12T21:00:20Z"),
            Moscow,
        );
        assert_eq!(
            pieces,
            vec![(day("2026-11-12"), 40), (day("2026-11-13"), 20)]
        );
        // Двое суток подряд.
        let long = split_days(
            utc("2026-11-12T20:00:00Z"),
            utc("2026-11-14T22:00:00Z"),
            Moscow,
        );
        assert_eq!(
            long,
            vec![
                (day("2026-11-12"), 3600),
                (day("2026-11-13"), 86_400),
                (day("2026-11-14"), 86_400),
                (day("2026-11-15"), 3600)
            ]
        );
    }

    #[test]
    fn a_day_with_a_clock_change_is_23_or_25_hours_long() {
        // Берлин, 25.10.2026: часы назад, в сутках 25 часов.
        let pieces = split_days(
            utc("2026-10-24T22:00:00Z"),
            utc("2026-10-25T23:00:00Z"),
            Berlin,
        );
        assert_eq!(pieces, vec![(day("2026-10-25"), 25 * 3600)]);
    }

    #[test]
    fn month_bounds_are_the_first_days() {
        assert_eq!(
            month_bounds(day("2026-11-12")),
            (day("2026-11-01"), day("2026-12-01"))
        );
        assert_eq!(
            month_bounds(day("2026-12-31")),
            (day("2026-12-01"), day("2027-01-01"))
        );
    }
}
