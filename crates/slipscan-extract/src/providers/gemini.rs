//! Google Gemini provider (BYO key).
//!
//! Uses `generateContent` with inline base64 data (images and PDFs) and a
//! JSON response MIME type. The key is sent in the `x-goog-api-key` header —
//! deliberately **not** as a `?key=` query parameter, so it can never end up
//! in URLs, proxies, or logs.

use crate::keys::{self, SharedKeySource};
use crate::prompt;
use crate::provider::{ExtractError, ExtractionProvider, ExtractionRequest};
use crate::transport::{HttpRequest, Transport};
use crate::types::SlipExtraction;
use crate::wire;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

pub const GEMINI_DEFAULT_MODEL: &str = "gemini-2.5-flash";
pub const GEMINI_DEFAULT_KEY_NAME: &str = "gemini_api_key";

#[derive(Debug, Clone)]
pub struct GeminiConfig {
    /// Vault entry name holding the API key.
    pub key_name: String,
    pub model: String,
    pub base_url: String,
}

impl Default for GeminiConfig {
    fn default() -> Self {
        Self {
            key_name: GEMINI_DEFAULT_KEY_NAME.into(),
            model: GEMINI_DEFAULT_MODEL.into(),
            base_url: "https://generativelanguage.googleapis.com".into(),
        }
    }
}

pub struct GeminiProvider {
    config: GeminiConfig,
    transport: Arc<dyn Transport>,
    keys: SharedKeySource,
}

impl GeminiProvider {
    pub fn new(config: GeminiConfig, transport: Arc<dyn Transport>, keys: SharedKeySource) -> Self {
        Self {
            config,
            transport,
            keys,
        }
    }

    fn build_request(&self, request: &ExtractionRequest, key: &str) -> HttpRequest {
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [
                    {"inlineData": {
                        "mimeType": request.mime_type,
                        "data": super::base64(&request.bytes),
                    }},
                    {"text": prompt::slip_prompt(request.hint.as_deref())},
                ],
            }],
            "generationConfig": {"responseMimeType": "application/json"},
        });
        HttpRequest {
            url: format!(
                "{}/v1beta/models/{}:generateContent",
                self.config.base_url.trim_end_matches('/'),
                self.config.model
            ),
            headers: vec![("x-goog-api-key".into(), key.to_string())],
            body,
        }
    }
}

fn response_text(body: &str) -> Result<String, ExtractError> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    if let Some(reason) = value["promptFeedback"]["blockReason"].as_str() {
        return Err(ExtractError::Provider(format!(
            "gemini blocked the request: {reason}"
        )));
    }
    let mut text = String::new();
    if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
        for part in parts {
            text.push_str(part["text"].as_str().unwrap_or_default());
        }
    }
    if text.trim().is_empty() {
        return Err(ExtractError::InvalidResponse(
            "gemini response contained no candidate text".into(),
        ));
    }
    Ok(text)
}

#[async_trait]
impl ExtractionProvider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    async fn extract(&self, request: ExtractionRequest) -> Result<SlipExtraction, ExtractError> {
        if !request.is_supported_image() && !request.is_pdf() {
            return Err(ExtractError::Unsupported {
                mime_type: request.mime_type,
            });
        }
        let http = keys::use_api_key(self.keys.as_ref(), &self.config.key_name, |key| {
            self.build_request(&request, key)
        })?;
        let response = super::post_with_retry(self.transport.as_ref(), http, self.name()).await?;
        let text = response_text(&response.body)?;
        wire::parse_slip(&text, wire::DEFAULT_CURRENCY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test::StaticKeys;
    use crate::provider::MIME_JPEG;
    use crate::transport::mock::MockTransport;

    fn provider(mock: Arc<MockTransport>) -> GeminiProvider {
        let keys = StaticKeys::new().with("gemini_api_key", "AIza-canned");
        GeminiProvider::new(GeminiConfig::default(), mock, Arc::new(keys))
    }

    fn canned_candidates(slip_json: &str) -> String {
        json!({
            "candidates": [{
                "content": {"role": "model", "parts": [{"text": slip_json}]},
                "finishReason": "STOP",
            }],
        })
        .to_string()
    }

    #[tokio::test]
    async fn extracts_from_a_canned_candidate() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(
            200,
            canned_candidates(
                r#"{"merchant": {"name": "WOOLWORTHS"}, "currency": "ZAR", "total": 88.00}"#,
            ),
        );
        let slip = provider(mock.clone())
            .extract(ExtractionRequest::new(MIME_JPEG, vec![7]))
            .await
            .unwrap();
        assert_eq!(slip.merchant.as_ref().unwrap().name, "WOOLWORTHS");
        assert_eq!(slip.totals.total_minor, 8_800);

        // Key must be in the header, never in the URL.
        let req = &mock.requests()[0];
        assert_eq!(
            req.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert!(!req.url.contains("AIza-canned"));
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "x-goog-api-key" && v == "AIza-canned"));
        assert_eq!(
            req.body["generationConfig"]["responseMimeType"],
            "application/json"
        );
    }

    #[tokio::test]
    async fn blocked_prompt_is_a_provider_error() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, r#"{"promptFeedback": {"blockReason": "SAFETY"}}"#);
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_JPEG, vec![7]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Provider(m) if m.contains("SAFETY")));
    }
}
