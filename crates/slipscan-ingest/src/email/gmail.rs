//! Gmail connector: `history.list` delta sync + optional Cloud Pub/Sub
//! *pull* push. BYO Google OAuth client (loopback flow) — SlipScan operates
//! no OAuth client, relay, or webhook receiver of its own.
//!
//! Sync model: the durable cursor is a Gmail `historyId`. The first sync
//! baselines from the user's profile (mail from before the connection is
//! imported via file import if wanted); after that each round asks only for
//! `messagesAdded` since the cursor. Messages are fetched in RFC 5322 `raw`
//! form and go through the same MIME parser as IMAP mail, so every provider
//! normalises identically.
//!
//! Push needs no public endpoint: `users.watch` makes Gmail publish change
//! events into a Pub/Sub topic **in the user's own Google Cloud project**,
//! and SlipScan long-polls the *pull* subscription over an outbound
//! connection (docs/EMAIL.md).

use super::oauth::{ensure_access, OAuthClientConfig, TokenSet};
use super::{parse_inbound, InboundMessage, MailboxConnector, MailboxEvent};
use crate::http::{HttpClient, HttpRequest};
use crate::state::CursorStore;
use crate::vault::VaultAccess;
use crate::{b64, IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;

const GMAIL_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_BASE: &str = "https://pubsub.googleapis.com/v1";
const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";

/// Configuration for one Gmail mailbox. No secret material — vault entry
/// names only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GmailConfig {
    /// The user's own OAuth client id (Desktop-app type).
    pub client_id: String,
    /// Vault entry holding the OAuth client secret.
    pub client_secret_ref: String,
    /// Vault entry holding the [`TokenSet`] JSON.
    pub token_ref: String,
    /// Only messages carrying this label are ingested (e.g. a Gmail filter
    /// labels receipts `slipscan`). `None` = whole mailbox.
    pub label_id: Option<String>,
    /// Pub/Sub topic for `users.watch` renewal, e.g.
    /// `projects/<project>/topics/slipscan-mail`.
    pub pubsub_topic: Option<String>,
    /// Pull subscription on that topic, e.g.
    /// `projects/<project>/subscriptions/slipscan-mail-pull`.
    pub pubsub_subscription: Option<String>,
}

impl GmailConfig {
    pub fn cursor_key(&self) -> String {
        format!("gmail:{}", self.token_ref)
    }

    fn watch_cursor_key(&self) -> String {
        format!("{}:watch_expiry_ms", self.cursor_key())
    }

    /// The OAuth client config for this mailbox (loopback flow + refresh).
    pub fn oauth(&self) -> OAuthClientConfig {
        let mut scopes = vec!["https://www.googleapis.com/auth/gmail.readonly".to_string()];
        if self.pubsub_subscription.is_some() {
            scopes.push("https://www.googleapis.com/auth/pubsub".to_string());
        }
        OAuthClientConfig {
            auth_endpoint: GOOGLE_AUTH.into(),
            token_endpoint: GOOGLE_TOKEN.into(),
            client_id: self.client_id.clone(),
            client_secret_ref: Some(self.client_secret_ref.clone()),
            token_ref: self.token_ref.clone(),
            scopes,
            extra_auth_params: vec![
                // Google only issues a refresh token with these.
                ("access_type".into(), "offline".into()),
                ("prompt".into(), "consent".into()),
            ],
        }
    }
}

/// [`MailboxConnector`] over the Gmail API.
pub struct GmailConnector<'v, H: HttpClient, C: CursorStore> {
    config: GmailConfig,
    http: H,
    cursors: C,
    vault: &'v dyn VaultAccess,
    token_cache: Option<TokenSet>,
    /// Ids listed but not yet acked; the cursor advances only when the
    /// whole batch is processed, so a crash refetches (dedup absorbs it).
    pending: HashSet<String>,
    next_cursor: Option<String>,
}

impl<'v, H: HttpClient, C: CursorStore> GmailConnector<'v, H, C> {
    pub fn new(config: GmailConfig, http: H, cursors: C, vault: &'v dyn VaultAccess) -> Self {
        Self {
            config,
            http,
            cursors,
            vault,
            token_cache: None,
            pending: HashSet::new(),
            next_cursor: None,
        }
    }

    async fn access_token(&mut self) -> IngestResult<slipscan_core::secrets::SecretString> {
        ensure_access(
            &self.http,
            self.vault,
            &self.config.oauth(),
            &mut self.token_cache,
        )
        .await
    }

    async fn get_json(&mut self, url: &str) -> IngestResult<(u16, serde_json::Value)> {
        let access = self.access_token().await?;
        let response = self
            .http
            .send(HttpRequest::get(url).bearer(access.expose_secret()))
            .await?;
        let value = if response.body.is_empty() {
            serde_json::Value::Null
        } else {
            response.json()?
        };
        Ok((response.status, value))
    }

    async fn post_json(
        &mut self,
        url: &str,
        body: &serde_json::Value,
    ) -> IngestResult<(u16, serde_json::Value)> {
        let access = self.access_token().await?;
        let response = self
            .http
            .send(HttpRequest::post_json(url, body).bearer(access.expose_secret()))
            .await?;
        let value = if response.body.is_empty() {
            serde_json::Value::Null
        } else {
            response.json()?
        };
        Ok((response.status, value))
    }

    /// Baseline: adopt the mailbox's current `historyId` as the cursor.
    async fn baseline(&mut self) -> IngestResult<()> {
        let (status, value) = self.get_json(&format!("{GMAIL_BASE}/profile")).await?;
        if !(200..300).contains(&status) {
            return Err(IngestError::Http(format!("gmail profile: HTTP {status}")));
        }
        let history_id = json_id(&value, "historyId")
            .ok_or_else(|| IngestError::Parse("profile missing historyId".into()))?;
        self.cursors
            .set_cursor(&self.config.cursor_key(), &history_id)?;
        Ok(())
    }

    /// Re-issue `users.watch` when none is active or it is close to its
    /// 7-day expiry. No-op unless a Pub/Sub topic is configured.
    pub async fn ensure_watch(&mut self) -> IngestResult<()> {
        let Some(topic) = self.config.pubsub_topic.clone() else {
            return Ok(());
        };
        let now_ms = super::oauth::now_unix() * 1000;
        if let Some(raw) = self.cursors.get_cursor(&self.config.watch_cursor_key())? {
            if raw
                .parse::<i64>()
                .is_ok_and(|exp| exp - 86_400_000 > now_ms)
            {
                return Ok(()); // watch valid for at least another day
            }
        }
        let mut body = serde_json::json!({ "topicName": topic });
        if let Some(label) = &self.config.label_id {
            body["labelIds"] = serde_json::json!([label]);
        }
        let (status, value) = self
            .post_json(&format!("{GMAIL_BASE}/watch"), &body)
            .await?;
        if !(200..300).contains(&status) {
            return Err(IngestError::Http(format!("gmail watch: HTTP {status}")));
        }
        if let Some(expiration) = json_id(&value, "expiration") {
            self.cursors
                .set_cursor(&self.config.watch_cursor_key(), &expiration)?;
        }
        Ok(())
    }
}

/// Gmail encodes large ints as JSON strings; accept both.
fn json_id(value: &serde_json::Value, field: &str) -> Option<String> {
    match value.get(field)? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[async_trait(?Send)]
impl<H: HttpClient, C: CursorStore> MailboxConnector for GmailConnector<'_, H, C> {
    fn name(&self) -> &str {
        "gmail"
    }

    async fn list_new(&mut self) -> IngestResult<Vec<String>> {
        let Some(start) = self.cursors.get_cursor(&self.config.cursor_key())? else {
            // First sync: adopt "now" as the baseline and report nothing.
            self.baseline().await?;
            return Ok(Vec::new());
        };

        let mut ids: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut latest = start.clone();
        let mut page_token: Option<String> = None;
        loop {
            let mut url =
                format!("{GMAIL_BASE}/history?startHistoryId={start}&historyTypes=messageAdded");
            if let Some(label) = &self.config.label_id {
                url.push_str(&format!("&labelId={label}"));
            }
            if let Some(token) = &page_token {
                url.push_str(&format!("&pageToken={token}"));
            }
            let (status, value) = self.get_json(&url).await?;
            if status == 404 {
                // historyId too old — Gmail forgot it. Re-baseline; anything
                // missed is recoverable via manual import.
                self.baseline().await?;
                return Ok(Vec::new());
            }
            if !(200..300).contains(&status) {
                return Err(IngestError::Http(format!("gmail history: HTTP {status}")));
            }
            if let Some(history_id) = json_id(&value, "historyId") {
                latest = history_id;
            }
            for entry in value
                .get("history")
                .and_then(|h| h.as_array())
                .into_iter()
                .flatten()
            {
                for added in entry
                    .get("messagesAdded")
                    .and_then(|m| m.as_array())
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = added
                        .get("message")
                        .and_then(|m| m.get("id"))
                        .and_then(|i| i.as_str())
                    {
                        if seen.insert(id.to_string()) {
                            ids.push(id.to_string());
                        }
                    }
                }
            }
            page_token = value
                .get("nextPageToken")
                .and_then(|t| t.as_str())
                .map(str::to_string);
            if page_token.is_none() {
                break;
            }
        }
        self.pending = seen;
        self.next_cursor = Some(latest);
        Ok(ids)
    }

    async fn fetch_message(&mut self, message_id: &str) -> IngestResult<Option<InboundMessage>> {
        let url = format!("{GMAIL_BASE}/messages/{message_id}?format=raw");
        let (status, value) = self.get_json(&url).await?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(IngestError::Http(format!("gmail message: HTTP {status}")));
        }
        let raw_b64 = value
            .get("raw")
            .and_then(|r| r.as_str())
            .ok_or_else(|| IngestError::Parse("gmail message missing raw".into()))?;
        let raw = b64::decode_any(raw_b64)
            .map_err(|e| IngestError::Parse(format!("gmail raw payload: {e}")))?;
        parse_inbound(&raw, message_id).map(Some)
    }

    async fn mark_processed(&mut self, message_id: &str) -> IngestResult<()> {
        self.pending.remove(message_id);
        if self.pending.is_empty() {
            if let Some(cursor) = self.next_cursor.take() {
                self.cursors
                    .set_cursor(&self.config.cursor_key(), &cursor)?;
            }
        }
        Ok(())
    }

    /// Push via the user's own Pub/Sub pull subscription: one long-poll
    /// `pull`, ack whatever arrived, and report whether mail changed.
    async fn wait_for_new(&mut self, _timeout: Duration) -> IngestResult<MailboxEvent> {
        let Some(subscription) = self.config.pubsub_subscription.clone() else {
            return Ok(MailboxEvent::Unsupported);
        };
        self.ensure_watch().await?;

        let pull_url = format!("{PUBSUB_BASE}/{subscription}:pull");
        let (status, value) = self
            .post_json(&pull_url, &serde_json::json!({ "maxMessages": 100 }))
            .await?;
        if !(200..300).contains(&status) {
            return Err(IngestError::Http(format!("pubsub pull: HTTP {status}")));
        }
        let ack_ids: Vec<String> = value
            .get("receivedMessages")
            .and_then(|m| m.as_array())
            .into_iter()
            .flatten()
            .filter_map(|m| m.get("ackId").and_then(|a| a.as_str()))
            .map(str::to_string)
            .collect();
        if ack_ids.is_empty() {
            return Ok(MailboxEvent::Timeout);
        }
        let ack_url = format!("{PUBSUB_BASE}/{subscription}:acknowledge");
        let (status, _) = self
            .post_json(&ack_url, &serde_json::json!({ "ackIds": ack_ids }))
            .await?;
        if !(200..300).contains(&status) {
            return Err(IngestError::Http(format!(
                "pubsub acknowledge: HTTP {status}"
            )));
        }
        Ok(MailboxEvent::NewMail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::testutil::FakeHttpClient;
    use crate::state::MemoryCursorStore;
    use crate::vault::MemoryVault;

    fn config() -> GmailConfig {
        GmailConfig {
            client_id: "client-1".into(),
            client_secret_ref: "gmail.client_secret".into(),
            token_ref: "gmail.tokens".into(),
            label_id: Some("Label_7".into()),
            pubsub_topic: None,
            pubsub_subscription: None,
        }
    }

    fn vault_with_tokens() -> MemoryVault {
        let vault = MemoryVault::new().with("gmail.client_secret", "cs");
        super::super::oauth::save_tokens(
            &vault,
            "gmail.tokens",
            &TokenSet {
                access_token: "at".into(),
                refresh_token: Some("rt".into()),
                expires_at_unix: super::super::oauth::now_unix() + 3600,
            },
        )
        .unwrap();
        vault
    }

    fn raw_email_b64() -> String {
        let raw = "From: till@shop.example\r\nSubject: Gmail slip\r\nMIME-Version: 1.0\r\n\
Content-Type: text/plain\r\n\r\nbody\r\n";
        crate::b64::encode_url_nopad(raw.as_bytes())
    }

    #[tokio::test]
    async fn first_sync_baselines_from_profile() {
        let vault = vault_with_tokens();
        let http = FakeHttpClient::new().route("/profile", 200, r#"{"historyId":"1000"}"#);
        let mut store = MemoryCursorStore::new();
        let mut conn = GmailConnector::new(config(), http, &mut store, &vault);
        assert!(conn.list_new().await.unwrap().is_empty());
        assert_eq!(
            store.get_cursor("gmail:gmail.tokens").unwrap().as_deref(),
            Some("1000")
        );
    }

    #[tokio::test]
    async fn delta_sync_lists_fetches_and_advances_cursor_after_full_ack() {
        let vault = vault_with_tokens();
        let mut store = MemoryCursorStore::new();
        store.set_cursor("gmail:gmail.tokens", "1000").unwrap();

        let http = FakeHttpClient::new()
            .route(
                "pageToken=p2",
                200,
                r#"{"historyId":"1200","history":[{"messagesAdded":[{"message":{"id":"m2"}}]}]}"#,
            )
            .route(
                "/history",
                200,
                r#"{"historyId":"1100","history":[{"messagesAdded":[{"message":{"id":"m1"}},{"message":{"id":"m1"}}]}],"nextPageToken":"p2"}"#,
            )
            .route("/messages/m1", 200, &format!(r#"{{"raw":"{}"}}"#, raw_email_b64()))
            .route("/messages/m2", 200, &format!(r#"{{"raw":"{}"}}"#, raw_email_b64()));
        let mut conn = GmailConnector::new(config(), http, &mut store, &vault);

        let ids = conn.list_new().await.unwrap();
        assert_eq!(ids, vec!["m1", "m2"], "paged + deduped");
        let sent = conn.http.sent_urls();
        assert!(
            sent.iter().any(|u| u.contains("startHistoryId=1000")
                && u.contains("labelId=Label_7")
                && u.contains("historyTypes=messageAdded")),
            "{sent:?}"
        );

        let msg = conn.fetch_message("m1").await.unwrap().unwrap();
        assert_eq!(msg.subject.as_deref(), Some("Gmail slip"));
        assert_eq!(msg.from, "till@shop.example");

        // Cursor moves only after the whole batch is acked.
        conn.mark_processed("m1").await.unwrap();
        assert_eq!(
            store.get_cursor("gmail:gmail.tokens").unwrap().as_deref(),
            Some("1000")
        );
        // Reconstruct against the same store (the connector borrowed it).
        let http = FakeHttpClient::new();
        let mut conn = GmailConnector::new(config(), http, &mut store, &vault);
        conn.pending = ["m2".to_string()].into_iter().collect();
        conn.next_cursor = Some("1200".into());
        conn.mark_processed("m2").await.unwrap();
        assert_eq!(
            store.get_cursor("gmail:gmail.tokens").unwrap().as_deref(),
            Some("1200")
        );
    }

    #[tokio::test]
    async fn expired_history_cursor_rebaselines() {
        let vault = vault_with_tokens();
        let mut store = MemoryCursorStore::new();
        store.set_cursor("gmail:gmail.tokens", "5").unwrap();
        let http = FakeHttpClient::new()
            .route("/history", 404, r#"{"error":{"code":404}}"#)
            .route("/profile", 200, r#"{"historyId":"9000"}"#);
        let mut conn = GmailConnector::new(config(), http, &mut store, &vault);
        assert!(conn.list_new().await.unwrap().is_empty());
        assert_eq!(
            store.get_cursor("gmail:gmail.tokens").unwrap().as_deref(),
            Some("9000")
        );
    }

    #[tokio::test]
    async fn pubsub_pull_acks_and_signals_new_mail() {
        let vault = vault_with_tokens();
        let mut cfg = config();
        cfg.pubsub_topic = Some("projects/p/topics/slipscan-mail".into());
        cfg.pubsub_subscription = Some("projects/p/subscriptions/slipscan-pull".into());

        let http = FakeHttpClient::new()
            .route(
                ":pull",
                200,
                r#"{"receivedMessages":[{"ackId":"a1","message":{"data":"e30"}}]}"#,
            )
            .route(":acknowledge", 200, "{}")
            .route(
                "/watch",
                200,
                r#"{"historyId":"1","expiration":"99999999999999"}"#,
            );
        let mut store = MemoryCursorStore::new();
        let mut conn = GmailConnector::new(cfg, http, &mut store, &vault);

        let event = conn.wait_for_new(Duration::from_secs(30)).await.unwrap();
        assert_eq!(event, MailboxEvent::NewMail);
        let sent = conn.http.sent_urls();
        assert!(
            sent.iter().any(|u| u.contains("/watch")),
            "watch issued: {sent:?}"
        );
        assert!(sent.iter().any(|u| u.ends_with(":acknowledge")), "{sent:?}");
        assert!(
            conn.http.last_body_utf8().contains("a1"),
            "acked the message"
        );

        // Without a configured subscription there is no push channel.
        let http = FakeHttpClient::new();
        let mut conn = GmailConnector::new(config(), http, &mut store, &vault);
        assert_eq!(
            conn.wait_for_new(Duration::from_secs(1)).await.unwrap(),
            MailboxEvent::Unsupported
        );
    }

    #[test]
    fn oauth_config_requests_offline_access_and_pubsub_scope_only_when_needed() {
        let cfg = config();
        let oauth = cfg.oauth();
        assert!(oauth.scopes.iter().any(|s| s.contains("gmail.readonly")));
        assert!(!oauth.scopes.iter().any(|s| s.contains("pubsub")));
        assert!(oauth
            .extra_auth_params
            .contains(&("access_type".to_string(), "offline".to_string())));

        let mut with_push = config();
        with_push.pubsub_subscription = Some("projects/p/subscriptions/s".into());
        assert!(with_push
            .oauth()
            .scopes
            .iter()
            .any(|s| s.contains("pubsub")));
    }
}
