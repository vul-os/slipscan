//! Bank-alert emails → transactions, driven entirely by installed
//! `mailrules` packs.
//!
//! The single most common way money visibly moves is a bank emailing you that
//! your card was used. This module turns those messages into
//! [`StatementLine`]s and hands them to [`import_statement_lines`] — the same
//! function a CSV or scraper statement import calls — so dedupe, the
//! description-derived categorisation cascade, and the payment-detection hook
//! inside `transaction_create` all apply without a second implementation of
//! any of them.
//!
//! # Rules are data
//!
//! Not one bank, country, currency, or date order appears in this file.
//! Formats arrive as signed, versioned [`MailRuleSet`]s
//! ([`slipscan_packs::mailrules`]) that the community publishes and the user
//! installs per book. This module is the *engine*: gate a message to a rule,
//! run that rule's extractors, and refuse to guess.
//!
//! # Declining is the safe answer
//!
//! A wrongly-parsed transaction is far worse than an unparsed one: it
//! corrupts the books, and because categorisation writes a durable
//! `merchant_mappings` row on the way through, it teaches the learning loop
//! to keep being wrong. Every ambiguity below therefore resolves to
//! [`AlertDecline`] with a reason the pack author can act on:
//!
//! * the captured amount must be *only* a number — any letter in it means the
//!   pattern caught prose (a `12 Jul 2026` captured as an amount would
//!   otherwise scan to `122026`);
//! * the amount's decimal separator must agree with the style the rule
//!   declared, so a `Point` rule can never quietly read `1 234,56` as
//!   123 456;
//! * the amount must be strictly positive and within core's own bound —
//!   direction comes from the rule, never from a stray `-`;
//! * a date extracted from the text must sit within
//!   [`MailRule::max_date_drift_days`] of the message's own date, because an
//!   alert is sent when the card is used;
//! * a merchant must contain a letter and be short enough to be a name;
//! * a two-way direction test must match exactly one side;
//! * an account hint that contradicts the target account declines rather than
//!   booking to the wrong card.

use std::collections::HashMap;

use slipscan_core::domain::{Account, TransactionSource};
use slipscan_core::CoreService;
use slipscan_packs::mailrules::{
    compile_pattern, AmountSpec, AmountStyle, CurrencySpec, DateSpec, Direction, DirectionSpec,
    MailPart, MailRule, MailRuleSet,
};
use slipscan_packs::Installer;

use super::{InboundMessage, MailboxFilter};
use crate::bank::{import_statement_lines, DecimalStyle, StatementImportOutcome, StatementLine};
use crate::{IngestError, IngestResult};

/// Longest text we will accept as a merchant/description. Beyond this the
/// pattern captured a paragraph, not a name.
const MAX_MERCHANT_CHARS: usize = 160;

/// Longest text we will accept as an account hint (`••1234`, `card ending
/// 4821`).
const MAX_ACCOUNT_HINT_CHARS: usize = 64;

/// Longest captured snippet echoed back in a decline reason. Decline reports
/// go to the user's own terminal, but there is no reason to spill a whole
/// mail body into one.
const MAX_DECLINE_SNIPPET_CHARS: usize = 80;

/// Mirrors core's own per-transaction bound. Duplicated as a *decline* here
/// on purpose: over the bound, core returns a validation error that would
/// abort the whole sync, whereas one unparseable alert should only cost that
/// alert.
const MAX_ALERT_AMOUNT_MINOR: i64 = 1_000_000_000_000_000;

/// Which field an extraction gave up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertField {
    Amount,
    Currency,
    Date,
    Merchant,
    Reference,
    Direction,
    AccountHint,
}

impl AlertField {
    pub fn as_str(self) -> &'static str {
        match self {
            AlertField::Amount => "amount",
            AlertField::Currency => "currency",
            AlertField::Date => "date",
            AlertField::Merchant => "merchant",
            AlertField::Reference => "reference",
            AlertField::Direction => "direction",
            AlertField::AccountHint => "account_hint",
        }
    }
}

/// Why a message did not become a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertDecline {
    /// No installed rule claims this sender. The overwhelmingly common case
    /// — ordinary mail — and not a problem worth reporting as one.
    NoRuleForSender,
    /// A rule claims the sender, but its subject/body gates did not match.
    /// Usually a different mail from the same bank (a statement notice, a
    /// marketing message).
    GatesDidNotMatch { rule_id: String },
    /// A rule matched and then a required field would not extract cleanly.
    /// This is the one worth surfacing: the pack has a rule for this mail and
    /// it needs fixing.
    Field {
        rule_id: String,
        field: AlertField,
        detail: String,
    },
}

impl std::fmt::Display for AlertDecline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlertDecline::NoRuleForSender => write!(f, "no mail rule claims this sender"),
            AlertDecline::GatesDidNotMatch { rule_id } => {
                write!(f, "rule {rule_id:?} claims the sender but did not match")
            }
            AlertDecline::Field {
                rule_id,
                field,
                detail,
            } => write!(
                f,
                "rule {rule_id:?} declined on {}: {detail}",
                field.as_str()
            ),
        }
    }
}

impl AlertDecline {
    /// Whether this decline is worth telling the user about.
    ///
    /// Only [`AlertDecline::Field`] is. A message no rule claims is ordinary
    /// mail, and a message whose gates did not match is the gates working:
    /// a bank sends statements and marketing from the same domain as its
    /// alerts, so reporting those would put a line of noise in every sync and
    /// teach the user to ignore the report. What is left is the signal —
    /// a rule that recognised this exact mail and then could not read it.
    pub fn is_actionable(&self) -> bool {
        matches!(self, AlertDecline::Field { .. })
    }
}

/// A message that a rule parsed into a statement line, whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAlert {
    pub pack_id: String,
    pub rule_id: String,
    /// The connector-scoped id of the message this came from.
    pub message_id: String,
    pub line: StatementLine,
    pub direction: Direction,
    /// The bank's reference, whether or not it was trusted as a dedupe key.
    pub reference: Option<String>,
    pub account_hint: Option<String>,
}

/// One rule with every pattern compiled once.
#[derive(Debug)]
struct CompiledRule {
    pack_id: String,
    rule: MailRule,
    subject_gates: Vec<regex::Regex>,
    body_gates: Vec<regex::Regex>,
    amount: regex::Regex,
    merchant: regex::Regex,
    currency: Option<regex::Regex>,
    date: Option<regex::Regex>,
    reference: Option<regex::Regex>,
    account_hint: Option<regex::Regex>,
    debit: Option<regex::Regex>,
    credit: Option<regex::Regex>,
}

/// The compiled mail-rule set for one book.
///
/// Compile once per sync, not once per message: a bank pack is a handful of
/// rules but each carries several patterns.
#[derive(Debug, Default)]
pub struct AlertRules {
    rules: Vec<CompiledRule>,
}

impl AlertRules {
    /// Compile `(pack_id, set)` pairs, as [`Installer::mailrule_sets`]
    /// returns them.
    ///
    /// Patterns were already validated at install time; compiling again here
    /// means the engine never has to assume that.
    pub fn compile(sets: Vec<(String, MailRuleSet)>) -> IngestResult<Self> {
        let mut rules = Vec::new();
        for (pack_id, set) in sets {
            for rule in set.rules {
                rules.push(compile_rule(pack_id.clone(), rule)?);
            }
        }
        Ok(Self { rules })
    }

    /// Load and compile every mail rule installed in `book_id`. A book with
    /// no mailrules pack yields an empty set that parses nothing.
    ///
    /// Read-only by construction ([`Installer::open_readonly`]): loading
    /// rules never creates a table, so this is safe against a book the user
    /// has opened read-only.
    pub fn load(svc: &CoreService, book_id: &str) -> IngestResult<Self> {
        let sets = svc.with_connection(|conn| {
            let Some(installer) = Installer::open_readonly(conn).map_err(pack_error)? else {
                return Ok(Vec::new());
            };
            installer.mailrule_sets(book_id).map_err(pack_error)
        })?;
        Self::compile(sets)
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// Try to parse one message.
    ///
    /// Rules are tried in installed order. The first rule to extract every
    /// required field wins; if some rule claimed the message but none
    /// succeeded, the **first** failure is reported, because that is the rule
    /// whose author meant to handle this mail.
    pub fn parse(&self, message: &InboundMessage) -> Result<ParsedAlert, AlertDecline> {
        let text = MessageText::new(message);
        let mut first_decline: Option<AlertDecline> = None;
        let mut claimed = false;

        for compiled in &self.rules {
            if !sender_matches(&message.from, &compiled.rule.from_patterns) {
                continue;
            }
            claimed = true;
            if !gates_match(compiled, &text) {
                if first_decline.is_none() {
                    first_decline = Some(AlertDecline::GatesDidNotMatch {
                        rule_id: compiled.rule.id.clone(),
                    });
                }
                continue;
            }
            match apply_rule(compiled, message, &text) {
                Ok(parsed) => return Ok(parsed),
                Err(decline) => {
                    // A hard field failure outranks an earlier "gates did not
                    // match": it names the rule that actually tried.
                    let replace = !matches!(first_decline, Some(AlertDecline::Field { .. }));
                    if replace {
                        first_decline = Some(decline);
                    }
                }
            }
        }

        Err(match first_decline {
            Some(decline) => decline,
            None if claimed => AlertDecline::NoRuleForSender,
            None => AlertDecline::NoRuleForSender,
        })
    }
}

fn pack_error(e: slipscan_packs::PackError) -> IngestError {
    IngestError::MailRules(e.to_string())
}

fn compile_rule(pack_id: String, rule: MailRule) -> IngestResult<CompiledRule> {
    let compile = |pattern: &str| -> IngestResult<regex::Regex> {
        compile_pattern(pattern).map_err(pack_error)
    };
    let subject_gates = rule
        .subject_patterns
        .iter()
        .map(|p| compile(p))
        .collect::<IngestResult<Vec<_>>>()?;
    let body_gates = rule
        .body_patterns
        .iter()
        .map(|p| compile(p))
        .collect::<IngestResult<Vec<_>>>()?;
    let amount = compile(&rule.amount.pattern)?;
    let merchant = compile(&rule.merchant.pattern)?;
    let currency = match &rule.currency {
        CurrencySpec::Fixed { .. } => None,
        CurrencySpec::Extract { pattern, .. } => Some(compile(pattern)?),
    };
    let date = match &rule.date {
        DateSpec::Received => None,
        DateSpec::Extract { pattern, .. } => Some(compile(pattern)?),
    };
    let reference = match &rule.reference {
        Some(spec) => Some(compile(&spec.pattern)?),
        None => None,
    };
    let account_hint = match &rule.account_hint {
        Some(spec) => Some(compile(&spec.pattern)?),
        None => None,
    };
    let (debit, credit) = match &rule.direction {
        DirectionSpec::Fixed { .. } => (None, None),
        DirectionSpec::Match {
            debit_pattern,
            credit_pattern,
            ..
        } => (
            Some(compile(debit_pattern)?),
            Some(compile(credit_pattern)?),
        ),
    };
    Ok(CompiledRule {
        pack_id,
        rule,
        subject_gates,
        body_gates,
        amount,
        merchant,
        currency,
        date,
        reference,
        account_hint,
        debit,
        credit,
    })
}

/// The message's text, normalized once per message.
struct MessageText {
    subject: String,
    body: String,
    any: String,
}

impl MessageText {
    fn new(message: &InboundMessage) -> Self {
        let subject = normalize_spaces(message.subject.as_deref().unwrap_or(""));
        let body = normalize_spaces(message.body_text.as_deref().unwrap_or(""));
        let any = format!("{subject}\n{body}");
        Self { subject, body, any }
    }

    fn part(&self, part: MailPart) -> &str {
        match part {
            MailPart::Subject => &self.subject,
            MailPart::Body => &self.body,
            MailPart::Any => &self.any,
        }
    }
}

/// Fold the space characters HTML mail is full of — non-breaking, narrow,
/// figure — into ASCII spaces, so a pattern written with a plain space
/// matches `R&nbsp;184.50` and the money guard sees a shape it recognises.
fn normalize_spaces(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{a0}' | '\u{202f}' | '\u{2007}' | '\u{2009}' | '\u{2002}' | '\u{2003}'
            | '\u{feff}' => ' ',
            other => other,
        })
        .collect()
}

/// Sender gating, with exactly the semantics the per-mailbox sender allowlist
/// already has (address, domain, subdomain) — reused rather than restated so
/// the two can never drift apart.
fn sender_matches(from: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    MailboxFilter {
        sender_allowlist: patterns.to_vec(),
    }
    .allows(from)
}

fn gates_match(compiled: &CompiledRule, text: &MessageText) -> bool {
    compiled
        .subject_gates
        .iter()
        .all(|re| re.is_match(&text.subject))
        && compiled.body_gates.iter().all(|re| re.is_match(&text.body))
}

fn capture(regex: &regex::Regex, text: &str, group: usize) -> Option<String> {
    let captures = regex.captures(text)?;
    Some(captures.get(group)?.as_str().to_string())
}

fn snippet(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= MAX_DECLINE_SNIPPET_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_DECLINE_SNIPPET_CHARS).collect();
    format!("{cut}…")
}

fn apply_rule(
    compiled: &CompiledRule,
    message: &InboundMessage,
    text: &MessageText,
) -> Result<ParsedAlert, AlertDecline> {
    let rule = &compiled.rule;
    let decline = |field: AlertField, detail: String| AlertDecline::Field {
        rule_id: rule.id.clone(),
        field,
        detail,
    };

    // --- amount ------------------------------------------------------------
    let amount_raw = capture(
        &compiled.amount,
        text.part(rule.amount.part),
        rule.amount.group,
    )
    .ok_or_else(|| decline(AlertField::Amount, "pattern matched nothing".into()))?;
    let magnitude = parse_alert_amount(&amount_raw, &rule.amount)
        .map_err(|reason| decline(AlertField::Amount, reason))?;

    // --- direction ---------------------------------------------------------
    let direction = resolve_direction(compiled, text)
        .map_err(|reason| decline(AlertField::Direction, reason))?;
    let amount_minor = match direction {
        Direction::Debit => -magnitude,
        Direction::Credit => magnitude,
    };

    // --- currency ----------------------------------------------------------
    let currency =
        resolve_currency(compiled, text).map_err(|reason| decline(AlertField::Currency, reason))?;

    // --- date --------------------------------------------------------------
    let posted_date = resolve_date(compiled, message, text)
        .map_err(|reason| decline(AlertField::Date, reason))?;

    // --- merchant / description -------------------------------------------
    let merchant_raw = capture(
        &compiled.merchant,
        text.part(rule.merchant.part),
        rule.merchant.group,
    )
    .ok_or_else(|| decline(AlertField::Merchant, "pattern matched nothing".into()))?;
    let description =
        clean_merchant(&merchant_raw).map_err(|reason| decline(AlertField::Merchant, reason))?;

    // --- reference ---------------------------------------------------------
    let mut reference = None;
    let mut provider_txn_id = None;
    if let (Some(spec), Some(regex)) = (&rule.reference, &compiled.reference) {
        let raw = capture(regex, text.part(spec.part), spec.group).ok_or_else(|| {
            decline(
                AlertField::Reference,
                "pattern matched nothing; drop the reference from the rule if \
                 this format does not carry one"
                    .into(),
            )
        })?;
        let cleaned = normalize_spaces(&raw).trim().to_string();
        if cleaned.is_empty() {
            return Err(decline(AlertField::Reference, "captured empty text".into()));
        }
        if spec.unique {
            provider_txn_id = Some(cleaned.clone());
        }
        reference = Some(cleaned);
    }

    // --- account hint ------------------------------------------------------
    let mut account_hint = None;
    if let (Some(spec), Some(regex)) = (&rule.account_hint, &compiled.account_hint) {
        let raw = capture(regex, text.part(spec.part), spec.group)
            .ok_or_else(|| decline(AlertField::AccountHint, "pattern matched nothing".into()))?;
        let cleaned = normalize_spaces(&raw).trim().to_string();
        if cleaned.is_empty() || cleaned.chars().count() > MAX_ACCOUNT_HINT_CHARS {
            return Err(decline(
                AlertField::AccountHint,
                format!("captured {:?}, which is not an account hint", snippet(&raw)),
            ));
        }
        account_hint = Some(cleaned);
    }

    Ok(ParsedAlert {
        pack_id: compiled.pack_id.clone(),
        rule_id: rule.id.clone(),
        message_id: message.id.clone(),
        line: StatementLine {
            posted_date,
            description,
            amount_minor,
            balance_minor: None,
            provider_txn_id,
            currency: Some(currency),
        },
        direction,
        reference,
        account_hint,
    })
}

fn resolve_direction(compiled: &CompiledRule, text: &MessageText) -> Result<Direction, String> {
    match &compiled.rule.direction {
        DirectionSpec::Fixed { direction } => Ok(*direction),
        DirectionSpec::Match { part, .. } => {
            let haystack = text.part(*part);
            let debit = compiled
                .debit
                .as_ref()
                .is_some_and(|re| re.is_match(haystack));
            let credit = compiled
                .credit
                .as_ref()
                .is_some_and(|re| re.is_match(haystack));
            match (debit, credit) {
                (true, false) => Ok(Direction::Debit),
                (false, true) => Ok(Direction::Credit),
                (true, true) => Err(
                    "both the debit and the credit pattern matched; refusing to \
                     guess whether this is money in or money out"
                        .into(),
                ),
                (false, false) => Err("neither the debit nor the credit pattern matched".into()),
            }
        }
    }
}

fn resolve_currency(compiled: &CompiledRule, text: &MessageText) -> Result<String, String> {
    match &compiled.rule.currency {
        CurrencySpec::Fixed { code } => Ok(code.clone()),
        CurrencySpec::Extract {
            part, group, map, ..
        } => {
            let regex = compiled
                .currency
                .as_ref()
                .ok_or_else(|| "currency pattern was not compiled".to_string())?;
            let raw = capture(regex, text.part(*part), *group)
                .ok_or_else(|| "pattern matched nothing".to_string())?;
            let token = raw.trim();
            if let Some(code) = map.get(token) {
                return Ok(code.clone());
            }
            // No mapping: accept a bare ISO code, and nothing else. A symbol
            // the pack did not map is a decline — `$` is not one currency.
            let upper = token.to_ascii_uppercase();
            if upper.len() == 3 && upper.bytes().all(|b| b.is_ascii_uppercase()) {
                return Ok(upper);
            }
            Err(format!(
                "captured {:?}, which is neither an ISO 4217 code nor a symbol \
                 the rule maps",
                snippet(token)
            ))
        }
    }
}

fn resolve_date(
    compiled: &CompiledRule,
    message: &InboundMessage,
    text: &MessageText,
) -> Result<String, String> {
    let received = received_date(message)?;
    let DateSpec::Extract { part, months, .. } = &compiled.rule.date else {
        return Ok(format_date(received));
    };

    let regex = compiled
        .date
        .as_ref()
        .ok_or_else(|| "date pattern was not compiled".to_string())?;
    let haystack = text.part(*part);
    let captures = regex
        .captures(haystack)
        .ok_or_else(|| "pattern matched nothing".to_string())?;
    let group = |name: &str| -> Result<String, String> {
        captures
            .name(name)
            .map(|m| m.as_str().trim().to_string())
            .ok_or_else(|| format!("named group {name:?} captured nothing"))
    };

    let year = parse_year(&group("y")?)?;
    let month = parse_month(&group("m")?, months.as_deref())?;
    let day_raw = group("d")?;
    let day: u8 = day_raw
        .parse()
        .map_err(|_| format!("day {:?} is not a number", snippet(&day_raw)))?;

    let month =
        time::Month::try_from(month).map_err(|_| format!("month {month} is outside 1..=12"))?;
    let date = time::Date::from_calendar_date(year, month, day)
        .map_err(|_| format!("{year}-{:02}-{day} is not a real date", month as u8))?;

    // An alert is sent when the transaction happens. A date far from the
    // message's own date means the pattern found something else entirely — a
    // card expiry, a statement period, part of a reference.
    let allowed = compiled.rule.max_date_drift_days;
    if allowed > 0 {
        let drift = (date - received).whole_days().abs();
        if drift > allowed {
            return Err(format!(
                "extracted {} but the message is dated {}, {drift} days apart \
                 (rule allows {allowed})",
                format_date(date),
                format_date(received)
            ));
        }
    }
    Ok(format_date(date))
}

fn received_date(message: &InboundMessage) -> Result<time::Date, String> {
    let raw = message.received_at.get(..10).ok_or_else(|| {
        format!(
            "message date {:?} is not RFC 3339",
            snippet(&message.received_at)
        )
    })?;
    parse_iso_date(raw).ok_or_else(|| format!("message date {:?} is not RFC 3339", snippet(raw)))
}

fn parse_iso_date(raw: &str) -> Option<time::Date> {
    let bytes = raw.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = raw[..4].parse().ok()?;
    let month: u8 = raw[5..7].parse().ok()?;
    let day: u8 = raw[8..10].parse().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()
}

fn format_date(date: time::Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    )
}

/// Two-digit years are read as 20xx. Anything else must be a full year: we
/// will not decide whether `26` means 1926.
fn parse_year(raw: &str) -> Result<i32, String> {
    if !raw.bytes().all(|b| b.is_ascii_digit()) || raw.is_empty() {
        return Err(format!("year {:?} is not a number", snippet(raw)));
    }
    match raw.len() {
        4 => raw
            .parse()
            .map_err(|_| format!("year {:?} is not a number", snippet(raw))),
        2 => raw
            .parse::<i32>()
            .map(|y| 2000 + y)
            .map_err(|_| format!("year {:?} is not a number", snippet(raw))),
        _ => Err(format!(
            "year {:?} has {} digits; use a 4-digit (or 2-digit) year",
            snippet(raw),
            raw.len()
        )),
    }
}

/// A month is digits, or a name from the rule's own `months` list. There is
/// no built-in month vocabulary: month names differ by language, and language
/// is data.
fn parse_month(raw: &str, months: Option<&[String]>) -> Result<u8, String> {
    if raw.bytes().all(|b| b.is_ascii_digit()) && !raw.is_empty() {
        return raw
            .parse()
            .map_err(|_| format!("month {:?} is not a number", snippet(raw)));
    }
    let Some(months) = months else {
        return Err(format!(
            "month {:?} is not numeric and the rule declares no `months` list",
            snippet(raw)
        ));
    };
    let needle = raw.to_lowercase();
    let matches: Vec<usize> = months
        .iter()
        .enumerate()
        .filter(|(_, name)| {
            let name = name.trim().to_lowercase();
            name == needle || name.starts_with(&needle)
        })
        .map(|(i, _)| i + 1)
        .collect();
    match matches.as_slice() {
        [only] => Ok(*only as u8),
        [] => Err(format!(
            "month {:?} is not in the rule's `months` list",
            snippet(raw)
        )),
        many => Err(format!(
            "month {:?} matches {} entries in the rule's `months` list",
            snippet(raw),
            many.len()
        )),
    }
}

fn clean_merchant(raw: &str) -> Result<String, String> {
    let collapsed = normalize_spaces(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return Err("captured empty text".into());
    }
    if collapsed.chars().count() > MAX_MERCHANT_CHARS {
        return Err(format!(
            "captured {} characters; a merchant name is not a paragraph",
            collapsed.chars().count()
        ));
    }
    if !collapsed.chars().any(char::is_alphabetic) {
        return Err(format!(
            "captured {:?}, which contains no letters and so is not a name",
            snippet(&collapsed)
        ));
    }
    Ok(collapsed)
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/// Parse an alert's captured amount into **positive** minor units.
///
/// The sign is deliberately not taken from the text — direction is the rule's
/// job — so anything that is not a plain positive number declines.
///
/// The shape guard in front of the shared statement parser is the load-bearing
/// part. `parse_amount_minor_styled` is built to be forgiving of CSV exports
/// (`R 1 234,56`, `(123.45)`, `123.45Cr`): it strips everything that is not a
/// digit or a separator. That is right for a column known to hold an amount,
/// and wrong for a regex capture over free-form mail, where the same
/// forgiveness would turn a captured `12 Jul 2026` into 122 026.
fn parse_alert_amount(raw: &str, spec: &AmountSpec) -> Result<i64, String> {
    let normalized = normalize_spaces(raw);
    let stripped = strip_currency_markers(normalized.trim());
    if stripped.is_empty() {
        return Err(format!(
            "captured {:?}, which holds no digits",
            snippet(raw)
        ));
    }
    if stripped.chars().any(char::is_alphabetic) {
        return Err(format!(
            "captured {:?}: an amount must be digits and separators only, so \
             this is prose the pattern swept up",
            snippet(raw)
        ));
    }
    if !amount_shape().is_match(stripped) {
        return Err(format!(
            "captured {:?}, which is not a well-formed amount",
            snippet(raw)
        ));
    }

    // The declared decimal separator must be the one actually used. Without
    // this, a `point` rule meeting `1 234,56` would drop the comma as
    // grouping and book 123 456.00.
    if let Some(used) = implied_decimal_separator(stripped) {
        let declared = match spec.style {
            AmountStyle::Auto => used,
            AmountStyle::Point => '.',
            AmountStyle::Comma => ',',
        };
        if used != declared {
            return Err(format!(
                "captured {:?}, whose decimal separator is {used:?}, but the rule \
                 declares {:?}",
                snippet(raw),
                spec.style
            ));
        }
    }

    let style = match spec.style {
        AmountStyle::Auto => DecimalStyle::Auto,
        AmountStyle::Point => DecimalStyle::Point,
        AmountStyle::Comma => DecimalStyle::Comma,
    };
    let minor = crate::bank::parse_amount_minor_styled(stripped, style)
        .map_err(|e| format!("captured {:?}: {e}", snippet(raw)))?;
    if minor <= 0 {
        return Err(format!(
            "captured {:?}, which is not a positive amount; direction comes \
             from the rule, never from the text",
            snippet(raw)
        ));
    }
    if minor > MAX_ALERT_AMOUNT_MINOR {
        return Err(format!(
            "captured {:?}, which exceeds the maximum bookable amount",
            snippet(raw)
        ));
    }
    Ok(minor)
}

/// A character that can only be a currency mark: not part of a number, not a
/// sign, not a bracket. `-`, `+` and parentheses are deliberately excluded —
/// stripping those would throw away the very thing that makes an amount not a
/// plain positive number, and the rule (not the text) decides direction.
fn is_currency_symbol(c: char) -> bool {
    !c.is_alphanumeric() && !c.is_whitespace() && !matches!(c, '.' | ',' | '-' | '+' | '(' | ')')
}

/// Strip at most one currency marker from each end — an ISO code or short
/// unit (`USD`, `kr`, `R`) or a symbol (`$`, `€`) — and nothing more.
///
/// The bound is what makes this safe. A blanket "trim anything that is not a
/// digit" would quietly eat a whole trailing phrase, so `184.50 at Woolies`
/// would reduce to `184.50` and a pattern that captured half the sentence
/// would look perfectly healthy. Anything longer than a currency word is left
/// in place, where the letter check below rejects it.
fn strip_currency_markers(text: &str) -> &str {
    let leading = |s: &str| -> usize {
        let letters = s.chars().take_while(|c| c.is_alphabetic()).count();
        if letters > 0 {
            // A word too long to be a currency unit is prose, not a marker.
            return if letters <= 3 {
                s.chars().take(letters).map(char::len_utf8).sum()
            } else {
                0
            };
        }
        let symbols = s.chars().take_while(|c| is_currency_symbol(*c)).count();
        if (1..=2).contains(&symbols) {
            s.chars().take(symbols).map(char::len_utf8).sum()
        } else {
            0
        }
    };
    let trailing = |s: &str| -> usize {
        let letters = s.chars().rev().take_while(|c| c.is_alphabetic()).count();
        if letters > 0 {
            return if letters <= 3 {
                s.chars().rev().take(letters).map(char::len_utf8).sum()
            } else {
                0
            };
        }
        let symbols = s
            .chars()
            .rev()
            .take_while(|c| is_currency_symbol(*c))
            .count();
        if (1..=2).contains(&symbols) {
            s.chars().rev().take(symbols).map(char::len_utf8).sum()
        } else {
            0
        }
    };

    let text = text.trim();
    let text = &text[leading(text)..];
    let text = text.trim();
    let cut = trailing(text);
    text[..text.len() - cut].trim()
}

/// Digits, optional `.`/`,`/space grouping in threes, optional 1–2 digit
/// fraction. Nothing else — no sign, no parentheses, no `Cr`/`Dr`.
fn amount_shape() -> &'static regex::Regex {
    static SHAPE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    SHAPE.get_or_init(|| {
        regex::Regex::new(r"^(?:\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)$")
            .expect("static amount shape compiles")
    })
}

/// Which separator is acting as the decimal point, if any. Only a separator
/// followed by one or two digits at the very end can be one — a group of
/// three is thousands.
fn implied_decimal_separator(amount: &str) -> Option<char> {
    let idx = amount.rfind(['.', ','])?;
    let frac = &amount[idx + 1..];
    if (1..=2).contains(&frac.len()) && frac.bytes().all(|b| b.is_ascii_digit()) {
        amount[idx..].chars().next()
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// What one message's alert parsing contributed.
#[derive(Debug, Default)]
pub struct AlertImportOutcome {
    pub statement: StatementImportOutcome,
    /// Alerts that parsed but were refused at import (account-hint mismatch).
    pub declined: Vec<AlertDecline>,
}

/// Check a parsed alert's account hint against the account it would be booked
/// to.
///
/// Only a **digit** comparison is made: hints are written `••1234`, `card
/// ending 1234`, `*1234`, and masked account numbers are just as varied, so
/// the trailing digits are the only part of either that means anything. When
/// both sides carry digits and they disagree, that is an alert about a
/// different card and it declines — booking it here would put one card's
/// spend on another's ledger. Anything unknown on either side is not a
/// mismatch, so this can only ever reject a *contradiction*.
pub fn account_hint_conflicts(hint: &str, account: &Account) -> bool {
    let hint_digits: String = hint.chars().filter(char::is_ascii_digit).collect();
    let Some(masked) = account.account_number_masked.as_deref() else {
        return false;
    };
    let account_digits: String = masked.chars().filter(char::is_ascii_digit).collect();
    if hint_digits.is_empty() || account_digits.is_empty() {
        return false;
    }
    // Compare on the shorter tail — one side may be masked more heavily.
    let take = hint_digits.len().min(account_digits.len());
    let tail = |s: &str| s[s.len() - take..].to_string();
    tail(&hint_digits) != tail(&account_digits)
}

/// Feed parsed alerts into the **statement import path**.
///
/// This is the whole point of parsing into [`StatementLine`]s: dedupe by
/// provider id or content hash, the description-derived categorisation
/// cascade, and the payment-detection hook inside `transaction_create` are
/// inherited rather than reimplemented. Source is
/// [`TransactionSource::Email`], so these rows are distinguishable from CSV
/// and scraper imports in reports and reconciliation.
pub fn import_alerts(
    svc: &CoreService,
    book_id: &str,
    account_id: &str,
    alerts: &[ParsedAlert],
) -> IngestResult<AlertImportOutcome> {
    let mut outcome = AlertImportOutcome::default();
    if alerts.is_empty() {
        return Ok(outcome);
    }
    let account = svc.account_get(account_id)?;

    let mut lines = Vec::with_capacity(alerts.len());
    for alert in alerts {
        if let Some(hint) = &alert.account_hint {
            if account_hint_conflicts(hint, &account) {
                outcome.declined.push(AlertDecline::Field {
                    rule_id: alert.rule_id.clone(),
                    field: AlertField::AccountHint,
                    detail: format!(
                        "alert is about account {:?}, which is not the account it \
                         would be imported into",
                        snippet(hint)
                    ),
                });
                continue;
            }
        }
        lines.push(alert.line.clone());
    }

    outcome.statement =
        import_statement_lines(svc, book_id, account_id, TransactionSource::Email, lines)?;
    Ok(outcome)
}

/// Group parsed alerts by the account they should be booked to, when the
/// caller has more than one candidate account and wants hints to route.
///
/// Returns `(account_id, alerts)` pairs plus the alerts whose hint matched no
/// account at all. Unused by the CLI today (which takes one explicit
/// `--account`), but it is the shape multi-card routing needs and it keeps
/// the hint from being decoration.
pub fn group_by_account_hint<'a>(
    accounts: &[Account],
    alerts: &'a [ParsedAlert],
) -> (HashMap<String, Vec<&'a ParsedAlert>>, Vec<&'a ParsedAlert>) {
    let mut grouped: HashMap<String, Vec<&ParsedAlert>> = HashMap::new();
    let mut unrouted = Vec::new();
    for alert in alerts {
        let Some(hint) = &alert.account_hint else {
            unrouted.push(alert);
            continue;
        };
        let candidates: Vec<&Account> = accounts
            .iter()
            .filter(|account| !account_hint_conflicts(hint, account))
            .filter(|account| account.account_number_masked.is_some())
            .collect();
        match candidates.as_slice() {
            [only] => grouped.entry(only.id.clone()).or_default().push(alert),
            // Zero candidates, or an ambiguous several: routing by guess is
            // exactly what this module refuses to do.
            _ => unrouted.push(alert),
        }
    }
    (grouped, unrouted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::parse_inbound;
    use slipscan_core::domain::{
        AccountKind, BookKind, NewAccount, NewBook, NewCategory, NewPayWatch,
    };
    use slipscan_core::secrets::MemorySecretStore;
    use slipscan_core::Db;
    use slipscan_packs::mailrules::{Extractor, ReferenceSpec};

    // -----------------------------------------------------------------
    // Fixtures. A wholly invented bank: no real institution's format ships
    // in this repo, which is the entire reason mailrules is a pack kind.
    // -----------------------------------------------------------------

    const BANK_DOMAIN: &str = "alerts.meridian.example";

    /// A realistically noisy alert: marketing footer, legal disclaimer, a
    /// support phone number, a card expiry and a reference — all full of
    /// digits that a sloppy pattern would happily mistake for the amount.
    fn card_alert_body() -> String {
        "Dear Customer,\n\
         \n\
         A card purchase of USD 1,284.50 was made at WOOLIES SANDTON CITY on \
         your card ending 4821.\n\
         Reference: TXN-9930412\n\
         Available balance: USD 12,004.19\n\
         \n\
         Card expires 09/28. Not you? Call us on 0860 123 4567 within 30 days.\n\
         This mailbox is not monitored. Meridian Bank Ltd, Reg 2001/012345/06.\n\
         Save 15% on travel insurance this July — terms apply.\n"
            .to_string()
    }

    fn message(from: &str, subject: &str, body: &str) -> InboundMessage {
        InboundMessage {
            id: "1".into(),
            message_id: Some("<a@meridian.example>".into()),
            from: from.into(),
            subject: Some(subject.into()),
            received_at: "2026-07-14T09:30:00Z".into(),
            attachments: vec![],
            receipt_html: None,
            body_text: Some(body.to_string()),
        }
    }

    fn card_alert() -> InboundMessage {
        message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Card purchase notification",
            &card_alert_body(),
        )
    }

    /// The fixture rule for the alert above.
    fn card_rule() -> MailRule {
        MailRule {
            id: "card-purchase".into(),
            description: None,
            from_patterns: vec!["meridian.example".into()],
            subject_patterns: vec![r"(?i)card purchase".into()],
            body_patterns: vec![],
            amount: AmountSpec {
                part: MailPart::Body,
                pattern: r"(?i)card purchase of\s+[A-Z]{3}\s*([\d., ]+?)\s+was made".into(),
                group: 1,
                style: AmountStyle::Point,
            },
            currency: CurrencySpec::Fixed { code: "USD".into() },
            date: DateSpec::Received,
            merchant: Extractor {
                part: MailPart::Body,
                pattern: r"(?i)was made at\s+(.+?)\s+on your card".into(),
                group: 1,
            },
            reference: None,
            direction: DirectionSpec::Fixed {
                direction: Direction::Debit,
            },
            account_hint: None,
            max_date_drift_days: 30,
        }
    }

    fn rules_of(rules: Vec<MailRule>) -> AlertRules {
        AlertRules::compile(vec![("fixture-alerts".to_string(), MailRuleSet { rules })]).unwrap()
    }

    fn svc_with_account(masked: Option<&str>) -> (CoreService, String, String) {
        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Mail".into(),
                kind: BookKind::Personal,
                currency: Some("USD".into()),
                country: None,
                region: None,
            })
            .unwrap();
        let account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "Card".into(),
                kind: AccountKind::Card,
                currency: "USD".into(),
                institution: Some("Meridian".into()),
                account_number_masked: masked.map(str::to_string),
                opening_balance_minor: None,
            })
            .unwrap();
        (svc, book.id, account.id)
    }

    // -----------------------------------------------------------------
    // The happy path
    // -----------------------------------------------------------------

    #[test]
    fn parses_a_noisy_card_alert_into_one_exact_statement_line() {
        let parsed = rules_of(vec![card_rule()]).parse(&card_alert()).unwrap();

        assert_eq!(parsed.rule_id, "card-purchase");
        assert_eq!(parsed.pack_id, "fixture-alerts");
        // 1,284.50 — not the balance, not the phone number, not the expiry.
        assert_eq!(parsed.line.amount_minor, -128_450);
        assert_eq!(parsed.line.currency.as_deref(), Some("USD"));
        assert_eq!(parsed.line.description, "WOOLIES SANDTON CITY");
        assert_eq!(parsed.line.posted_date, "2026-07-14");
        assert_eq!(parsed.direction, Direction::Debit);
        // No reference configured, so nothing is claimed as a dedupe anchor.
        assert_eq!(parsed.line.provider_txn_id, None);
    }

    #[test]
    fn a_debit_is_negative_and_a_credit_is_positive() {
        let mut credit = card_rule();
        credit.direction = DirectionSpec::Fixed {
            direction: Direction::Credit,
        };
        let parsed = rules_of(vec![credit]).parse(&card_alert()).unwrap();
        assert_eq!(parsed.line.amount_minor, 128_450);
    }

    #[test]
    fn parses_straight_out_of_a_raw_mime_alert_with_html_and_entities() {
        // The shape a real bank sends: HTML only, non-breaking spaces around
        // the amount, and the receipt heuristic deliberately not firing.
        let raw = "From: Meridian Alerts <noreply@alerts.meridian.example>\r\n\
To: you@home.example\r\n\
Subject: Card purchase notification\r\n\
Date: Tue, 14 Jul 2026 09:30:00 +0000\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body><p>A card purchase of USD&nbsp;1,284.50 was made at \
WOOLIES&nbsp;SANDTON CITY on your card ending 4821.</p>\
<p style=\"border:1px solid #eee\">Reference: TXN-9930412</p></body></html>\r\n";
        let message = parse_inbound(raw.as_bytes(), "77").unwrap();
        assert!(
            message.receipt_html.is_none(),
            "a bank alert is not a receipt — it must not become a document"
        );
        assert!(message.body_text.is_some(), "body text is kept regardless");

        let parsed = rules_of(vec![card_rule()]).parse(&message).unwrap();
        assert_eq!(parsed.line.amount_minor, -128_450);
        assert_eq!(parsed.line.description, "WOOLIES SANDTON CITY");
    }

    // -----------------------------------------------------------------
    // Money: locale, and refusing to guess
    // -----------------------------------------------------------------

    fn amount_spec(style: AmountStyle) -> AmountSpec {
        AmountSpec {
            part: MailPart::Body,
            pattern: "x".into(),
            group: 1,
            style,
        }
    }

    #[test]
    fn money_is_exact_integer_minor_units_in_both_locales() {
        // Point locale: comma groups thousands.
        for (raw, expected) in [
            ("1,284.50", 128_450),
            ("0.05", 5),
            ("12.5", 1_250),
            ("1,000,000.00", 100_000_000),
            ("7", 700),
        ] {
            assert_eq!(
                parse_alert_amount(raw, &amount_spec(AmountStyle::Point)).unwrap(),
                expected,
                "point: {raw}"
            );
        }
        // Comma locale: point groups thousands, comma is the decimal.
        for (raw, expected) in [
            ("1.284,50", 128_450),
            ("0,05", 5),
            ("1 234,56", 123_456),
            ("12,5", 1_250),
        ] {
            assert_eq!(
                parse_alert_amount(raw, &amount_spec(AmountStyle::Comma)).unwrap(),
                expected,
                "comma: {raw}"
            );
        }
    }

    #[test]
    fn a_declared_decimal_style_that_disagrees_with_the_text_declines() {
        // This is the case that silently multiplies money by 100 if you let
        // the forgiving CSV parser see it: `point` style meeting a comma
        // decimal would drop the comma as grouping and book 123 456.00.
        let err = parse_alert_amount("1 234,56", &amount_spec(AmountStyle::Point)).unwrap_err();
        assert!(err.contains("decimal separator"), "{err}");

        let err = parse_alert_amount("1,284.50", &amount_spec(AmountStyle::Comma)).unwrap_err();
        assert!(err.contains("decimal separator"), "{err}");

        // Auto accepts either, and still gets both right.
        assert_eq!(
            parse_alert_amount("1 234,56", &amount_spec(AmountStyle::Auto)).unwrap(),
            123_456
        );
        assert_eq!(
            parse_alert_amount("1,284.50", &amount_spec(AmountStyle::Auto)).unwrap(),
            128_450
        );
    }

    #[test]
    fn prose_swept_into_an_amount_capture_declines_instead_of_scanning_to_digits() {
        // The dangerous one: the shared statement parser strips non-digits,
        // so "12 Jul 2026" would otherwise become 122 026.
        for raw in [
            "12 Jul 2026",
            "184.50 at Woolies",
            "USD",
            "",
            "   ",
            "ref TXN-9930412",
        ] {
            assert!(
                parse_alert_amount(raw, &amount_spec(AmountStyle::Point)).is_err(),
                "should decline {raw:?}"
            );
        }
    }

    #[test]
    fn currency_markers_around_the_number_are_tolerated_but_letters_inside_are_not() {
        for raw in ["USD 184.50", "$184.50", "184.50 USD", "R 184.50", "€184,50"] {
            assert!(
                parse_alert_amount(raw, &amount_spec(AmountStyle::Auto)).is_ok(),
                "should accept {raw:?}"
            );
        }
        // A number with a unit glued into the middle is not an amount.
        assert!(parse_alert_amount("18USD4.50", &amount_spec(AmountStyle::Auto)).is_err());
    }

    #[test]
    fn non_positive_and_out_of_range_amounts_decline() {
        // Zero is never a real card alert, and the sign is the rule's job.
        assert!(parse_alert_amount("0.00", &amount_spec(AmountStyle::Point)).is_err());
        assert!(parse_alert_amount("-12.00", &amount_spec(AmountStyle::Point)).is_err());
        assert!(parse_alert_amount("(12.00)", &amount_spec(AmountStyle::Point)).is_err());
        // A captured card number must not become a transaction.
        assert!(
            parse_alert_amount("4821000012349999999", &amount_spec(AmountStyle::Point)).is_err()
        );
    }

    #[test]
    fn an_unreadable_amount_declines_the_whole_message() {
        let mut rule = card_rule();
        // A pattern that grabs the expiry date instead of the amount.
        rule.amount.pattern = r"(?i)card expires ([\d/]+)".into();
        let decline = rules_of(vec![rule]).parse(&card_alert()).unwrap_err();
        assert!(
            matches!(
                &decline,
                AlertDecline::Field {
                    field: AlertField::Amount,
                    ..
                }
            ),
            "{decline}"
        );
    }

    // -----------------------------------------------------------------
    // Dates
    // -----------------------------------------------------------------

    #[test]
    fn extracted_dates_follow_the_rules_named_groups_not_a_guess() {
        let body = "Purchase on 03/04/2026 of USD 10.00 was made at CAFE ROMA on your card.";
        let message = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Card purchase notification",
            body,
        );

        // Day-first: 3 April.
        let mut rule = card_rule();
        rule.amount.pattern = r"(?i)of USD ([\d.,]+) was made".into();
        rule.date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{2})/(?P<m>\d{2})/(?P<y>\d{4})".into(),
            months: None,
        };
        rule.max_date_drift_days = 0;
        let parsed = rules_of(vec![rule.clone()]).parse(&message).unwrap();
        assert_eq!(parsed.line.posted_date, "2026-04-03");

        // Month-first, same text: 4 March. The pack author says which.
        rule.date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<m>\d{2})/(?P<d>\d{2})/(?P<y>\d{4})".into(),
            months: None,
        };
        let parsed = rules_of(vec![rule]).parse(&message).unwrap();
        assert_eq!(parsed.line.posted_date, "2026-03-04");
    }

    #[test]
    fn month_names_come_from_the_pack_in_whatever_language() {
        let body = "Achat de USD 10.00 was made at CAFE ROMA on your card le 14 juillet 2026.";
        let message = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Card purchase notification",
            body,
        );
        let mut rule = card_rule();
        rule.amount.pattern = r"(?i)de USD ([\d.,]+) was made".into();
        rule.date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{1,2})\s+(?P<m>[a-zû]+)\s+(?P<y>\d{4})".into(),
            months: Some(
                [
                    "janvier",
                    "février",
                    "mars",
                    "avril",
                    "mai",
                    "juin",
                    "juillet",
                    "août",
                    "septembre",
                    "octobre",
                    "novembre",
                    "décembre",
                ]
                .iter()
                .map(|m| m.to_string())
                .collect(),
            ),
        };
        let parsed = rules_of(vec![rule]).parse(&message).unwrap();
        assert_eq!(parsed.line.posted_date, "2026-07-14");
    }

    #[test]
    fn a_date_far_from_the_message_declines_rather_than_booking_the_wrong_month() {
        // The pattern finds a statement period instead of the purchase date.
        // Nothing about "2020-01-01" is malformed — it is a real date, and
        // only its distance from the message gives the misparse away.
        let mut rule = card_rule();
        rule.date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{2})/(?P<m>\d{2})/(?P<y>\d{4})".into(),
            months: None,
        };
        let stale = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Card purchase notification",
            "A card purchase of USD 1,284.50 was made at CAFE ROMA on your card. \
             Statement period 01/01/2020.",
        );
        let decline = rules_of(vec![rule]).parse(&stale).unwrap_err();
        match &decline {
            AlertDecline::Field {
                field: AlertField::Date,
                detail,
                ..
            } => assert!(detail.contains("days apart"), "{detail}"),
            other => panic!("expected a date decline, got {other}"),
        }
    }

    #[test]
    fn an_impossible_date_declines() {
        let mut rule = card_rule();
        rule.date = DateSpec::Extract {
            part: MailPart::Body,
            pattern: r"(?P<d>\d{2})/(?P<m>\d{2})/(?P<y>\d{4})".into(),
            months: None,
        };
        let message = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Card purchase notification",
            "A card purchase of USD 1,284.50 was made at CAFE ROMA on your card 31/02/2026.",
        );
        let decline = rules_of(vec![rule]).parse(&message).unwrap_err();
        assert!(
            matches!(
                &decline,
                AlertDecline::Field {
                    field: AlertField::Date,
                    ..
                }
            ),
            "{decline}"
        );
    }

    // -----------------------------------------------------------------
    // Direction, merchant, gates
    // -----------------------------------------------------------------

    #[test]
    fn a_direction_test_matching_both_or_neither_side_declines() {
        let mut rule = card_rule();
        rule.direction = DirectionSpec::Match {
            part: MailPart::Body,
            // Both of these appear in the fixture body ("purchase" and
            // "balance"), so the message is genuinely ambiguous.
            debit_pattern: "(?i)purchase".into(),
            credit_pattern: "(?i)balance".into(),
        };
        let decline = rules_of(vec![rule.clone()])
            .parse(&card_alert())
            .unwrap_err();
        match &decline {
            AlertDecline::Field {
                field: AlertField::Direction,
                detail,
                ..
            } => assert!(detail.contains("both"), "{detail}"),
            other => panic!("expected a direction decline, got {other}"),
        }

        rule.direction = DirectionSpec::Match {
            part: MailPart::Body,
            debit_pattern: "(?i)debited".into(),
            credit_pattern: "(?i)credited".into(),
        };
        let decline = rules_of(vec![rule]).parse(&card_alert()).unwrap_err();
        assert!(
            matches!(
                &decline,
                AlertDecline::Field {
                    field: AlertField::Direction,
                    ..
                }
            ),
            "{decline}"
        );
    }

    #[test]
    fn a_direction_test_matching_exactly_one_side_resolves() {
        let mut rule = card_rule();
        rule.direction = DirectionSpec::Match {
            part: MailPart::Body,
            debit_pattern: "(?i)card purchase of".into(),
            credit_pattern: "(?i)payment received".into(),
        };
        let parsed = rules_of(vec![rule]).parse(&card_alert()).unwrap();
        assert_eq!(parsed.direction, Direction::Debit);
        assert!(parsed.line.amount_minor < 0);
    }

    #[test]
    fn a_merchant_that_is_not_a_name_declines() {
        // Captures the card tail instead of the shop: digits, no name.
        let mut rule = card_rule();
        rule.merchant.pattern = r"card ending (\d+)".into();
        let decline = rules_of(vec![rule]).parse(&card_alert()).unwrap_err();
        match &decline {
            AlertDecline::Field {
                field: AlertField::Merchant,
                detail,
                ..
            } => assert!(detail.contains("no letters"), "{detail}"),
            other => panic!("expected a merchant decline, got {other}"),
        }
    }

    #[test]
    fn a_merchant_capture_that_swallows_the_body_declines() {
        let mut rule = card_rule();
        rule.merchant.pattern = r"(?is)was made at (.+)".into();
        let decline = rules_of(vec![rule]).parse(&card_alert()).unwrap_err();
        match &decline {
            AlertDecline::Field {
                field: AlertField::Merchant,
                detail,
                ..
            } => assert!(detail.contains("paragraph"), "{detail}"),
            other => panic!("expected a merchant decline, got {other}"),
        }
    }

    #[test]
    fn mail_no_rule_claims_is_not_reported_as_a_problem() {
        let newsletter = message(
            "news@shop.example",
            "Fresh arrivals this week",
            "Ten new things we love, from 99.00.",
        );
        let decline = rules_of(vec![card_rule()]).parse(&newsletter).unwrap_err();
        assert_eq!(decline, AlertDecline::NoRuleForSender);
        assert!(!decline.is_actionable(), "ordinary mail is not an error");
    }

    #[test]
    fn other_mail_from_the_same_bank_is_gated_out() {
        let statement_notice = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Your monthly statement is ready",
            "Your statement for June 2026 is available. Balance USD 12,004.19.",
        );
        let decline = rules_of(vec![card_rule()])
            .parse(&statement_notice)
            .unwrap_err();
        assert!(
            matches!(&decline, AlertDecline::GatesDidNotMatch { rule_id } if rule_id == "card-purchase"),
            "{decline}"
        );
        // Not actionable: a bank sends statements and marketing from the same
        // domain as its alerts, and the gates standing down is them working.
        assert!(!decline.is_actionable());
    }

    #[test]
    fn sender_gating_matches_domains_and_subdomains_but_not_lookalikes() {
        let rules = rules_of(vec![card_rule()]);
        for from in [
            "noreply@meridian.example",
            "alerts@secure.meridian.example",
            "NOREPLY@Meridian.Example",
        ] {
            let message = message(from, "Card purchase notification", &card_alert_body());
            assert!(rules.parse(&message).is_ok(), "should claim {from}");
        }
        for from in [
            "noreply@meridian.example.evil.test",
            "noreply@notmeridian.example",
        ] {
            let message = message(from, "Card purchase notification", &card_alert_body());
            assert_eq!(
                rules.parse(&message).unwrap_err(),
                AlertDecline::NoRuleForSender,
                "should not claim {from}"
            );
        }
    }

    #[test]
    fn several_rules_are_tried_in_order_and_the_first_complete_one_wins() {
        let mut broken = card_rule();
        broken.id = "aaa-broken".into();
        broken.amount.pattern = r"(?i)nothing here ([\d.]+)".into();
        let rules = rules_of(vec![broken, card_rule()]);
        let parsed = rules.parse(&card_alert()).unwrap();
        assert_eq!(parsed.rule_id, "card-purchase");
    }

    // -----------------------------------------------------------------
    // Reference and account hint
    // -----------------------------------------------------------------

    #[test]
    fn a_reference_is_only_a_dedupe_key_when_the_pack_says_it_is_unique() {
        let mut rule = card_rule();
        rule.reference = Some(ReferenceSpec {
            part: MailPart::Body,
            pattern: r"Reference:\s*(\S+)".into(),
            group: 1,
            unique: false,
        });
        let parsed = rules_of(vec![rule.clone()]).parse(&card_alert()).unwrap();
        assert_eq!(parsed.reference.as_deref(), Some("TXN-9930412"));
        assert_eq!(
            parsed.line.provider_txn_id, None,
            "a reference not declared unique must never anchor dedupe"
        );

        rule.reference.as_mut().unwrap().unique = true;
        let parsed = rules_of(vec![rule]).parse(&card_alert()).unwrap();
        assert_eq!(parsed.line.provider_txn_id.as_deref(), Some("TXN-9930412"));
    }

    #[test]
    fn account_hints_only_reject_a_contradiction() {
        let (svc, _book, account_id) = svc_with_account(Some("••4821"));
        let account = svc.account_get(&account_id).unwrap();
        assert!(!account_hint_conflicts("card ending 4821", &account));
        assert!(!account_hint_conflicts("****4821", &account));
        assert!(account_hint_conflicts("card ending 1234", &account));

        // Unknown on either side is never a conflict.
        let (svc, _book, bare_id) = svc_with_account(None);
        let bare = svc.account_get(&bare_id).unwrap();
        assert!(!account_hint_conflicts("card ending 1234", &bare));
        assert!(!account_hint_conflicts("your cheque account", &account));
    }

    #[test]
    fn an_alert_about_another_card_is_declined_not_booked_here() {
        let (svc, book_id, account_id) = svc_with_account(Some("••9999"));
        let mut rule = card_rule();
        rule.account_hint = Some(Extractor {
            part: MailPart::Body,
            pattern: r"card ending (\d+)".into(),
            group: 1,
        });
        let parsed = rules_of(vec![rule]).parse(&card_alert()).unwrap();
        assert_eq!(parsed.account_hint.as_deref(), Some("4821"));

        let outcome = import_alerts(&svc, &book_id, &account_id, &[parsed]).unwrap();
        assert!(outcome.statement.imported.is_empty(), "nothing booked");
        assert_eq!(outcome.declined.len(), 1);
        assert!(matches!(
            &outcome.declined[0],
            AlertDecline::Field {
                field: AlertField::AccountHint,
                ..
            }
        ));
    }

    // -----------------------------------------------------------------
    // The import path: what reusing statement import buys
    // -----------------------------------------------------------------

    #[test]
    fn alerts_import_as_email_sourced_transactions_and_dedupe() {
        let (svc, book_id, account_id) = svc_with_account(None);
        let parsed = rules_of(vec![card_rule()]).parse(&card_alert()).unwrap();

        let first =
            import_alerts(&svc, &book_id, &account_id, std::slice::from_ref(&parsed)).unwrap();
        assert_eq!(first.statement.imported.len(), 1);
        let txn = &first.statement.imported[0];
        assert_eq!(txn.amount_minor, -128_450);
        assert_eq!(txn.currency, "USD");
        assert_eq!(txn.source, slipscan_core::domain::TransactionSource::Email);
        assert_eq!(txn.description.as_deref(), Some("WOOLIES SANDTON CITY"));
        // We never invent a display merchant, exactly like a statement line.
        assert_eq!(txn.merchant, None);

        // The same alert refetched is a duplicate, not a second transaction.
        let again = import_alerts(&svc, &book_id, &account_id, &[parsed]).unwrap();
        assert!(again.statement.imported.is_empty());
        assert_eq!(again.statement.duplicates, 1);
    }

    #[test]
    fn a_unique_reference_dedupes_even_when_the_rest_differs() {
        let (svc, book_id, account_id) = svc_with_account(None);
        let mut rule = card_rule();
        rule.reference = Some(ReferenceSpec {
            part: MailPart::Body,
            pattern: r"Reference:\s*(\S+)".into(),
            group: 1,
            unique: true,
        });
        let rules = rules_of(vec![rule]);

        let first = rules.parse(&card_alert()).unwrap();
        import_alerts(&svc, &book_id, &account_id, &[first]).unwrap();

        // The bank resends the same transaction with a corrected merchant
        // spelling. The reference is what makes this one transaction.
        let mut resent = card_alert();
        resent.body_text =
            Some(card_alert_body().replace("WOOLIES SANDTON CITY", "WOOLIES SANDTON"));
        let second = rules.parse(&resent).unwrap();
        let outcome = import_alerts(&svc, &book_id, &account_id, &[second]).unwrap();
        assert!(outcome.statement.imported.is_empty());
        assert_eq!(outcome.statement.duplicates, 1);
    }

    /// The reason alerts go through `import_statement_lines` at all: a mail
    /// transaction inherits the book's own learned categorisation, with no
    /// categorisation code in this module.
    #[test]
    fn an_alert_transaction_inherits_the_books_categorisation() {
        let (svc, book_id, account_id) = svc_with_account(None);
        let category = svc
            .category_create(NewCategory {
                book_id: book_id.clone(),
                parent_id: None,
                name: "Groceries".into(),
                kind: slipscan_core::domain::CategoryKind::Expense,
                icon: None,
                color: None,
            })
            .unwrap();
        let rules = rules_of(vec![card_rule()]);

        // First alert lands uncategorised; the user corrects it, which is
        // what teaches the book.
        let first = rules.parse(&card_alert()).unwrap();
        let outcome = import_alerts(&svc, &book_id, &account_id, &[first]).unwrap();
        let txn = &outcome.statement.imported[0];
        assert_eq!(txn.category_id, None);
        svc.transaction_categorize(&txn.id, &category.id).unwrap();

        // A later alert for the same merchant is categorised on arrival —
        // through the description-derived key, exactly as a statement line.
        let mut later = card_alert();
        later.id = "2".into();
        later.received_at = "2026-07-21T09:30:00Z".into();
        later.body_text = Some(card_alert_body().replace("1,284.50", "312.75"));
        let parsed = rules.parse(&later).unwrap();
        assert_eq!(parsed.line.amount_minor, -31_275);
        let outcome = import_alerts(&svc, &book_id, &account_id, &[parsed]).unwrap();
        let txn = &outcome.statement.imported[0];
        assert_eq!(
            txn.category_id.as_deref(),
            Some(category.id.as_str()),
            "the alert inherited the correction the user made earlier"
        );
    }

    /// The Payments feature's detection hook lives inside
    /// `transaction_create`, so routing alerts through the statement path is
    /// what finally lets an emailed payment notification fire it.
    #[test]
    fn an_inbound_alert_fires_the_payment_detection_hook() {
        let (svc, book_id, account_id) = svc_with_account(None);
        let watch = svc
            .pay_watch_add(NewPayWatch {
                book_id: book_id.clone(),
                code: "INV-2026-114".into(),
                label: Some("Invoice 114".into()),
                expected_amount_minor: None,
                expected_currency: None,
            })
            .unwrap();

        let mut rule = card_rule();
        rule.id = "payment-received".into();
        rule.subject_patterns = vec![r"(?i)payment received".into()];
        rule.amount.pattern = r"(?i)USD ([\d.,]+) received".into();
        rule.merchant.pattern = r"(?i)reference (.+?) from".into();
        rule.direction = DirectionSpec::Fixed {
            direction: Direction::Credit,
        };

        let message = message(
            &format!("noreply@{BANK_DOMAIN}"),
            "Payment received",
            "USD 2,500.00 received with reference INV-2026-114 from ACME TRADING.",
        );
        let parsed = rules_of(vec![rule]).parse(&message).unwrap();
        assert_eq!(parsed.line.amount_minor, 250_000);

        let outcome = import_alerts(&svc, &book_id, &account_id, &[parsed]).unwrap();
        assert_eq!(outcome.statement.imported.len(), 1);

        let matches = svc.pay_match_list(&book_id).unwrap();
        assert_eq!(
            matches.len(),
            1,
            "the emailed payment should have been detected"
        );
        assert_eq!(matches[0].watch_id, watch.id);
        assert_eq!(
            matches[0].transaction_id, outcome.statement.imported[0].id,
            "the match points at the transaction the email created"
        );
    }

    #[test]
    fn a_book_with_no_mailrules_pack_parses_nothing_and_costs_nothing() {
        let (svc, book_id, _account) = svc_with_account(None);
        let rules = AlertRules::load(&svc, &book_id).unwrap();
        assert!(rules.is_empty());
        assert_eq!(rules.rule_count(), 0);
        assert_eq!(
            rules.parse(&card_alert()).unwrap_err(),
            AlertDecline::NoRuleForSender
        );
    }

    #[test]
    fn hint_routing_only_picks_an_account_when_it_is_unambiguous() {
        let (svc, book_id, first) = svc_with_account(Some("••4821"));
        let second = svc
            .account_create(NewAccount {
                book_id: book_id.clone(),
                name: "Other card".into(),
                kind: AccountKind::Card,
                currency: "USD".into(),
                institution: Some("Meridian".into()),
                account_number_masked: Some("••1234".into()),
                opening_balance_minor: None,
            })
            .unwrap();
        let accounts = vec![
            svc.account_get(&first).unwrap(),
            svc.account_get(&second.id).unwrap(),
        ];

        let mut rule = card_rule();
        rule.account_hint = Some(Extractor {
            part: MailPart::Body,
            pattern: r"card ending (\d+)".into(),
            group: 1,
        });
        let parsed = rules_of(vec![rule]).parse(&card_alert()).unwrap();
        let alerts = vec![parsed];
        let (grouped, unrouted) = group_by_account_hint(&accounts, &alerts);
        assert!(unrouted.is_empty());
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[&first].len(), 1);

        // With no hint there is nothing to route on, and guessing is refused.
        let no_hint = rules_of(vec![card_rule()]).parse(&card_alert()).unwrap();
        let alerts = vec![no_hint];
        let (grouped, unrouted) = group_by_account_hint(&accounts, &alerts);
        assert!(grouped.is_empty());
        assert_eq!(unrouted.len(), 1);
    }
}
