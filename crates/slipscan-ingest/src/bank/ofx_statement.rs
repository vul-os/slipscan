//! OFX-statement adapter: the second concrete [`BankAdapter`], parsing bank
//! statement exports in OFX (Open Financial Exchange) format.
//!
//! Two OFX generations exist in the wild and both are accepted here:
//! * **OFX 1.x** — SGML-ish. Leaf tags are unclosed (`<DTPOSTED>20260601`
//!   with no `</DTPOSTED>`), and the file opens with a header block of
//!   `KEY:VALUE` lines before `<OFX>`.
//! * **OFX 2.x** — well-formed XML, opening with an `<?xml?>` declaration
//!   and an `<?OFX ...?>` processing instruction, every tag properly closed.
//!
//! Both shapes are read by the same flat tag/value scan ([`tokenize`]):
//! whatever text sits between an opening tag and the next `<` is that tag's
//! value, whether the next `<` is that same tag's own closing tag (OFX 2) or
//! simply the next sibling (OFX 1). No SGML or XML crate — matching the rest
//! of this crate, which reaches for a dependency only when hand-rolling the
//! shape would be the wrong tradeoff, and here the shape needed is tiny
//! (transactions plus two statement-level fields).
//!
//! **Refuses rather than guesses** — the same posture as
//! [`crate::email::alerts`]: a file with no `<OFX>` root, a `<STMTTRN>`
//! missing its date or amount, or an amount that cannot be represented
//! exactly in minor units all fail with a specific reason rather than being
//! skipped or invented.
//!
//! Purely local: reads a file, talks to nothing.

use super::{BankAdapter, DateRange, StatementLine};
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use std::path::Path;

/// Stable bank id for a bare OFX import — OFX carries its own column
/// structure, so unlike [`super::csv_statement`] there is no per-bank preset
/// to name it after.
pub const OFX_BANK_ID: &str = "ofx";

/// Parsed OFX statement: transaction lines plus the statement-level metadata
/// that has no natural home on a single [`StatementLine`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OfxStatement {
    pub lines: Vec<StatementLine>,
    /// ISO-4217, from `<CURDEF>`. Applied to every line's
    /// [`StatementLine::currency`] — OFX declares one currency for the whole
    /// statement, not per transaction.
    pub currency: Option<String>,
    /// Closing balance from `<LEDGERBAL><BALAMT>`, in minor units.
    pub ledger_balance_minor: Option<i64>,
    /// `<LEDGERBAL><DTASOF>`, normalised to `YYYY-MM-DD`.
    pub ledger_balance_date: Option<String>,
}

/// [`BankAdapter`] over one OFX statement export (1.x or 2.x).
pub struct OfxStatementAdapter {
    bank_id: String,
    content: Vec<u8>,
}

impl OfxStatementAdapter {
    pub fn new(bank_id: impl Into<String>, content: Vec<u8>) -> Self {
        Self {
            bank_id: bank_id.into(),
            content,
        }
    }

    pub fn from_path(bank_id: impl Into<String>, path: &Path) -> IngestResult<Self> {
        Ok(Self::new(bank_id, std::fs::read(path)?))
    }

    /// Parse the full statement: transaction lines plus `CURDEF` and
    /// `LEDGERBAL`.
    pub fn parse_statement(&self) -> IngestResult<OfxStatement> {
        let text = String::from_utf8_lossy(&self.content);
        parse_ofx(&text)
    }

    /// Parse every transaction line in the statement (no range filter).
    pub fn parse_all(&self) -> IngestResult<Vec<StatementLine>> {
        Ok(self.parse_statement()?.lines)
    }
}

#[async_trait(?Send)]
impl BankAdapter for OfxStatementAdapter {
    fn bank_id(&self) -> &str {
        &self.bank_id
    }

    async fn fetch_lines(&mut self, range: &DateRange) -> IngestResult<Vec<StatementLine>> {
        Ok(self
            .parse_all()?
            .into_iter()
            .filter(|l| range.contains(&l.posted_date))
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Tag/value scan
// ---------------------------------------------------------------------------

/// One `<TAG>`/`</TAG>` occurrence plus the text immediately following it, up
/// to the next `<`.
struct Token<'a> {
    name: &'a str,
    closing: bool,
    value: &'a str,
}

/// Scan `body` for every tag, OFX 1.x SGML and OFX 2.x XML alike.
///
/// Processing instructions (`<?xml ...?>`, `<?OFX ...?>`) and comments
/// (`<!-- ... -->`) are skipped, not tokenized. The OFX 1.x `KEY:VALUE`
/// header block has no angle brackets at all, so it is naturally skipped too
/// — the first token this yields is `<OFX>` either way.
fn tokenize(body: &str) -> Vec<Token<'_>> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while let Some(rel) = body[i..].find('<') {
        let start = i + rel;
        let Some(end_rel) = body[start..].find('>') else {
            break; // an unterminated '<' at EOF: nothing more to tokenize
        };
        let end = start + end_rel;
        let raw = body[start + 1..end].trim();

        let value_start = end + 1;
        let value_end = body[value_start..]
            .find('<')
            .map(|o| value_start + o)
            .unwrap_or(body.len());
        let value = body[value_start..value_end].trim();
        i = value_end;

        if raw.starts_with('?') || raw.starts_with('!') {
            continue; // XML declaration / processing instruction / comment
        }
        let (closing, name) = match raw.strip_prefix('/') {
            Some(n) => (true, n.trim()),
            None => (false, raw.trim_end_matches('/').trim()),
        };
        if name.is_empty() {
            continue;
        }
        tokens.push(Token {
            name,
            closing,
            value,
        });
    }
    tokens
}

// ---------------------------------------------------------------------------
// Statement parse
// ---------------------------------------------------------------------------

/// One `<STMTTRN>` block, gathered field by field as its tags are seen and
/// validated only once the closing tag arrives.
#[derive(Default)]
struct PartialTxn {
    dtposted: Option<String>,
    trnamt: Option<String>,
    name: Option<String>,
    memo: Option<String>,
    fitid: Option<String>,
}

impl PartialTxn {
    /// A label for error messages — the FITID when there is one, since that
    /// is the one field a real export always carries and a user can grep
    /// their file for.
    fn label(&self) -> String {
        match self.fitid.as_deref() {
            Some(id) if !id.is_empty() => format!("<STMTTRN> FITID {id:?}"),
            _ => "a <STMTTRN> with no FITID".to_string(),
        }
    }

    fn finish(self) -> IngestResult<StatementLine> {
        let label = self.label();

        let dtposted = self
            .dtposted
            .filter(|s| !s.is_empty())
            .ok_or_else(|| IngestError::Parse(format!("{label}: missing DTPOSTED")))?;
        let posted_date = parse_ofx_date(&dtposted)
            .map_err(|e| IngestError::Parse(format!("{label}: DTPOSTED {dtposted:?}: {e}")))?;

        let trnamt = self
            .trnamt
            .filter(|s| !s.is_empty())
            .ok_or_else(|| IngestError::Parse(format!("{label}: missing TRNAMT")))?;
        let amount_minor = parse_ofx_amount_minor(&trnamt)
            .map_err(|e| IngestError::Parse(format!("{label}: TRNAMT {trnamt:?}: {e}")))?;

        // NAME is the payee/description field; MEMO is supplementary. Most
        // real exports carry one or the other, some carry both — prefer
        // NAME, since that is what OFX documents as the primary field, and
        // fall back to MEMO rather than invent a description when NAME is
        // absent. Neither present is refused: a transaction with no
        // description at all is not something to guess at.
        let name = self.name.filter(|s| !s.is_empty());
        let memo = self.memo.filter(|s| !s.is_empty());
        let description = name.or(memo).ok_or_else(|| {
            IngestError::Parse(format!("{label}: neither NAME nor MEMO is present"))
        })?;

        Ok(StatementLine {
            posted_date,
            description: unescape_xml(&description),
            amount_minor,
            // OFX does not carry a per-transaction running balance; the
            // statement-level closing balance surfaces separately as
            // `OfxStatement::ledger_balance_minor`.
            balance_minor: None,
            provider_txn_id: self.fitid.filter(|s| !s.is_empty()),
            // Filled in from CURDEF once the whole file is read (see below).
            currency: None,
        })
    }
}

fn parse_ofx(text: &str) -> IngestResult<OfxStatement> {
    let tokens = tokenize(text);
    if !tokens
        .iter()
        .any(|t| !t.closing && t.name.eq_ignore_ascii_case("OFX"))
    {
        return Err(IngestError::Parse(
            "not an OFX file: no <OFX> element found".into(),
        ));
    }

    let mut statement = OfxStatement::default();
    let mut in_ledgerbal = false;
    let mut current: Option<PartialTxn> = None;

    for tok in &tokens {
        let name = tok.name.to_ascii_uppercase();

        match name.as_str() {
            "STMTTRN" => {
                if tok.closing {
                    let txn = current.take().ok_or_else(|| {
                        IngestError::Parse("</STMTTRN> without a matching open tag".into())
                    })?;
                    statement.lines.push(txn.finish()?);
                } else {
                    if current.is_some() {
                        return Err(IngestError::Parse(
                            "<STMTTRN> opened again before the previous one closed".into(),
                        ));
                    }
                    current = Some(PartialTxn::default());
                }
                continue;
            }
            "LEDGERBAL" => {
                in_ledgerbal = !tok.closing;
                continue;
            }
            _ => {}
        }

        if tok.closing {
            continue;
        }

        if let Some(txn) = current.as_mut() {
            match name.as_str() {
                "DTPOSTED" => txn.dtposted = Some(tok.value.to_string()),
                "TRNAMT" => txn.trnamt = Some(tok.value.to_string()),
                "NAME" => txn.name = Some(tok.value.to_string()),
                "MEMO" => txn.memo = Some(tok.value.to_string()),
                "FITID" => txn.fitid = Some(tok.value.to_string()),
                _ => {}
            }
            continue;
        }

        match name.as_str() {
            "CURDEF" if statement.currency.is_none() && !tok.value.is_empty() => {
                statement.currency = Some(tok.value.to_ascii_uppercase());
            }
            "BALAMT" if in_ledgerbal && statement.ledger_balance_minor.is_none() => {
                statement.ledger_balance_minor =
                    Some(parse_ofx_amount_minor(tok.value).map_err(|e| {
                        IngestError::Parse(format!("LEDGERBAL BALAMT {:?}: {e}", tok.value))
                    })?);
            }
            "DTASOF" if in_ledgerbal && statement.ledger_balance_date.is_none() => {
                statement.ledger_balance_date = Some(parse_ofx_date(tok.value).map_err(|e| {
                    IngestError::Parse(format!("LEDGERBAL DTASOF {:?}: {e}", tok.value))
                })?);
            }
            _ => {}
        }
    }

    if current.is_some() {
        return Err(IngestError::Parse("<STMTTRN> was never closed".into()));
    }

    if let Some(currency) = &statement.currency {
        for line in &mut statement.lines {
            line.currency = Some(currency.clone());
        }
    }

    Ok(statement)
}

// ---------------------------------------------------------------------------
// Money and dates — no floats, refuse rather than guess
// ---------------------------------------------------------------------------

/// Parse an OFX `<TRNAMT>`/`<BALAMT>` value into minor units.
///
/// OFX amounts are plain decimal strings (`-1234.56`, `45`, `+10.5`) — never
/// floats, never thousands-grouped, and the sign is exactly what it says
/// (OFX debits already arrive negative; nothing here flips it). At most 2
/// fractional digits are accepted: anything longer cannot be represented
/// exactly in minor units without a silent rounding decision, so it is
/// refused rather than truncated.
fn parse_ofx_amount_minor(raw: &str) -> IngestResult<i64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(IngestError::Parse("empty amount".into()));
    }
    let (negative, rest) = match raw.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, raw.strip_prefix('+').unwrap_or(raw)),
    };
    if rest.is_empty() {
        return Err(IngestError::Parse(format!("{raw:?} has no digits")));
    }

    let mut parts = rest.splitn(2, '.');
    let major_raw = parts.next().unwrap_or("");
    let minor_raw = parts.next().unwrap_or("");
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(major_raw) || !all_digits(minor_raw) {
        return Err(IngestError::Parse(format!(
            "{raw:?} is not a plain decimal amount"
        )));
    }
    if major_raw.is_empty() && minor_raw.is_empty() {
        return Err(IngestError::Parse(format!("{raw:?} has no digits")));
    }
    if minor_raw.len() > 2 {
        return Err(IngestError::Parse(format!(
            "{raw:?} has more than 2 fractional digits; cannot represent exactly in minor units"
        )));
    }

    let overflow = || IngestError::Parse(format!("{raw:?} overflows i64"));
    let major: i64 = if major_raw.is_empty() {
        0
    } else {
        major_raw.parse().map_err(|_| overflow())?
    };
    let cents: i64 = match minor_raw.len() {
        0 => 0,
        1 => 10 * minor_raw.parse::<i64>().map_err(|_| overflow())?,
        2 => minor_raw.parse().map_err(|_| overflow())?,
        _ => unreachable!("checked above"),
    };
    let minor = major
        .checked_mul(100)
        .and_then(|m| m.checked_add(cents))
        .ok_or_else(overflow)?;
    Ok(if negative { -minor } else { minor })
}

/// Parse an OFX date (`<DTPOSTED>`, `<DTASOF>`) into `YYYY-MM-DD`.
///
/// OFX dates are `YYYYMMDD` or `YYYYMMDDHHMMSS[.XXX][gmt offset[:tz name]]`
/// (the bracketed timezone, e.g. `[-5:EST]`) — only the leading 8-digit date
/// is ever read; the time and any offset are ignored, matching the bank's
/// own stated posting date rather than shifting it across a day boundary for
/// a timezone this parser has no local reference point to resolve against.
fn parse_ofx_date(raw: &str) -> IngestResult<String> {
    let raw = raw.trim();
    let bad = || {
        IngestError::Parse(format!(
            "{raw:?} is not YYYYMMDD or YYYYMMDDHHMMSS[.XXX][TZ]"
        ))
    };
    if raw.len() < 8 || !raw.as_bytes()[..8].iter().all(u8::is_ascii_digit) {
        return Err(bad());
    }
    let year: i32 = raw[0..4].parse().map_err(|_| bad())?;
    let month: u32 = raw[4..6].parse().map_err(|_| bad())?;
    let day: u32 = raw[6..8].parse().map_err(|_| bad())?;
    if !(1900..=2200).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(IngestError::Parse(format!("{raw:?} is not a real date")));
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// Decode the handful of XML entities OFX 2.x (and occasionally OFX 1.x)
/// text carries. `&amp;` is decoded last so an already-escaped `&lt;` in the
/// source can never be unescaped twice into `<`.
fn unescape_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OFX 1.x fixture: SGML header block, unclosed leaf tags, exactly the
    /// shape a real FNB/Capitec-style export uses.
    fn ofx1_fixture() -> String {
        "OFXHEADER:100\r\n\
         DATA:OFXSGML\r\n\
         VERSION:102\r\n\
         SECURITY:NONE\r\n\
         ENCODING:USASCII\r\n\
         CHARSET:1252\r\n\
         COMPRESSION:NONE\r\n\
         OLDFILEUID:NONE\r\n\
         NEWFILEUID:NONE\r\n\
         \r\n\
         <OFX>\r\n\
         <SIGNONMSGSRSV1>\r\n\
         <SONRS>\r\n\
         <STATUS>\r\n\
         <CODE>0\r\n\
         <SEVERITY>INFO\r\n\
         </STATUS>\r\n\
         <DTSERVER>20260630120000\r\n\
         <LANGUAGE>ENG\r\n\
         </SONRS>\r\n\
         </SIGNONMSGSRSV1>\r\n\
         <BANKMSGSRSV1>\r\n\
         <STMTTRNRS>\r\n\
         <STMTRS>\r\n\
         <CURDEF>ZAR\r\n\
         <BANKACCTFROM>\r\n\
         <ACCTID>1234567890\r\n\
         </BANKACCTFROM>\r\n\
         <BANKTRANLIST>\r\n\
         <DTSTART>20260601\r\n\
         <DTEND>20260630\r\n\
         <STMTTRN>\r\n\
         <TRNTYPE>DEBIT\r\n\
         <DTPOSTED>20260602\r\n\
         <TRNAMT>-184.50\r\n\
         <FITID>202606020001\r\n\
         <NAME>CARD PURCHASE WOOLWORTHS\r\n\
         </STMTTRN>\r\n\
         <STMTTRN>\r\n\
         <TRNTYPE>CREDIT\r\n\
         <DTPOSTED>20260603\r\n\
         <TRNAMT>25000.00\r\n\
         <FITID>202606030001\r\n\
         <NAME>SALARY ACME PTY LTD\r\n\
         </STMTTRN>\r\n\
         </BANKTRANLIST>\r\n\
         <LEDGERBAL>\r\n\
         <BALAMT>35325.75\r\n\
         <DTASOF>20260630\r\n\
         </LEDGERBAL>\r\n\
         </STMTRS>\r\n\
         </STMTTRNRS>\r\n\
         </BANKMSGSRSV1>\r\n\
         </OFX>\r\n"
            .to_string()
    }

    /// OFX 2.x fixture: well-formed XML, every tag closed, an entity in a
    /// description and a timezone-suffixed `DTPOSTED`.
    fn ofx2_fixture() -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <DTSERVER>20260630120000</DTSERVER>
      <LANGUAGE>ENG</LANGUAGE>
    </SONRS>
  </SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM><ACCTID>555000111</ACCTID></BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260601000000</DTSTART>
          <DTEND>20260630000000</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260615103000[-5:EST]</DTPOSTED>
            <TRNAMT>-45.00</TRNAMT>
            <FITID>9001</FITID>
            <NAME>COFFEE &amp; BOOKS</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260616000000</DTPOSTED>
            <TRNAMT>1500.00</TRNAMT>
            <FITID>9002</FITID>
            <MEMO>PAYROLL DEPOSIT</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>2044.75</BALAMT>
          <DTASOF>20260630000000</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>
"#
        .to_string()
    }

    #[test]
    fn ofx1_parses_negative_and_positive_amounts_exactly() {
        let stmt = OfxStatementAdapter::new(OFX_BANK_ID, ofx1_fixture().into_bytes())
            .parse_statement()
            .unwrap();
        assert_eq!(stmt.lines.len(), 2);
        assert_eq!(stmt.currency.as_deref(), Some("ZAR"));

        assert_eq!(stmt.lines[0].posted_date, "2026-06-02");
        assert_eq!(stmt.lines[0].amount_minor, -18_450, "debit is negative");
        assert_eq!(stmt.lines[0].description, "CARD PURCHASE WOOLWORTHS");
        assert_eq!(
            stmt.lines[0].provider_txn_id.as_deref(),
            Some("202606020001")
        );
        assert_eq!(stmt.lines[0].currency.as_deref(), Some("ZAR"));
        assert_eq!(stmt.lines[0].balance_minor, None);

        assert_eq!(stmt.lines[1].posted_date, "2026-06-03");
        assert_eq!(stmt.lines[1].amount_minor, 2_500_000, "credit is positive");
        assert_eq!(stmt.lines[1].description, "SALARY ACME PTY LTD");

        assert_eq!(stmt.ledger_balance_minor, Some(3_532_575));
        assert_eq!(stmt.ledger_balance_date.as_deref(), Some("2026-06-30"));
    }

    #[test]
    fn ofx2_parses_entities_and_a_timezone_suffixed_date() {
        let stmt = OfxStatementAdapter::new(OFX_BANK_ID, ofx2_fixture().into_bytes())
            .parse_statement()
            .unwrap();
        assert_eq!(stmt.lines.len(), 2);
        assert_eq!(stmt.currency.as_deref(), Some("USD"));

        // The bracketed GMT offset is stripped; only the leading 8 digits of
        // DTPOSTED are read.
        assert_eq!(stmt.lines[0].posted_date, "2026-06-15");
        assert_eq!(stmt.lines[0].amount_minor, -4_500);
        assert_eq!(
            stmt.lines[0].description, "COFFEE & BOOKS",
            "&amp; entity decoded"
        );
        assert_eq!(stmt.lines[0].provider_txn_id.as_deref(), Some("9001"));

        // Second line has no NAME at all — MEMO is the missing-optional-field
        // case, and it must still parse rather than be skipped or error.
        assert_eq!(stmt.lines[1].posted_date, "2026-06-16");
        assert_eq!(stmt.lines[1].amount_minor, 150_000);
        assert_eq!(stmt.lines[1].description, "PAYROLL DEPOSIT");

        assert_eq!(stmt.ledger_balance_minor, Some(204_475));
        assert_eq!(stmt.ledger_balance_date.as_deref(), Some("2026-06-30"));
    }

    #[test]
    fn missing_name_and_memo_declines_rather_than_inventing_a_description() {
        let ofx = ofx1_fixture().replace("<NAME>CARD PURCHASE WOOLWORTHS\r\n", "");
        let err = OfxStatementAdapter::new(OFX_BANK_ID, ofx.into_bytes())
            .parse_statement()
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("NAME") && msg.contains("MEMO"), "{msg}");
    }

    #[test]
    fn missing_amount_declines_with_the_fitid_named() {
        let ofx = ofx1_fixture().replace("<TRNAMT>-184.50\r\n", "");
        let err = OfxStatementAdapter::new(OFX_BANK_ID, ofx.into_bytes())
            .parse_statement()
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("202606020001"), "{msg}");
        assert!(msg.contains("TRNAMT"), "{msg}");
    }

    #[test]
    fn missing_date_declines_clearly() {
        let ofx = ofx1_fixture().replace("<DTPOSTED>20260602\r\n", "");
        let err = OfxStatementAdapter::new(OFX_BANK_ID, ofx.into_bytes())
            .parse_statement()
            .unwrap_err();
        assert!(err.to_string().contains("DTPOSTED"), "{err}");
    }

    #[test]
    fn a_file_with_no_ofx_root_is_refused_outright() {
        let err = OfxStatementAdapter::new(OFX_BANK_ID, b"not,ofx,at,all\n1,2,3".to_vec())
            .parse_statement()
            .unwrap_err();
        assert!(err.to_string().contains("no <OFX> element"), "{err}");
    }

    #[test]
    fn an_unclosed_stmttrn_is_refused_not_silently_dropped() {
        let ofx = ofx1_fixture().replace("</STMTTRN>\r\n<STMTTRN>", "<STMTTRN>");
        let err = OfxStatementAdapter::new(OFX_BANK_ID, ofx.into_bytes())
            .parse_statement()
            .unwrap_err();
        assert!(err.to_string().contains("STMTTRN"), "{err}");
    }

    #[test]
    fn amounts_with_more_than_two_fractional_digits_are_refused_not_rounded() {
        assert!(parse_ofx_amount_minor("12.345").is_err());
        assert!(parse_ofx_amount_minor("-1234.5678").is_err());
    }

    #[test]
    fn amount_parsing_is_exact_and_never_a_float_round_trip() {
        assert_eq!(parse_ofx_amount_minor("-1234.56").unwrap(), -123_456);
        assert_eq!(parse_ofx_amount_minor("1234.56").unwrap(), 123_456);
        assert_eq!(parse_ofx_amount_minor("45").unwrap(), 4_500);
        assert_eq!(parse_ofx_amount_minor("+10.5").unwrap(), 1_050);
        assert_eq!(parse_ofx_amount_minor("0.07").unwrap(), 7);
        assert_eq!(parse_ofx_amount_minor("-0.01").unwrap(), -1);
        assert!(parse_ofx_amount_minor("").is_err());
        assert!(
            parse_ofx_amount_minor("R 184.50").is_err(),
            "OFX has no currency markers to strip"
        );
        assert!(
            parse_ofx_amount_minor("1,234.56").is_err(),
            "OFX never thousands-groups"
        );
    }

    #[test]
    fn date_parsing_accepts_bare_and_timestamped_forms() {
        assert_eq!(parse_ofx_date("20260615").unwrap(), "2026-06-15");
        assert_eq!(
            parse_ofx_date("20260615103000").unwrap(),
            "2026-06-15",
            "time-of-day dropped"
        );
        assert_eq!(
            parse_ofx_date("20260615103000.500[-5:EST]").unwrap(),
            "2026-06-15",
            "fractional seconds and TZ dropped"
        );
        assert!(parse_ofx_date("2026-06-15").is_err(), "dashes are not OFX");
        assert!(parse_ofx_date("20261332").is_err(), "month 13 is not real");
        assert!(parse_ofx_date("").is_err());
    }

    #[tokio::test]
    async fn fetch_lines_filters_by_date_range() {
        let mut adapter = OfxStatementAdapter::new(OFX_BANK_ID, ofx1_fixture().into_bytes());
        let range = DateRange::new("2026-06-03", "2026-06-30").unwrap();
        let lines = adapter.fetch_lines(&range).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].description, "SALARY ACME PTY LTD");
    }

    #[test]
    fn from_path_reads_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("statement.ofx");
        std::fs::write(&path, ofx2_fixture()).unwrap();
        let lines = OfxStatementAdapter::from_path(OFX_BANK_ID, &path)
            .unwrap()
            .parse_all()
            .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].amount_minor, -4_500);
    }
}
