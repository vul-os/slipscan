//! Ollama provider — the default local, offline extraction path.
//!
//! Talks to a user-run Ollama instance (loopback by default). No API key,
//! no cloud egress: the endpoint is whatever the user configured, and the
//! default is `http://127.0.0.1:11434`. Handles images via the multimodal
//! `images` field and plain-text receipts (e.g. email bodies) by embedding
//! the text in the prompt.

use crate::prompt;
use crate::provider::{ExtractError, ExtractionProvider, ExtractionRequest, MIME_TEXT};
use crate::transport::{HttpRequest, Transport};
use crate::types::SlipExtraction;
use crate::wire;
use async_trait::async_trait;
use serde_json::json;
use std::sync::Arc;

pub const OLLAMA_DEFAULT_MODEL: &str = "llama3.2-vision";
pub const OLLAMA_DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone)]
pub struct OllamaConfig {
    pub model: String,
    pub base_url: String,
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            model: OLLAMA_DEFAULT_MODEL.into(),
            base_url: OLLAMA_DEFAULT_BASE_URL.into(),
        }
    }
}

pub struct OllamaProvider {
    config: OllamaConfig,
    transport: Arc<dyn Transport>,
}

impl OllamaProvider {
    pub fn new(config: OllamaConfig, transport: Arc<dyn Transport>) -> Self {
        Self { config, transport }
    }

    fn build_request(&self, request: &ExtractionRequest) -> HttpRequest {
        let prompt_text = prompt::slip_prompt(request.hint.as_deref());
        let message = if request.mime_type == MIME_TEXT {
            let receipt = String::from_utf8_lossy(&request.bytes);
            json!({
                "role": "user",
                "content": format!("{prompt_text}\n\nRECEIPT TEXT:\n{receipt}"),
            })
        } else {
            json!({
                "role": "user",
                "content": prompt_text,
                "images": [super::base64(&request.bytes)],
            })
        };
        HttpRequest {
            url: format!("{}/api/chat", self.config.base_url.trim_end_matches('/')),
            headers: vec![],
            body: json!({
                "model": self.config.model,
                "stream": false,
                "format": "json",
                "messages": [message],
            }),
        }
    }
}

fn response_text(body: &str) -> Result<String, ExtractError> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    if let Some(error) = value["error"].as_str() {
        return Err(ExtractError::Provider(format!("ollama error: {error}")));
    }
    let text = value["message"]["content"].as_str().unwrap_or_default();
    if text.trim().is_empty() {
        return Err(ExtractError::InvalidResponse(
            "ollama response contained no message content".into(),
        ));
    }
    Ok(text.to_string())
}

#[async_trait]
impl ExtractionProvider for OllamaProvider {
    fn name(&self) -> &str {
        "ollama"
    }

    async fn extract(&self, request: ExtractionRequest) -> Result<SlipExtraction, ExtractError> {
        if !request.is_supported_image() && request.mime_type != MIME_TEXT {
            return Err(ExtractError::Unsupported {
                mime_type: request.mime_type,
            });
        }
        let http = self.build_request(&request);
        let response = super::post_with_retry(self.transport.as_ref(), http, self.name()).await?;
        let text = response_text(&response.body)?;
        wire::parse_slip(&text, wire::DEFAULT_CURRENCY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{MIME_JPEG, MIME_PDF};
    use crate::transport::mock::MockTransport;

    fn provider(mock: Arc<MockTransport>) -> OllamaProvider {
        OllamaProvider::new(OllamaConfig::default(), mock)
    }

    fn canned_chat(slip_json: &str) -> String {
        json!({
            "model": OLLAMA_DEFAULT_MODEL,
            "done": true,
            "message": {"role": "assistant", "content": slip_json},
        })
        .to_string()
    }

    #[tokio::test]
    async fn extracts_from_a_canned_local_response() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(
            200,
            canned_chat(r#"{"merchant": {"name": "ENGEN"}, "currency": "ZAR", "total": 650.00}"#),
        );
        let slip = provider(mock.clone())
            .extract(ExtractionRequest::new(MIME_JPEG, vec![4, 2]))
            .await
            .unwrap();
        assert_eq!(slip.merchant.as_ref().unwrap().name, "ENGEN");
        assert_eq!(slip.totals.total_minor, 65_000);

        let req = &mock.requests()[0];
        assert_eq!(req.url, "http://127.0.0.1:11434/api/chat");
        assert!(
            req.headers.is_empty(),
            "local provider sends no credentials"
        );
        assert_eq!(req.body["format"], "json");
        assert_eq!(req.body["stream"], false);
        assert!(req.body["messages"][0]["images"][0].is_string());
    }

    #[tokio::test]
    async fn text_receipts_are_embedded_in_the_prompt() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, canned_chat(r#"{"total": 10.00}"#));
        provider(mock.clone())
            .extract(ExtractionRequest::new(
                MIME_TEXT,
                b"CAFE\nTOTAL R10.00".to_vec(),
            ))
            .await
            .unwrap();
        let content = mock.requests()[0].body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(content.contains("RECEIPT TEXT:"));
        assert!(content.contains("TOTAL R10.00"));
    }

    #[tokio::test]
    async fn pdf_is_unsupported() {
        let mock = Arc::new(MockTransport::new());
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_PDF, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Unsupported { .. }));
    }

    #[tokio::test]
    async fn ollama_error_field_is_a_provider_error() {
        let mock = Arc::new(MockTransport::new());
        mock.push_response(200, r#"{"error": "model not found"}"#);
        let err = provider(mock)
            .extract(ExtractionRequest::new(MIME_JPEG, vec![1]))
            .await
            .unwrap_err();
        assert!(matches!(err, ExtractError::Provider(m) if m.contains("model not found")));
    }
}
