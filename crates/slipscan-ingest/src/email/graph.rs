//! Outlook / Microsoft 365 connector over Microsoft Graph.
//!
//! BYO app registration (public client) + **device-code flow**: the user
//! types a short code at microsoft.com/devicelogin — no redirect URI, no
//! local web server, no client secret.
//!
//! Sync is a Graph **delta query** on the watched mail folder: the durable
//! cursor is the `@odata.deltaLink`, so each poll transfers only changes.
//! Messages are fetched as raw MIME (`/$value`) and run through the same
//! parser as IMAP/Gmail mail. Graph's change notifications need a public
//! HTTPS endpoint, which a local-first desktop app does not have — push is
//! only available in self-host server mode, so [`MailboxConnector::wait_for_new`]
//! reports `Unsupported` here and callers poll (cheap, delta).

use super::oauth::{
    begin_device_flow, ensure_access, finish_device_flow, DeviceAuthorization, OAuthClientConfig,
    TokenSet,
};
use super::{parse_inbound, InboundMessage, MailboxConnector};
use crate::http::{HttpClient, HttpRequest};
use crate::state::CursorStore;
use crate::vault::VaultAccess;
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";

/// Configuration for one Graph mailbox. No secret material — vault entry
/// names only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphConfig {
    /// Application (client) id of the user's own app registration.
    pub client_id: String,
    /// Tenant id, or `consumers` / `organizations` / `common`.
    pub tenant: String,
    /// Mail folder to watch: a well-known name (`inbox`) or folder id.
    pub folder: String,
    /// Vault entry holding the [`TokenSet`] JSON.
    pub token_ref: String,
}

impl GraphConfig {
    pub fn cursor_key(&self) -> String {
        format!("graph:{}:{}", self.token_ref, self.folder)
    }

    /// Device-code endpoint for this tenant.
    pub fn device_endpoint(&self) -> String {
        format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
            self.tenant
        )
    }

    /// OAuth client config (public client — no secret).
    pub fn oauth(&self) -> OAuthClientConfig {
        OAuthClientConfig {
            auth_endpoint: format!(
                "https://login.microsoftonline.com/{}/oauth2/v2.0/authorize",
                self.tenant
            ),
            token_endpoint: format!(
                "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                self.tenant
            ),
            client_id: self.client_id.clone(),
            client_secret_ref: None,
            token_ref: self.token_ref.clone(),
            scopes: vec!["offline_access".into(), "Mail.Read".into()],
            extra_auth_params: Vec::new(),
        }
    }
}

/// Step 1 of connecting: get the code the user must type. User-initiated by
/// construction — nothing proceeds until they complete the login.
pub async fn begin_device_login(
    http: &dyn HttpClient,
    config: &GraphConfig,
) -> IngestResult<DeviceAuthorization> {
    begin_device_flow(http, &config.device_endpoint(), &config.oauth()).await
}

/// Step 2: poll until the user finishes; tokens land in the vault.
pub async fn finish_device_login(
    http: &dyn HttpClient,
    vault: &dyn VaultAccess,
    config: &GraphConfig,
    authorization: DeviceAuthorization,
) -> IngestResult<()> {
    finish_device_flow(http, vault, &config.oauth(), authorization).await
}

/// [`MailboxConnector`] over Microsoft Graph delta queries.
pub struct GraphConnector<'v, H: HttpClient, C: CursorStore> {
    config: GraphConfig,
    http: H,
    cursors: C,
    vault: &'v dyn VaultAccess,
    token_cache: Option<TokenSet>,
    pending: HashSet<String>,
    next_cursor: Option<String>,
}

impl<'v, H: HttpClient, C: CursorStore> GraphConnector<'v, H, C> {
    pub fn new(config: GraphConfig, http: H, cursors: C, vault: &'v dyn VaultAccess) -> Self {
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

    fn initial_delta_url(&self) -> String {
        format!(
            "{GRAPH_BASE}/me/mailFolders/{}/messages/delta?$select=id",
            self.config.folder
        )
    }

    async fn get(&mut self, url: &str) -> IngestResult<crate::http::HttpResponse> {
        let access = ensure_access(
            &self.http,
            self.vault,
            &self.config.oauth(),
            &mut self.token_cache,
        )
        .await?;
        self.http
            .send(HttpRequest::get(url).bearer(access.expose_secret()))
            .await
    }
}

#[async_trait(?Send)]
impl<H: HttpClient, C: CursorStore> MailboxConnector for GraphConnector<'_, H, C> {
    fn name(&self) -> &str {
        "graph"
    }

    async fn list_new(&mut self) -> IngestResult<Vec<String>> {
        let mut url = match self.cursors.get_cursor(&self.config.cursor_key())? {
            Some(delta_link) => delta_link,
            None => self.initial_delta_url(),
        };
        let mut ids: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut resynced = false;
        loop {
            let response = self.get(&url).await?;
            if response.status == 410 && !resynced {
                // Delta token expired: Graph asks for a full resync. Restart
                // from scratch (once); document dedup absorbs refetches.
                resynced = true;
                url = self.initial_delta_url();
                ids.clear();
                seen.clear();
                continue;
            }
            if !response.is_success() {
                return Err(IngestError::Http(format!(
                    "graph delta: HTTP {}",
                    response.status
                )));
            }
            let value = response.json()?;
            for item in value
                .get("value")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if item.get("@removed").is_some() {
                    continue; // deletions are not ingestable mail
                }
                if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    if seen.insert(id.to_string()) {
                        ids.push(id.to_string());
                    }
                }
            }
            if let Some(next) = value.get("@odata.nextLink").and_then(|l| l.as_str()) {
                url = next.to_string();
                continue;
            }
            self.next_cursor = value
                .get("@odata.deltaLink")
                .and_then(|l| l.as_str())
                .map(str::to_string);
            break;
        }
        self.pending = seen;
        Ok(ids)
    }

    async fn fetch_message(&mut self, message_id: &str) -> IngestResult<Option<InboundMessage>> {
        // Raw MIME so all providers normalise through one parser.
        let url = format!("{GRAPH_BASE}/me/messages/{message_id}/$value");
        let response = self.get(&url).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.is_success() {
            return Err(IngestError::Http(format!(
                "graph message: HTTP {}",
                response.status
            )));
        }
        parse_inbound(&response.body, message_id).map(Some)
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

    // wait_for_new: default `Unsupported` — Graph push needs a public
    // endpoint (self-host server mode only); callers delta-poll instead.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::MailboxEvent;
    use crate::http::testutil::FakeHttpClient;
    use crate::state::MemoryCursorStore;
    use crate::vault::MemoryVault;
    use std::time::Duration;

    fn config() -> GraphConfig {
        GraphConfig {
            client_id: "app-1".into(),
            tenant: "consumers".into(),
            folder: "inbox".into(),
            token_ref: "graph.tokens".into(),
        }
    }

    fn vault_with_tokens() -> MemoryVault {
        let vault = MemoryVault::new();
        super::super::oauth::save_tokens(
            &vault,
            "graph.tokens",
            &TokenSet {
                access_token: "at".into(),
                refresh_token: Some("rt".into()),
                expires_at_unix: super::super::oauth::now_unix() + 3600,
            },
        )
        .unwrap();
        vault
    }

    const RAW_MAIL: &str = "From: billing@service.example\r\nSubject: Graph invoice\r\n\
MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nbody\r\n";

    #[tokio::test]
    async fn delta_sync_pages_stores_delta_link_and_uses_it_next_time() {
        let vault = vault_with_tokens();
        let mut store = MemoryCursorStore::new();
        let http = FakeHttpClient::new()
            .route(
                "$skiptoken=page2",
                200,
                r#"{"value":[{"id":"g2"}],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D1"}"#,
            )
            .route(
                "messages/delta?$select=id",
                200,
                r#"{"value":[{"id":"g1"},{"id":"gone","@removed":{"reason":"deleted"}}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=page2"}"#,
            )
            .route("/$value", 200, RAW_MAIL);
        let mut conn = GraphConnector::new(config(), http, &mut store, &vault);

        let ids = conn.list_new().await.unwrap();
        assert_eq!(ids, vec!["g1", "g2"], "paged, deletions skipped");

        let msg = conn.fetch_message("g1").await.unwrap().unwrap();
        assert_eq!(msg.subject.as_deref(), Some("Graph invoice"));

        conn.mark_processed("g1").await.unwrap();
        assert_eq!(store.get_cursor("graph:graph.tokens:inbox").unwrap(), None);
        // Rebuild with the same store to finish the batch.
        let mut conn = GraphConnector::new(config(), FakeHttpClient::new(), &mut store, &vault);
        conn.pending = ["g2".to_string()].into_iter().collect();
        conn.next_cursor = Some(
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D1"
                .into(),
        );
        conn.mark_processed("g2").await.unwrap();
        let cursor = store
            .get_cursor("graph:graph.tokens:inbox")
            .unwrap()
            .unwrap();
        assert!(cursor.contains("$deltatoken=D1"), "{cursor}");

        // Next sync polls the stored deltaLink, not the initial URL.
        let http = FakeHttpClient::new().route(
            "$deltatoken=D1",
            200,
            r#"{"value":[],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D2"}"#,
        );
        let mut conn = GraphConnector::new(config(), http, &mut store, &vault);
        assert!(conn.list_new().await.unwrap().is_empty());
        let sent = conn.http.sent_urls();
        assert!(
            sent.iter().any(|u| u.contains("$deltatoken=D1")),
            "{sent:?}"
        );
    }

    #[tokio::test]
    async fn expired_delta_token_triggers_full_resync() {
        let vault = vault_with_tokens();
        let mut store = MemoryCursorStore::new();
        store
            .set_cursor(
                "graph:graph.tokens:inbox",
                "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=OLD",
            )
            .unwrap();
        let http = FakeHttpClient::new()
            .route("$deltatoken=OLD", 410, r#"{"error":{"code":"syncStateNotFound"}}"#)
            .route(
                "messages/delta?$select=id",
                200,
                r#"{"value":[{"id":"g9"}],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=NEW"}"#,
            );
        let mut conn = GraphConnector::new(config(), http, &mut store, &vault);
        let ids = conn.list_new().await.unwrap();
        assert_eq!(ids, vec!["g9"]);
    }

    #[tokio::test]
    async fn push_is_unsupported_on_desktop() {
        let vault = vault_with_tokens();
        let mut store = MemoryCursorStore::new();
        let mut conn = GraphConnector::new(config(), FakeHttpClient::new(), &mut store, &vault);
        assert_eq!(
            conn.wait_for_new(Duration::from_secs(1)).await.unwrap(),
            MailboxEvent::Unsupported
        );
    }

    #[tokio::test]
    async fn device_login_round_trip_stores_tokens() {
        let vault = MemoryVault::new();
        let cfg = config();
        let http = FakeHttpClient::new()
            .route(
                "/devicecode",
                200,
                r#"{"device_code":"dc","user_code":"XYZ-999","verification_uri":"https://microsoft.com/devicelogin","interval":0,"expires_in":900}"#,
            )
            .route(
                "/token",
                200,
                r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#,
            );
        let auth = begin_device_login(&http, &cfg).await.unwrap();
        assert_eq!(auth.user_code, "XYZ-999");
        finish_device_login(&http, &vault, &cfg, auth)
            .await
            .unwrap();
        let stored = super::super::oauth::load_tokens(&vault, "graph.tokens")
            .unwrap()
            .unwrap();
        assert_eq!(stored.refresh_token.as_deref(), Some("rt"));
        // Device-code endpoint is tenant-scoped, public client (no secret).
        let sent = http.sent_urls();
        assert!(
            sent.iter()
                .any(|u| u.contains("consumers/oauth2/v2.0/devicecode")),
            "{sent:?}"
        );
        assert!(!http.last_body_utf8().contains("client_secret"));
    }
}
