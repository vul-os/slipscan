//! Strict JSON parsing with a repair pass.
//!
//! LLMs occasionally wrap JSON in markdown fences, prepend commentary, or
//! leave trailing commas. We parse strictly first, then apply conservative
//! repairs; anything still unparseable is an [`ExtractError::InvalidResponse`].

use crate::provider::ExtractError;

/// Parse model output as a JSON object, tolerating fences/commentary and
/// trailing commas.
pub fn parse_lenient(text: &str) -> Result<serde_json::Value, ExtractError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(ExtractError::InvalidResponse(
            "model returned empty output".into(),
        ));
    }

    // 1. Strict parse of the whole payload.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return ensure_object(value);
    }

    // 2. Repair pass: extract the first balanced JSON object, then strip
    //    trailing commas.
    let candidate = extract_object(trimmed).ok_or_else(|| {
        ExtractError::InvalidResponse(format!(
            "no JSON object found in model output (first 80 chars: {:?})",
            truncate(trimmed, 80)
        ))
    })?;

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
        return ensure_object(value);
    }

    let repaired = strip_trailing_commas(candidate);
    match serde_json::from_str::<serde_json::Value>(&repaired) {
        Ok(value) => ensure_object(value),
        Err(e) => Err(ExtractError::InvalidResponse(format!(
            "model output is not valid JSON after repair: {e}"
        ))),
    }
}

fn ensure_object(value: serde_json::Value) -> Result<serde_json::Value, ExtractError> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(ExtractError::InvalidResponse(
            "model output is valid JSON but not an object".into(),
        ))
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Return the first balanced `{ ... }` slice, respecting strings and escapes.
fn extract_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Remove commas that directly precede a closing `}` or `]` (outside strings).
fn strip_trailing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut escaped = false;

    for &b in bytes {
        if in_string {
            out.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => {
                in_string = true;
                out.push(b);
            }
            b'}' | b']' => {
                // Drop a trailing comma (and whitespace) before the closer.
                let mut end = out.len();
                while end > 0 && (out[end - 1] as char).is_ascii_whitespace() {
                    end -= 1;
                }
                if end > 0 && out[end - 1] == b',' {
                    out.truncate(end - 1);
                }
                out.push(b);
            }
            _ => out.push(b),
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_json_parses() {
        let v = parse_lenient(r#"{"a": 1}"#).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn fenced_json_parses() {
        let v = parse_lenient("Here you go:\n```json\n{\"a\": 1}\n```\nDone.").unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn trailing_commas_are_repaired() {
        let v = parse_lenient("{\"a\": [1, 2,], \"b\": {\"c\": 3,},}").unwrap();
        assert_eq!(v["a"][1], 2);
        assert_eq!(v["b"]["c"], 3);
    }

    #[test]
    fn braces_inside_strings_are_ignored() {
        let v = parse_lenient("noise {\"a\": \"curly } brace, and a \\\" quote\"} trailer")
            .unwrap();
        assert_eq!(v["a"], "curly } brace, and a \" quote");
    }

    #[test]
    fn garbage_is_invalid_response() {
        let err = parse_lenient("I could not read the receipt.").unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }

    #[test]
    fn non_object_json_is_rejected() {
        let err = parse_lenient("[1, 2, 3]").unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }

    #[test]
    fn empty_output_is_rejected() {
        let err = parse_lenient("   ").unwrap_err();
        assert!(matches!(err, ExtractError::InvalidResponse(_)));
    }
}
