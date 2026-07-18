//! Anthropic Messages API provider (BYO key, default cloud provider).
//!
//! Sends the slip image/PDF plus the slip-v2 prompt to `POST /v1/messages`
//! with structured output (`output_config.format`) requesting the slip-v2
//! JSON schema. The API key is fetched from the vault per request and only
//! ever placed in the `x-api-key` header.

use crate::keys::{self, SharedKeySource};
use crate::prompt;
use crate::provider::{ExtractError, ExtractionProvider, ExtractionRequest};
use crate::transport::{HttpRequest, Transport};
use crate::types::SlipExtraction;
use crate::wire;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

/// Default model for slip extraction.
pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-5";
/// Vault entry name the key is looked up under by default.
pub const ANTHROPIC_DEFAULT_KEY_NAME: &str = "anthropic_api_key";

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    /// Vault entry name holding the API key.
    pub key_name: String,
    pub model: String,
    pub base_url: String,
    /// Output budget; generous because adaptive thinking counts against it.
    pub max_tokens: u32,
}

impl Default for AnthropicConfig {
    fn default() -> Self {
        Self {
            key_name: ANTHROPIC_DEFAULT_KEY_NAME.into(),
            model: ANTHROPIC_DEFAULT_MODEL.into(),
            base_url: "https://api.anthropic.com".into(),
            max_tokens: 16_000,
        }
    }
}

pub struct AnthropicProvider {
    config: AnthropicConfig,
    transport: Arc<dyn Transport>,
    keys: SharedKeySource,
}

impl AnthropicProvider {
    pub fn new(
        config: AnthropicConfig,
        transport: Arc<dyn Transport>,
        keys: SharedKeySource,
    ) -> Self {
        Self {
            config,
            transport,
            keys,
        }
    }

    fn build_request(&self, request: &ExtractionRequest, key: &str) -> HttpRequest {
        let data = super::base64(&request.bytes);
        let source = json!({
            "type": "base64",
            "media_type": request.mime_type,
            "data": data,
        });
        let document_block = if request.is_pdf() {
            json!({"type": "document", "source": source})
        } else {
            json!({"type": "image", "source": source})
        };
        let body = json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "messages": [{
                "role": "user",
                "content": [
                    document_block,
                    {"type": "text", "text": prompt::slip_prompt(request.hint.as_deref())},
                ],
            }],
            "output_config": {
                "format": {"type": "json_schema", "schema": prompt::slip_schema()},
            },
        });
        HttpRequest {
            url: format!("{}/v1/messages", self.config.base_url.trim_end_matches('/')),
            headers: vec![
                ("x-api-key".into(), key.to_string()),
                ("anthropic-version".into(), ANTHROPIC_VERSION.into()),
            ],
            body,
        }
    }
}

/// Pull the concatenated text blocks out of a Messages API response.
fn response_text(body: &str) -> Result<String, ExtractError> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    let stop_reason = value["stop_reason"].as_str().unwrap_or_default();
    if stop_reason == "refusal" {
        return Err(ExtractError::Provider(
            "anthropic declined the request (stop_reason: refusal)".into(),
        ));
    }
    let mut text = String::new();
    if let Some(blocks) = value["content"].as_array() {
        for block in blocks {
            if block["type"] == "text" {
                text.push_str(block["text"].as_str().unwrap_or_default());
            }
        }
    }
    if text.trim().is_empty() {
        return Err(ExtractError::InvalidResponse(
            "anthropic response contained no text content".into(),
        ));
    }
    if stop_reason == "max_tokens" {
        return Err(ExtractError::Provider(
            "anthropic output was truncated (stop_reason: max_tokens); raise max_tokens".into(),
        ));
    }
    Ok(text)
}

#[async_trait]
impl ExtractionProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
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
        wire::parse_slip(&text, request.default_currency.as_deref().unwrap_or(""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::test::StaticKeys;
    use crate::provider::MIME_JPEG;
    use crate::transport::mock::MockTransport;

    fn provider(mock: Arc<MockTransport>) -> AnthropicProvider {
        let keys = StaticKeys::new().with("anthropic_api_key", "sk-ant-canned");
        AnthropicProvider::new(AnthropicConfig::default(), mock, Arc::new(keys))
    }

    fn canned_message(slip_json: &str, stop_reason: &str) -> String {
        json!({
            "id": "msg_01",
            "model": ANTHROPIC_DEFAULT_MODEL,
            "stop_reason": stop_reason,
            "content": [
                {"type": "thinking", "thinking": ""},
                {"type": "text", "text": slip_json},
            ],
        })
        .to_string()
    }

    const SLIP_JSON: &str = r#"{
        "merchant": {"name": "PICK N PAY", "branch": null, "address": null, "vat_number": null},
        "date": "2026-07-01", "time": null, "currency": "ZAR",
        "items": [{"description": "MILK 2L", "quantity": 1, "unit_price": 34.99, "total": 34.99,
                   "discount": null, "category": "groceries.dairy", "vat_rate_percent": 0}],
        "discounts": [], "vat_breakdown": [],
        "subtotal": null, "discount": null, "vat": null, "tip": null, "total": 34.99,
        "payment": null, "confidence": 0.95
    }"#;

    #[tokio::test]
    async fn extracts_a_slip_from_a_canned_response() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, canned_message(SLIP_JSON, "end_turn"));
        let provider = provider(mock.clone());

        let slip = provider
            .extract(ExtractionRequest::new(MIME_JPEG, vec![1, 2, 3]))
            .await
            .unwrap();
        assert_eq!(slip.merchant.as_ref().unwrap().name, "PICK N PAY");
        assert_eq!(slip.totals.total_minor, 3_499);
        assert_eq!(slip.currency.as_deref(), Some("ZAR"));
        assert!(slip.validation.unwrap().sum_matches);

        // Exactly one request; key travels in the header, never the URL.
        let requests = mock.requests();
        assert_eq!(requests.len(), 1);
        let req = &requests[0];
        assert_eq!(req.url, "https://api.anthropic.com/v1/messages");
        assert!(!req.url.contains("sk-ant-canned"));
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "x-api-key" && v == "sk-ant-canned"));
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "anthropic-version" && v == ANTHROPIC_VERSION));
        assert_eq!(req.body["model"], ANTHROPIC_DEFAULT_MODEL);
        assert_eq!(req.body["output_config"]["format"]["type"], "json_schema");
    }

    #[tokio::test]
    async fn missing_key_is_not_configured_and_makes_no_request() {
        let mock = Arc::new(MockTransport::new());
        let provider = AnthropicProvider::new(
            AnthropicConfig::default(),
            mock.clone(),
            Arc::new(StaticKeys::new()),
        );
        let err = provider
            .extract(ExtractionRequest::new(MIME_JPEG, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::NotConfigured(_)));
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn auth_failure_maps_to_auth_error() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(401, r#"{"error": {"type": "authentication_error"}}"#);
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_JPEG, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Auth(_)));
        assert!(!err.to_string().contains("sk-ant-canned"));
    }

    #[tokio::test]
    async fn refusal_is_a_provider_error() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, canned_message("", "refusal"));
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_JPEG, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Provider(m) if m.contains("refusal")));
    }

    #[tokio::test]
    async fn unsupported_mime_is_rejected_before_any_request() {
        let mock = Arc::new(MockTransport::new());
        let err = provider(mock.clone())
            .extract(ExtractionRequest::new("application/zip", vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Unsupported { .. }));
        assert!(mock.requests().is_empty());
    }

    #[tokio::test]
    async fn pdf_uses_a_document_block() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, canned_message(SLIP_JSON, "end_turn"));
        provider(mock.clone())
            .extract(ExtractionRequest::new(crate::provider::MIME_PDF, vec![1]))
            .await
            .unwrap();
        let body = &mock.requests()[0].body;
        assert_eq!(body["messages"][0]["content"][0]["type"], "document");
    }
}
