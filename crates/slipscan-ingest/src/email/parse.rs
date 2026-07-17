//! MIME parsing: raw RFC 5322 bytes → [`InboundMessage`].
//!
//! Keeps only what the ingestion pipeline needs: PDF/image attachments and —
//! when the body looks like a receipt — the HTML body itself.

use super::{Attachment, InboundMessage};
use crate::{IngestError, IngestResult};
use mail_parser::{MessageParser, MimeHeaders};
use slipscan_core::util::now_iso;

/// Attachment extensions accepted from email (documents only).
const ATTACHMENT_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "webp", "heic", "gif", "tif", "tiff",
];

/// Parse a raw message. `fallback_id` (usually the IMAP UID) becomes the
/// connector-scoped id.
pub fn parse_inbound(raw: &[u8], fallback_id: &str) -> IngestResult<InboundMessage> {
    let msg = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| IngestError::Parse("unparseable MIME message".into()))?;

    let from = msg
        .from()
        .and_then(|a| a.first())
        .and_then(|a| a.address.as_deref())
        .unwrap_or("unknown")
        .to_string();
    let subject = msg.subject().map(str::to_string);
    let received_at = msg
        .date()
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(now_iso);

    let mut attachments = Vec::new();
    for part in msg.attachments() {
        let filename = part
            .attachment_name()
            .unwrap_or("attachment")
            .to_string();
        let mime_type = part
            .content_type()
            .map(|ct| match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub),
                None => ct.ctype().to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        if !is_document_attachment(&filename, &mime_type) {
            continue;
        }
        attachments.push(Attachment {
            filename,
            mime_type,
            bytes: part.contents().to_vec(),
        });
    }

    let receipt_html = msg.body_html(0).and_then(|html| {
        let text = strip_tags(&html);
        let subject_text = subject.as_deref().unwrap_or("");
        if looks_like_receipt(&format!("{subject_text}\n{text}")) {
            Some(html.into_owned())
        } else {
            None
        }
    });

    Ok(InboundMessage {
        id: fallback_id.to_string(),
        message_id: msg.message_id().map(str::to_string),
        from,
        subject,
        received_at,
        attachments,
        receipt_html,
    })
}

fn is_document_attachment(filename: &str, mime_type: &str) -> bool {
    if mime_type.eq_ignore_ascii_case("application/pdf")
        || mime_type.to_ascii_lowercase().starts_with("image/")
    {
        return true;
    }
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    ATTACHMENT_EXTENSIONS.contains(&ext.as_str())
}

/// Heuristic: does this text read like a receipt / invoice / order
/// confirmation? Word-boundary matching so e.g. CSS `border` never counts as
/// `order`. Requires at least two distinct signals plus a digit.
pub fn looks_like_receipt(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let joined = tokens.join(" ");

    const SIGNALS: &[&str] = &[
        "total",
        "subtotal",
        "vat",
        "receipt",
        "invoice",
        "order",
        "payment",
        "purchase",
        "amount due",
        "tax invoice",
        "paid",
        "till",
    ];
    let hits = SIGNALS
        .iter()
        .filter(|kw| {
            if kw.contains(' ') {
                joined.contains(*kw)
            } else {
                tokens.contains(kw)
            }
        })
        .count();
    let has_digit = lower.bytes().any(|b| b.is_ascii_digit());
    hits >= 2 && has_digit
}

/// Crude tag stripper — good enough for keyword heuristics, never rendered.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_style_or_script = false;
    let lower = html.to_ascii_lowercase();
    let mut idx = 0usize;
    for (i, ch) in html.char_indices() {
        if idx > i {
            continue;
        }
        match ch {
            '<' => {
                if lower[i..].starts_with("<style") || lower[i..].starts_with("<script") {
                    in_style_or_script = true;
                } else if lower[i..].starts_with("</style") || lower[i..].starts_with("</script") {
                    in_style_or_script = false;
                }
                in_tag = true;
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag && !in_style_or_script => out.push(c),
            _ => {}
        }
        idx = i + ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECEIPT_EMAIL: &str = "From: Till <till@shop.example>\r\n\
To: you@home.example\r\n\
Subject: Your slip from SPAR\r\n\
Message-ID: <abc123@shop.example>\r\n\
Date: Wed, 1 Jul 2026 10:00:00 +0200\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"XYZ\"\r\n\
\r\n\
--XYZ\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body><p>Thanks for your purchase. Total R 123.45 (VAT incl).</p></body></html>\r\n\
--XYZ\r\n\
Content-Type: application/pdf; name=\"slip.pdf\"\r\n\
Content-Disposition: attachment; filename=\"slip.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQgZmFrZQ==\r\n\
--XYZ--\r\n";

    const NEWSLETTER_EMAIL: &str = "From: news@shop.example\r\n\
To: you@home.example\r\n\
Subject: What's new this week\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body style=\"border: 1px solid\"><p>Fresh arrivals and 3 stories we love.</p></body></html>\r\n";

    #[test]
    fn parses_receipt_email_with_pdf_attachment_and_html_body() {
        let msg = parse_inbound(RECEIPT_EMAIL.as_bytes(), "42").unwrap();
        assert_eq!(msg.id, "42");
        assert_eq!(msg.message_id.as_deref(), Some("abc123@shop.example"));
        assert_eq!(msg.from, "till@shop.example");
        assert_eq!(msg.subject.as_deref(), Some("Your slip from SPAR"));
        assert!(msg.received_at.starts_with("2026-07-01T"), "{}", msg.received_at);

        assert_eq!(msg.attachments.len(), 1);
        let att = &msg.attachments[0];
        assert_eq!(att.filename, "slip.pdf");
        assert_eq!(att.mime_type, "application/pdf");
        assert_eq!(att.bytes, b"%PDF-1.4 fake");

        assert!(msg.receipt_html.is_some(), "html body should be kept");
    }

    #[test]
    fn newsletter_body_is_not_a_receipt() {
        let msg = parse_inbound(NEWSLETTER_EMAIL.as_bytes(), "43").unwrap();
        assert!(msg.attachments.is_empty());
        assert!(msg.receipt_html.is_none());
    }

    #[test]
    fn receipt_heuristic_needs_word_boundaries_and_digits() {
        assert!(looks_like_receipt("Tax invoice #123: total R99.00"));
        assert!(!looks_like_receipt("border-color totally fine, no numbers here"));
        // "order" inside "border" must not match.
        assert!(!looks_like_receipt("border: 1px; border: 2px"));
        // Two signals but no digits: not a receipt.
        assert!(!looks_like_receipt("invoice receipt"));
    }

    #[test]
    fn attachment_filter_accepts_images_rejects_calendar() {
        assert!(is_document_attachment("x.png", "image/png"));
        assert!(is_document_attachment("scan.PDF", "application/octet-stream"));
        assert!(!is_document_attachment("invite.ics", "text/calendar"));
    }

    #[test]
    fn unparseable_bytes_error() {
        assert!(matches!(
            parse_inbound(b"", "1"),
            Err(IngestError::Parse(_))
        ));
    }
}
