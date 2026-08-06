//! Recurrence date arithmetic for `recurring_schedules` (migration
//! `0017_recurring`, PARITY.md "Repeating invoices / recurring
//! transactions").
//!
//! One function, [`occurrence_date`], and every caller — `recurring_schedule_
//! create`'s own validation, `recurring_process_occurrence`, `recurring_
//! schedule_preview` — goes through it rather than re-deriving a date. It is
//! a pure function of `(start_date, frequency, interval_count,
//! occurrence_index)`, deliberately never of the previous occurrence's date,
//! which is the whole answer to the month-end trap below.
//!
//! # The month-end rule
//!
//! A schedule anchors to the calendar day of its own `start_date`, and every
//! later occurrence **reapplies that exact day** to its target month or
//! year, clamping down only when that month is too short to hold it. The day
//! is never taken from the previous occurrence's (possibly already clamped)
//! result — only ever from `start_date` itself. That is what keeps a
//! schedule anchored on the 31st reading **31, 28 (or 29), 31, 30, 31, …**
//! through a year rather than ratcheting down to the 28th and staying there
//! the moment it first passes through February. [`monthly_walk_never_
//! degrades_below_28_and_recovers_to_31`] is the regression test for
//! exactly that failure mode; the alternative design (clamp against the
//! previous occurrence) is not implemented anywhere in this module, on
//! purpose — there is nothing to fall back to.
//!
//! The identical rule extends `Yearly` to a 29 February anchor: it reads
//! **29, 28, 28, 28, 29, …**, recovering every leap year rather than being
//! demoted to the 28th forever the first time it lands on a non-leap one.
//!
//! `Daily`/`Weekly` need no clamp at all — every calendar day exists, so
//! `interval_count * occurrence_index` days (or that many weeks) added to
//! `start_date` is exact and unambiguous.

use crate::domain::RecurringFrequency;
use crate::error::{CoreError, CoreResult};
use crate::util::parse_date;
use time::macros::format_description;
use time::{Date, Duration, Month};

/// The `occurrence_index`'th (0-based) occurrence date of a schedule
/// anchored on `start_date`, recurring every `interval_count` `frequency`.
/// `occurrence_index == 0` always returns `start_date` back unchanged.
pub fn occurrence_date(
    start_date: &str,
    frequency: RecurringFrequency,
    interval_count: i64,
    occurrence_index: i64,
) -> CoreResult<String> {
    let start = parse_date(start_date)?;
    let date = match frequency {
        RecurringFrequency::Daily => add_days(start, interval_count * occurrence_index)?,
        RecurringFrequency::Weekly => add_days(start, interval_count * occurrence_index * 7)?,
        RecurringFrequency::Monthly => add_months(start, interval_count * occurrence_index)?,
        RecurringFrequency::Yearly => add_months(start, interval_count * occurrence_index * 12)?,
    };
    format_date(date)
}

/// `occurrence_date` plus `due_days` (>= 0) calendar days — the invoice due
/// date an `Invoice`-kind schedule's `due_days` template field describes,
/// expressed relative to the occurrence (rather than frozen at schedule
/// creation) so it stays correct however far in the future an occurrence
/// lands. See migration `0017_recurring`'s header.
pub fn due_date(occurrence_date: &str, due_days: i64) -> CoreResult<String> {
    format_date(add_days(parse_date(occurrence_date)?, due_days)?)
}

fn format_date(date: Date) -> CoreResult<String> {
    let fmt = format_description!("[year]-[month]-[day]");
    date.format(&fmt)
        .map_err(|e| CoreError::Validation(format!("recurrence date arithmetic: {e}")))
}

fn add_days(start: Date, days: i64) -> CoreResult<Date> {
    start
        .checked_add(Duration::days(days))
        .ok_or_else(|| CoreError::Validation("recurrence date arithmetic overflowed".into()))
}

/// Add `months` calendar months to `start`, reapplying `start`'s own
/// day-of-month and clamping only when the target month is shorter — see
/// this module's header for why the anchor is always `start`, never the
/// previous result.
fn add_months(start: Date, months: i64) -> CoreResult<Date> {
    let anchor_day = start.day();
    let start_month_index = i64::from(start.year()) * 12 + i64::from(start.month() as u8 - 1);
    let target_month_index = start_month_index
        .checked_add(months)
        .ok_or_else(|| CoreError::Validation("recurrence date arithmetic overflowed".into()))?;
    let year = i32::try_from(target_month_index.div_euclid(12))
        .map_err(|_| CoreError::Validation("recurrence date arithmetic overflowed".into()))?;
    let month0 = target_month_index.rem_euclid(12);
    // month0 is always 0..=11 (rem_euclid of a divisor of 12), so this
    // conversion cannot fail — the map_err exists only so a future change to
    // the arithmetic above fails loudly rather than panicking.
    let month = Month::try_from((month0 + 1) as u8)
        .map_err(|e| CoreError::Validation(format!("recurrence date arithmetic: {e}")))?;
    let days_in_month = month.length(year);
    let day = anchor_day.min(days_in_month);
    Date::from_calendar_date(year, month, day)
        .map_err(|e| CoreError::Validation(format!("recurrence date arithmetic: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dates(start: &str, frequency: RecurringFrequency, interval: i64, n: i64) -> Vec<String> {
        (0..n)
            .map(|i| occurrence_date(start, frequency, interval, i).unwrap())
            .collect()
    }

    #[test]
    fn occurrence_zero_is_always_start_date() {
        for (start, freq) in [
            ("2026-03-15", RecurringFrequency::Daily),
            ("2026-03-15", RecurringFrequency::Weekly),
            ("2026-03-15", RecurringFrequency::Monthly),
            ("2026-03-15", RecurringFrequency::Yearly),
        ] {
            assert_eq!(occurrence_date(start, freq, 1, 0).unwrap(), start);
        }
    }

    #[test]
    fn daily_and_weekly_are_exact_day_arithmetic() {
        assert_eq!(
            dates("2026-01-30", RecurringFrequency::Daily, 1, 4),
            vec!["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]
        );
        assert_eq!(
            dates("2026-01-01", RecurringFrequency::Daily, 3, 3),
            vec!["2026-01-01", "2026-01-04", "2026-01-07"]
        );
        assert_eq!(
            dates("2026-01-01", RecurringFrequency::Weekly, 2, 3),
            vec!["2026-01-01", "2026-01-15", "2026-01-29"]
        );
    }

    /// THE month-end trap, named explicitly in the task brief: a schedule on
    /// the 31st must behave predictably through February. The rule this
    /// module implements is "reapply the anchor day every month, clamped
    /// only when necessary" — so the day recovers to 31 every month that has
    /// one, rather than degrading to 28 and staying there.
    #[test]
    fn monthly_walk_never_degrades_below_28_and_recovers_to_31() {
        assert_eq!(
            dates("2026-01-31", RecurringFrequency::Monthly, 1, 6),
            vec![
                "2026-01-31",
                "2026-02-28", // clamped: 2026 is not a leap year
                "2026-03-31", // recovered — NOT 2026-03-28
                "2026-04-30", // clamped: April has 30 days
                "2026-05-31", // recovered
                "2026-06-30", // clamped: June has 30 days
            ]
        );
    }

    #[test]
    fn monthly_walk_respects_leap_february() {
        // 2028 is a leap year (divisible by 4, not by 100).
        assert_eq!(
            dates("2028-01-31", RecurringFrequency::Monthly, 1, 2),
            vec!["2028-01-31", "2028-02-29"]
        );
    }

    /// The same anchor-day rule extended to `Yearly`: a 29 February anchor
    /// recovers every leap year instead of being permanently demoted to the
    /// 28th the first time it crosses a non-leap one.
    #[test]
    fn yearly_leap_day_anchor_recovers_every_leap_year() {
        assert_eq!(
            dates("2028-02-29", RecurringFrequency::Yearly, 1, 5),
            vec![
                "2028-02-29",
                "2029-02-28", // clamped: not a leap year
                "2030-02-28",
                "2031-02-28",
                "2032-02-29", // recovered — leap year again
            ]
        );
    }

    #[test]
    fn interval_count_multiplies_the_step() {
        assert_eq!(
            dates("2026-01-15", RecurringFrequency::Monthly, 2, 4),
            vec!["2026-01-15", "2026-03-15", "2026-05-15", "2026-07-15"]
        );
        assert_eq!(
            dates("2026-01-15", RecurringFrequency::Yearly, 3, 3),
            vec!["2026-01-15", "2029-01-15", "2032-01-15"]
        );
    }

    #[test]
    fn century_non_leap_year_is_handled_by_the_time_crate() {
        // 2100 is divisible by 4 but not a leap year (divisible by 100, not
        // by 400) — the trap a hand-rolled `year % 4 == 0` clamp would miss.
        // time::util::days_in_year_month is what this module leans on
        // instead of reimplementing the Gregorian rule.
        assert_eq!(
            occurrence_date("2099-01-31", RecurringFrequency::Monthly, 1, 13).unwrap(),
            "2100-02-28"
        );
    }

    #[test]
    fn rejects_a_malformed_start_date() {
        assert!(occurrence_date("not-a-date", RecurringFrequency::Monthly, 1, 0).is_err());
    }

    #[test]
    fn due_date_adds_days_and_crosses_months() {
        assert_eq!(due_date("2026-09-15", 0).unwrap(), "2026-09-15");
        assert_eq!(due_date("2026-09-15", 30).unwrap(), "2026-10-15");
        assert_eq!(due_date("2026-01-20", 15).unwrap(), "2026-02-04");
    }
}
