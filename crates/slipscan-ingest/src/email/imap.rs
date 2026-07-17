//! Generic IMAP mailbox connector (any host; TLS via rustls, or plaintext
//! strictly on loopback for Proton Bridge).
//!
//! Sync is UID-cursor polling: one folder, fetch everything above the
//! last-seen UID; the cursor lives in a [`CursorStore`] so restarts resume
//! where they left off. Push is **IMAP IDLE** — an outbound held-open
//! connection the server answers on; when it announces new mail,
//! [`MailboxConnector::wait_for_new`] returns and the caller runs a sync.
//!
//! Protocol I/O is behind the [`ImapTransport`] trait so the sync logic is
//! testable without a live server (tests never touch the network);
//! [`connect`] provides the real async-imap transport.
//!
//! The password is *received* (handed over by the credential vault via
//! `use_with`, see [`crate::vault`]) — this module never loads or stores
//! secret material.

use super::{parse_inbound, InboundMessage, MailboxConnector, MailboxEvent};
use crate::state::CursorStore;
use crate::{IngestError, IngestResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use slipscan_core::secrets::SecretString;
use std::time::Duration;

/// How the TCP connection is protected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImapSecurity {
    /// Implicit TLS (port 993). The default; required for anything remote.
    #[default]
    Tls,
    /// No TLS — allowed **only** for loopback hosts. Proton Bridge exposes
    /// IMAP on `127.0.0.1` with a self-signed/bridge-local setup; the
    /// traffic never leaves the machine.
    LocalPlaintext,
}

/// Configuration for one IMAP mailbox. Serializable (stored in settings);
/// contains no secret material — only the vault entry *name*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    /// Folder / label to poll, e.g. `"INBOX"` or `"Receipts"`.
    pub folder: String,
    pub username: String,
    /// Name of the vault entry holding the password (never the password
    /// itself).
    pub password_secret_ref: String,
    #[serde(default)]
    pub security: ImapSecurity,
}

impl ImapConfig {
    /// Cursor key for this mailbox+folder.
    pub fn cursor_key(&self) -> String {
        format!("imap:{}:{}:{}", self.host, self.username, self.folder)
    }

    fn is_loopback(&self) -> bool {
        matches!(self.host.as_str(), "localhost" | "127.0.0.1" | "::1")
            || self
                .host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    }
}

/// Minimal slice of the IMAP protocol the connector needs. Implemented by the
/// real session ([`connect`]) and by fakes in tests.
#[async_trait]
pub trait ImapTransport: Send {
    async fn select_folder(&mut self, folder: &str) -> IngestResult<()>;

    /// `UID SEARCH UID <from>:*` — may include UIDs below `from` (IMAP
    /// returns the last message for an empty range); callers must filter.
    async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>>;

    /// Fetch the raw RFC 5322 bytes of one message.
    async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>>;

    /// Hold an IDLE connection until the server announces activity or
    /// `timeout` passes. Servers commonly drop IDLE after ~29 minutes;
    /// callers simply re-issue the wait.
    async fn idle_wait(&mut self, _timeout: Duration) -> IngestResult<MailboxEvent> {
        Ok(MailboxEvent::Unsupported)
    }

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

    async fn ensure_folder(&mut self) -> IngestResult<()> {
        if !self.folder_selected {
            self.transport.select_folder(&self.config.folder).await?;
            self.folder_selected = true;
        }
        Ok(())
    }

    /// Close the session cleanly.
    pub async fn logout(&mut self) -> IngestResult<()> {
        self.transport.logout().await
    }
}

#[async_trait(?Send)]
impl<T: ImapTransport, C: CursorStore> MailboxConnector for ImapConnector<T, C> {
    fn name(&self) -> &str {
        "imap"
    }

    async fn list_new(&mut self) -> IngestResult<Vec<String>> {
        self.ensure_folder().await?;
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
        Ok(uids.into_iter().map(|u| u.to_string()).collect())
    }

    async fn fetch_message(&mut self, message_id: &str) -> IngestResult<Option<InboundMessage>> {
        self.ensure_folder().await?;
        let uid: u32 = message_id
            .parse()
            .map_err(|_| IngestError::State(format!("not an IMAP UID: {message_id:?}")))?;
        match self.transport.uid_fetch_raw(uid).await? {
            Some(raw) => parse_inbound(&raw, message_id).map(Some),
            None => Ok(None),
        }
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

    async fn wait_for_new(&mut self, timeout: Duration) -> IngestResult<MailboxEvent> {
        self.ensure_folder().await?;
        self.transport.idle_wait(timeout).await
    }
}

// ---------------------------------------------------------------------------
// Real transport: async-imap over rustls (or loopback plaintext)
// ---------------------------------------------------------------------------

use futures::TryStreamExt;
use std::fmt::Debug;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// The production transport: an authenticated async-imap session over any
/// stream (TLS for remote hosts, plain TCP strictly on loopback).
pub struct SessionTransport<S: AsyncRead + AsyncWrite + Unpin + Debug + Send> {
    // Option because IDLE consumes the session and hands it back.
    session: Option<async_imap::Session<S>>,
}

/// Back-compat alias for the TLS transport type.
pub type TlsImapTransport = SessionTransport<TlsStream<TcpStream>>;

/// Either production transport, so callers can hold one type regardless of
/// [`ImapSecurity`]. Boxed: the TLS session is an order of magnitude larger
/// than the plain one.
pub enum AnyImapTransport {
    Tls(Box<SessionTransport<TlsStream<TcpStream>>>),
    Plain(SessionTransport<TcpStream>),
}

/// Connect and log in per `config.security`.
///
/// `password` is handed over by the vault (`use_with`); it is used for the
/// LOGIN command and dropped (zeroized) with the caller's scope. Plaintext
/// connections are refused for anything that is not loopback — that mode
/// exists only for Proton Bridge on `127.0.0.1`, which works unchanged as a
/// generic IMAP mailbox.
pub async fn connect(
    config: &ImapConfig,
    password: &SecretString,
) -> IngestResult<AnyImapTransport> {
    match config.security {
        ImapSecurity::Tls => Ok(AnyImapTransport::Tls(Box::new(
            connect_tls(config, password).await?,
        ))),
        ImapSecurity::LocalPlaintext => {
            if !config.is_loopback() {
                return Err(IngestError::Connection(format!(
                    "plaintext IMAP is only allowed on loopback, not {:?}",
                    config.host
                )));
            }
            let tcp = tcp_connect(config).await?;
            login(config, password, tcp)
                .await
                .map(AnyImapTransport::Plain)
        }
    }
}

/// Open a TLS connection to `config.host:port` and log in.
pub async fn connect_tls(
    config: &ImapConfig,
    password: &SecretString,
) -> IngestResult<TlsImapTransport> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(tls_config));

    let tcp = tcp_connect(config).await?;
    let server_name = ServerName::try_from(config.host.clone())
        .map_err(|e| IngestError::Connection(format!("invalid host name: {e}")))?;
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| IngestError::Connection(format!("TLS handshake failed: {e}")))?;
    login(config, password, tls).await
}

async fn tcp_connect(config: &ImapConfig) -> IngestResult<TcpStream> {
    TcpStream::connect((config.host.as_str(), config.port))
        .await
        .map_err(|e| IngestError::Connection(format!("{}:{}: {e}", config.host, config.port)))
}

async fn login<S: AsyncRead + AsyncWrite + Unpin + Debug + Send>(
    config: &ImapConfig,
    password: &SecretString,
    stream: S,
) -> IngestResult<SessionTransport<S>> {
    let client = async_imap::Client::new(stream);
    let session = client
        .login(&config.username, password.expose_secret())
        .await
        // async-imap's error carries protocol context, never the password.
        .map_err(|(e, _)| IngestError::Auth(e.to_string()))?;
    Ok(SessionTransport {
        session: Some(session),
    })
}

impl<S: AsyncRead + AsyncWrite + Unpin + Debug + Send> SessionTransport<S> {
    fn session(&mut self) -> IngestResult<&mut async_imap::Session<S>> {
        self.session
            .as_mut()
            .ok_or_else(|| IngestError::Protocol("IMAP session was lost during IDLE".into()))
    }
}

#[async_trait]
impl<S: AsyncRead + AsyncWrite + Unpin + Debug + Send> ImapTransport for SessionTransport<S> {
    async fn select_folder(&mut self, folder: &str) -> IngestResult<()> {
        self.session()?
            .select(folder)
            .await
            .map(|_| ())
            .map_err(|e| IngestError::Protocol(e.to_string()))
    }

    async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>> {
        let uids = self
            .session()?
            .uid_search(format!("UID {from}:*"))
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))?;
        Ok(uids.into_iter().collect())
    }

    async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>> {
        let fetches: Vec<_> = self
            .session()?
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

    async fn idle_wait(&mut self, timeout: Duration) -> IngestResult<MailboxEvent> {
        let session = self
            .session
            .take()
            .ok_or_else(|| IngestError::Protocol("IMAP session was lost during IDLE".into()))?;
        let mut handle = session.idle();
        if let Err(e) = handle.init().await {
            // The session is stuck inside a half-initialised IDLE; drop it —
            // the caller reconnects.
            return Err(IngestError::Protocol(format!("IDLE init failed: {e}")));
        }
        let outcome = {
            let (wait, _interrupt) = handle.wait_with_timeout(timeout);
            wait.await
        };
        // Always send DONE and recover the session before interpreting the
        // outcome, so a server burp doesn't leak the connection.
        match handle.done().await {
            Ok(session) => self.session = Some(session),
            Err(e) => return Err(IngestError::Protocol(format!("IDLE done failed: {e}"))),
        }
        match outcome.map_err(|e| IngestError::Protocol(format!("IDLE failed: {e}")))? {
            async_imap::extensions::idle::IdleResponse::NewData(_) => Ok(MailboxEvent::NewMail),
            async_imap::extensions::idle::IdleResponse::Timeout
            | async_imap::extensions::idle::IdleResponse::ManualInterrupt => {
                Ok(MailboxEvent::Timeout)
            }
        }
    }

    async fn logout(&mut self) -> IngestResult<()> {
        self.session()?
            .logout()
            .await
            .map_err(|e| IngestError::Protocol(e.to_string()))
    }
}

macro_rules! delegate_any {
    ($self:ident, $method:ident $(, $arg:expr)*) => {
        match $self {
            AnyImapTransport::Tls(t) => t.$method($($arg),*).await,
            AnyImapTransport::Plain(t) => t.$method($($arg),*).await,
        }
    };
}

#[async_trait]
impl ImapTransport for AnyImapTransport {
    async fn select_folder(&mut self, folder: &str) -> IngestResult<()> {
        delegate_any!(self, select_folder, folder)
    }

    async fn uid_search_from(&mut self, from: u32) -> IngestResult<Vec<u32>> {
        delegate_any!(self, uid_search_from, from)
    }

    async fn uid_fetch_raw(&mut self, uid: u32) -> IngestResult<Option<Vec<u8>>> {
        delegate_any!(self, uid_fetch_raw, uid)
    }

    async fn idle_wait(&mut self, timeout: Duration) -> IngestResult<MailboxEvent> {
        delegate_any!(self, idle_wait, timeout)
    }

    async fn logout(&mut self) -> IngestResult<()> {
        delegate_any!(self, logout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::MailboxConnector;
    use crate::state::MemoryCursorStore;
    use std::collections::HashMap;

    /// Scripted in-memory IMAP server: uid → raw message.
    #[derive(Default)]
    struct FakeTransport {
        messages: HashMap<u32, Vec<u8>>,
        selected: Option<String>,
        searches: Vec<u32>,
        idle_scripted: Vec<MailboxEvent>,
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

        async fn idle_wait(&mut self, _timeout: Duration) -> IngestResult<MailboxEvent> {
            Ok(self.idle_scripted.pop().unwrap_or(MailboxEvent::Timeout))
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
            security: ImapSecurity::Tls,
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
        assert_eq!(
            conn.transport.searches,
            vec![1],
            "first poll starts at UID 1"
        );

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

    #[tokio::test]
    async fn idle_push_selects_folder_then_waits() {
        let transport = FakeTransport {
            idle_scripted: vec![MailboxEvent::NewMail],
            ..FakeTransport::default()
        };
        let mut conn = ImapConnector::new(config(), transport, MemoryCursorStore::new());
        let event = conn.wait_for_new(Duration::from_secs(60)).await.unwrap();
        assert_eq!(event, MailboxEvent::NewMail);
        assert_eq!(conn.transport.selected.as_deref(), Some("Receipts"));
        // Nothing scripted: falls back to timeout, caller re-issues.
        let event = conn.wait_for_new(Duration::from_secs(60)).await.unwrap();
        assert_eq!(event, MailboxEvent::Timeout);
    }

    #[test]
    fn config_serde_and_cursor_key() {
        let cfg = config();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(
            !json.contains("password\":"),
            "no secret material in config"
        );
        let back: ImapConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        assert_eq!(cfg.cursor_key(), "imap:mail.example:me@example:Receipts");
        // Configs saved before the `security` field default to TLS.
        let legacy: ImapConfig = serde_json::from_str(
            r#"{"host":"h","port":993,"folder":"INBOX","username":"u","password_secret_ref":"r"}"#,
        )
        .unwrap();
        assert_eq!(legacy.security, ImapSecurity::Tls);
    }

    #[test]
    fn plaintext_is_loopback_only() {
        // Proton Bridge shape: loopback + plaintext is representable…
        let bridge = ImapConfig {
            host: "127.0.0.1".into(),
            port: 1143,
            security: ImapSecurity::LocalPlaintext,
            ..config()
        };
        assert!(bridge.is_loopback());
        // …but a remote host with plaintext must be refused by connect().
        let remote = ImapConfig {
            security: ImapSecurity::LocalPlaintext,
            ..config()
        };
        assert!(!remote.is_loopback());
        let result = futures::executor::block_on(connect(&remote, &SecretString::new("pw")));
        assert!(matches!(result, Err(IngestError::Connection(_))));
    }
}
