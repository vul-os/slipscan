//! Generic IMAP mailbox connector (any host, TLS via rustls).
//!
//! Polls one folder since the last-seen UID; the cursor lives in a
//! [`CursorStore`] so restarts resume where they left off. Protocol I/O is
//! behind the [`ImapTransport`] trait so the sync logic is testable without a
//! live server (tests never touch the network); [`connect_tls`] provides the
//! real async-imap + rustls transport.
//!
//! The password is *received* (looked up from the OS keychain by the caller
//! via `SecretStore` using [`ImapConfig::password_secret_ref`]) — this module
//! never loads or stores secret material.

use super::{parse_inbound, InboundMessage, MailboxConnector};
use crate::state::CursorStore;
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Configuration for one IMAP mailbox. Serializable (stored in settings);
/// contains no secret material — only the keychain entry *name*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    /// Folder / label to poll, e.g. `"INBOX"` or `"Receipts"`.
    pub folder: String,
    pub username: String,
    /// Name of the OS-keychain entry holding the password (never the
    /// password itself).
    pub password_secret_ref: String,
}

impl ImapConfig {
    /// Cursor key for this mailbox+folder.
    pub fn cursor_key(&self) -> String {
        format!("imap:{}:{}:{}", self.host, self.username, self.folder)
    }
}

/// Minimal slice of the IMAP protocol the connector needs. Implemented by the
/// real TLS session ([`connect_tls`]) and by fakes in tests.
#[async_trait]
pub trait ImapTransport: Send {
    async fn select_folder(&mut self, folder: &str) -> IngestResult<()>;

    /// `UID SEARCH UID <from>:*` — may include UIDs below `from` (IMAP
    /// returns the last message for an empty range); callers must filter.
    async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>>;

    /// Fetch the raw RFC 5322 bytes of one message.
    async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>>;

    async fn logout(&mut self) -> IngestResult<()>;
}

/// [`MailboxConnector`] over any [`ImapTransport`], with UID-cursor state.
pub struct ImapConnector<T: ImapTransport, C: CursorStore> {
    config: ImapConfig,
    transport: T,
    cursors: C,
    folder_selected: bool,
}

impl<T: ImapTransport, C: CursorStore> ImapConnector<T, C> {
    pub fn new(config: ImapConfig, transport: T, cursors: C) -> Self {
        Self {
            config,
            transport,
            cursors,
            folder_selected: false,
        }
    }

    fn last_seen_uid(&self) -> IngestResult<u32> {
        match self.cursors.get_cursor(&self.config.cursor_key())? {
            None => Ok(0),
            Some(raw) => raw
                .parse::<u32>()
                .map_err(|_| IngestError::State(format!("corrupt IMAP cursor: {raw:?}"))),
        }
    }

    /// Close the session cleanly.
    pub async fn logout(&mut self) -> IngestResult<()> {
        self.transport.logout().await
    }
}

#[async_trait]
impl<T: ImapTransport, C: CursorStore> MailboxConnector for ImapConnector<T, C> {
    fn name(&self) -> &str {
        "imap"
    }

    async fn fetch_unseen(&mut self) -> IngestResult<Vec<InboundMessage>> {
        if !self.folder_selected {
            self.transport.select_folder(&self.config.folder).await?;
            self.folder_selected = true;
        }
        let last_seen = self.last_seen_uid()?;
        let mut uids: Vec<u32> = self
            .transport
            .uid_search_from(last_seen.saturating_add(1))
            .await?
            .into_iter()
            .filter(|uid| *uid > last_seen)
            .collect();
        uids.sort_unstable();
        uids.dedup();

        let mut messages = Vec::with_capacity(uids.len());
        for uid in uids {
            if let Some(raw) = self.transport.uid_fetch_raw(uid).await? {
                match parse_inbound(&raw, &uid.to_string()) {
                    Ok(msg) => messages.push(msg),
                    // A single broken message must not wedge the whole
                    // folder: skip it; the cursor only advances when the
                    // caller marks messages processed.
                    Err(IngestError::Parse(_)) => continue,
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(messages)
    }

    async fn mark_processed(&mut self, message_id: &str) -> IngestResult<()> {
        let uid: u32 = message_id
            .parse()
            .map_err(|_| IngestError::State(format!("not an IMAP UID: {message_id:?}")))?;
        if uid > self.last_seen_uid()? {
            self.cursors
                .set_cursor(&self.config.cursor_key(), &uid.to_string())?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Real transport: async-imap over rustls
// ---------------------------------------------------------------------------

use futures::TryStreamExt;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// The production transport: an authenticated async-imap session over TLS.
pub struct TlsImapTransport {
    session: async_imap::Session<TlsStream<TcpStream>>,
}

/// Open a TLS connection to `config.host:port` and log in.
///
/// `password` must be resolved by the caller from the OS keychain
/// (`SecretStore::get_secret(&config.password_secret_ref)`); it is used for
/// the LOGIN command and dropped.
pub async fn connect_tls(config: &ImapConfig, password: &str) -> IngestResult<TlsImapTransport> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(tls_config));

    let tcp = TcpStream::connect((config.host.as_str(), config.port))
        .await
        .map_err(|e| IngestError::Connection(format!("{}:{}: {e}", config.host, config.port)))?;
    let server_name = ServerName::try_from(config.host.clone())
        .map_err(|e| IngestError::Connection(format!("invalid host name: {e}")))?;
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| IngestError::Connection(format!("TLS handshake failed: {e}")))?;

    let client = async_imap::Client::new(tls);
    let session = client
        .login(&config.username, password)
        .await
        .map_err(|(e, _)| IngestError::Auth(e.to_string()))?;
    Ok(TlsImapTransport { session })
}

#[async_trait]
impl ImapTransport for TlsImapTransport {
    async fn select_folder(&mut self, folder: &str) -> IngestResult<()> {
        self.session
            .select(folder)
            .await
            .map(|_| ())
            .map_err(|e| IngestError::Protocol(e.to_string()))
    }

    async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>> {
        let uids = self
            .session
            .uid_search(format!("UID {from}:*"))
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))?;
        Ok(uids.into_iter().collect())
    }

    async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>> {
        let fetches: Vec<_> = self
            .session
            .uid_fetch(uid.to_string(), "RFC822")
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))?
            .try_collect()
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))?;
        Ok(fetches
            .into_iter()
            .find_map(|f| f.body().map(|b| b.to_vec())))
    }

    async fn logout(&mut self) -> IngestResult<()> {
        self.session
            .logout()
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MemoryCursorStore;
    use std::collections::HashMap;

    /// Scripted in-memory IMAP server: uid → raw message.
    #[derive(Default)]
    struct FakeTransport {
        messages: HashMap<u32, Vec<u8>>,
        selected: Option<String>,
        searches: Vec<u32>,
    }

    fn receipt_raw(n: u32) -> Vec<u8> {
        format!(
            "From: till@shop.example\r\nSubject: Slip {n}\r\nMIME-Version: 1.0\r\n\
Content-Type: text/plain\r\n\r\nplain body\r\n"
        )
        .into_bytes()
    }

    #[async_trait]
    impl ImapTransport for FakeTransport {
        async fn select_folder(&mut self, folder: &str) -> IngestResult<()> {
            self.selected = Some(folder.to_string());
            Ok(())
        }

        async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>> {
            self.searches.push(from);
            let mut uids: Vec<u32> = self
                .messages
                .keys()
                .copied()
                .filter(|u| *u >= from)
                .collect();
            // Emulate the IMAP `n:*` quirk: the last message is always
            // returned, even when its UID is below `from`.
            if let Some(max) = self.messages.keys().copied().max() {
                uids.push(max);
            }
            Ok(uids)
        }

        async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>> {
            Ok(self.messages.get(&uid).cloned())
        }

        async fn logout(&mut self) -> IngestResult<()> {
            Ok(())
        }
    }

    fn config() -> ImapConfig {
        ImapConfig {
            host: "mail.example".into(),
            port: 993,
            folder: "Receipts".into(),
            username: "me@example".into(),
            password_secret_ref: "imap.mail.example.password".into(),
        }
    }

    #[tokio::test]
    async fn polls_since_last_seen_uid_and_advances_on_mark_processed() {
        let mut transport = FakeTransport::default();
        transport.messages.insert(3, receipt_raw(3));
        transport.messages.insert(5, receipt_raw(5));
        let mut conn = ImapConnector::new(config(), transport, MemoryCursorStore::new());

        let msgs = conn.fetch_unseen().await.unwrap();
        assert_eq!(
            msgs.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["3", "5"],
            "oldest first"
        );
        assert_eq!(conn.transport.selected.as_deref(), Some("Receipts"));
        assert_eq!(conn.transport.searches, vec![1], "first poll starts at UID 1");

        conn.mark_processed("3").await.unwrap();
        conn.mark_processed("5").await.unwrap();

        // Second poll: cursor at 5, search starts at 6; the `n:*` quirk
        // returns UID 5 again but it must be filtered out.
        let msgs = conn.fetch_unseen().await.unwrap();
        assert!(msgs.is_empty(), "everything already processed");
        assert_eq!(conn.transport.searches, vec![1, 6]);

        // New mail arrives.
        conn.transport.messages.insert(9, receipt_raw(9));
        let msgs = conn.fetch_unseen().await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "9");
        assert_eq!(msgs[0].subject.as_deref(), Some("Slip 9"));
    }

    #[tokio::test]
    async fn cursor_only_advances_forward() {
        let mut transport = FakeTransport::default();
        transport.messages.insert(8, receipt_raw(8));
        let mut conn = ImapConnector::new(config(), transport, MemoryCursorStore::new());
        conn.mark_processed("8").await.unwrap();
        conn.mark_processed("2").await.unwrap(); // out-of-order ack: no rewind
        assert_eq!(conn.last_seen_uid().unwrap(), 8);
        assert!(conn.mark_processed("not-a-uid").await.is_err());
    }

    #[tokio::test]
    async fn crash_before_mark_processed_refetches_the_same_uid() {
        let mut transport = FakeTransport::default();
        transport.messages.insert(4, receipt_raw(4));
        let cfg = config();

        let mut store = MemoryCursorStore::new();
        // First run fetches but "crashes" before marking processed.
        {
            let mut conn = ImapConnector::new(cfg.clone(), transport, &mut store);
            let msgs = conn.fetch_unseen().await.unwrap();
            assert_eq!(msgs.len(), 1);
        }
        // A fresh connector with the same store sees the message again.
        let mut transport = FakeTransport::default();
        transport.messages.insert(4, receipt_raw(4));
        let mut conn = ImapConnector::new(cfg, transport, &mut store);
        let msgs = conn.fetch_unseen().await.unwrap();
        assert_eq!(msgs.len(), 1, "unacked UID is fetched again");
    }

    #[test]
    fn config_serde_and_cursor_key() {
        let cfg = config();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("password\":"), "no secret material in config");
        let back: ImapConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        assert_eq!(cfg.cursor_key(), "imap:mail.example:me@example:Receipts");
    }
}
