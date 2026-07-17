//! OpenAI-compatible chat-completions provider (BYO key).
//!
//! Works against any server exposing the `/chat/completions` shape (OpenAI,
//! vLLM, LM Studio, llama.cpp server, Groq, …) — the user points `base_url`
//! at their endpoint. Images travel as `data:` URLs; PDFs are not supported
//! on this surface. The key rides only in the `Authorization` header.

use crate::keys::{self, SharedKeySource};
use crate::prompt;
use crate::provider::{ExtractError, ExtractionProvider, ExtractionRequest};
use crate::transport::{HttpRequest, Transport};
use crate::types::SlipExtraction;
use crate::wire;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

pub const OPENAI_DEFAULT_MODEL: &str = "gpt-4o-mini";
pub const OPENAI_DEFAULT_KEY_NAME: &str = "openai_api_key";

#[derive(Debug, Clone)]
pub struct OpenAiCompatConfig {
    /// Vault entry name holding the API key.
    pub key_name: String,
    pub model: String,
    /// API root including any version prefix, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    pub max_tokens: u32,
}

impl Default for OpenAiCompatConfig {
    fn default() -> Self {
        Self {
            key_name: OPENAI_DEFAULT_KEY_NAME.into(),
            model: OPENAI_DEFAULT_MODEL.into(),
            base_url: "https://api.openai.com/v1".into(),
            max_tokens: 4_096,
        }
    }
}

pub struct OpenAiCompatProvider {
    config: OpenAiCompatConfig,
    transport: Arc<dyn Transport>,
    keys: SharedKeySource,
}

impl OpenAiCompatProvider {
    pub fn new(
        config: OpenAiCompatConfig,
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
        let body = json!({
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt::slip_prompt(request.hint.as_deref())},
                    {"type": "image_url", "image_url": {
                        "url": super::data_url(&request.mime_type, &request.bytes),
                    }},
                ],
            }],
        });
        HttpRequest {
            url: format!(
                "{}/chat/completions",
                self.config.base_url.trim_end_matches('/')
            ),
            headers: vec![("authorization".into(), format!("Bearer {key}"))],
            body,
        }
    }
}

fn response_text(body: &str) -> Result<String, ExtractError> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    if let Some(message) = value["error"]["message"].as_str() {
        return Err(ExtractError::Provider(format!(
            "openai-compatible server error: {message}"
        )));
    }
    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(ExtractError::InvalidResponse(
            "openai-compatible response contained no message content".into(),
        ));
    }
    Ok(text.to_string())
}

#[async_trait]
impl ExtractionProvider for OpenAiCompatProvider {
    fn name(&self) -> &str {
        "openai"
    }

    async fn extract(&self, request: ExtractionRequest) -> Result<SlipExtraction, ExtractError> {
        if !request.is_supported_image() {
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
    use crate::provider::{MIME_PDF, MIME_PNG};
    use crate::transport::mock::MockTransport;

    fn provider(mock: Arc<MockTransport>) -> OpenAiCompatProvider {
        let keys = StaticKeys::new().with("openai_api_key", "sk-oa-canned");
        OpenAiCompatProvider::new(OpenAiCompatConfig::default(), mock, Arc::new(keys))
    }

    fn canned_completion(slip_json: &str) -> String {
        json!({
            "id": "chatcmpl-1",
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": slip_json},
            }],
        })
        .to_string()
    }

    #[tokio::test]
    async fn extracts_from_a_canned_chat_completion() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(
            200,
            canned_completion(
                r#"{"merchant": {"name": "SPAR"}, "currency": "ZAR", "total": 120.50}"#,
            ),
        );
        let slip = provider(mock.clone())
            .extract(ExtractionRequest::new(MIME_PNG, vec![9, 9]))
            .await
            .unwrap();
        assert_eq!(slip.merchant.as_ref().unwrap().name, "SPAR");
        assert_eq!(slip.totals.total_minor, 12_050);

        let req = &mock.requests()[0];
        assert_eq!(req.url, "https://api.openai.com/v1/chat/completions");
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "authorization" && v == "Bearer sk-oa-canned"));
        assert_eq!(req.body["response_format"]["type"], "json_object");
        let image_url = req.body["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(image_url.starts_with("data:image/png;base64,"));
    }

    #[tokio::test]
    async fn server_error_object_is_a_provider_error() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(
            200,
            r#"{"error": {"message": "model overloaded", "type": "server_error"}}"#,
        );
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_PNG, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Provider(m) if m.contains("model overloaded")));
    }

    #[tokio::test]
    async fn pdf_is_unsupported() {
        let mock = Arc::new(MockTransport::new());
        let err = provider(mock.clone())
            .extract(ExtractionRequest::new(MIME_PDF, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Unsupported { .. }));
        assert!(mock.requests().is_empty());
    }
}
