//! Tiny hex encode/decode helpers (avoids a dependency for two functions).

pub(crate) fn encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Decode a lowercase/uppercase hex string. Returns `None` on odd length or
/// non-hex characters.
pub(crate) fn decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let data = [0x00, 0x0f, 0xff, 0xa5];
        let encoded = encode(&data);
        assert_eq!(encoded, "000fffa5");
        assert_eq!(decode(&encoded).unwrap(), data);
        assert_eq!(decode("A5").unwrap(), vec![0xa5]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(decode("abc").is_none());
        assert!(decode("zz").is_none());
    }
}
