//! slipscan — command-line interface.
//!
//! Subcommands: `init`, `import`, `watch`, `extract`, `mail-sync`, `recon`,
//! `report`, `fx`, `pack`, `vault`, `serve`, `list`, `member`, `attribute`,
//! `split`.
//! Every command has human-readable output by default and `--json` for
//! machines. Binaries may use anyhow.
//!
//! Privacy posture:
//! * `serve` binds 127.0.0.1 unless the user passes `--lan` (explicit opt-in)
//! * API tokens are generated/accepted here but only their SHA-256 is stored
//! * `vault` subcommands read secret material from a no-echo prompt or stdin
//!   and never print it — output is metadata only

mod extractor;

use anyhow::{anyhow, bail, Context};
use clap::{Parser, Subcommand, ValueEnum};
use slipscan_core::datadir::{self, DataDirResolver, MoveStep};
use slipscan_core::device::pairing::{KeynameCheck, DEFAULT_INVITE_TTL_SECONDS};
use slipscan_core::domain::{
    Account, Book, BookKind, DocumentSource, LocationKind, LocationPatch, Member, MemberPatch,
    NewBook, NewLocation, NewMember, NewPayEndpoint, NewPayWatch, PayDeliveryState,
    PayEndpointWithSecret, SplitShare, TransactionFilter, TransactionSource,
};
use slipscan_core::secrets::{KeyringSecretStore, SecretStore, SecretString, Vault};
use slipscan_core::{CoreService, Db};
use slipscan_ingest::bank::import_statement_lines;
use slipscan_ingest::email::gmail::{GmailConfig, GmailConnector};
use slipscan_ingest::email::graph::{
    begin_device_login, finish_device_login, GraphConfig, GraphConnector,
};
use slipscan_ingest::email::imap::{connect_tls, ImapConfig, ImapConnector};
use slipscan_ingest::email::oauth::begin_loopback_flow;
use slipscan_ingest::email::{
    sync_mailbox_with_alerts, AlertRules, AlertSync, MailboxFilter, MailboxSyncOutcome,
};
use slipscan_ingest::http::ReqwestHttpClient;
use slipscan_ingest::import::{import_document_file, FileImport};
use slipscan_ingest::watch::{import_paths, scan_folder, FolderImportOutcome, FolderWatcher};
use slipscan_ingest::{IngestError, SettingsCursorStore};
use slipscan_server::devices::DeviceHandle;
use slipscan_server::oplog::OplogHandle;
use slipscan_server::vault::VaultHandle;
use slipscan_server::{ops, AuthToken, ServerConfig};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Settings key holding the IMAP mailbox config JSON ([`ImapConfig`] —
/// contains no secret material, only the vault credential name).
const MAIL_CONFIG_SETTING: &str = "mail.imap.config";

/// Settings key holding the Gmail mailbox config JSON ([`GmailConfig`] —
/// vault entry *names* only, never the client secret or tokens).
const GMAIL_CONFIG_SETTING: &str = "mail.gmail.config";

/// Settings key holding the Microsoft Graph mailbox config JSON
/// ([`GraphConfig`] — vault entry *names* only).
const GRAPH_CONFIG_SETTING: &str = "mail.graph.config";

/// How long `watch` blocks for filesystem activity before looping. Long
/// enough to idle cheaply, short enough that Ctrl-C feels immediate.
const WATCH_POLL: Duration = Duration::from_secs(5);

/// Settings key naming the configured extraction provider.
const EXTRACT_PROVIDER_SETTING: &str = "extract.provider";

/// Env var accepted by `serve` for a user-chosen API token (never argv, so
/// it stays out of shell history and `ps`).
const TOKEN_ENV: &str = "SLIPSCAN_API_TOKEN";

#[derive(Debug, Parser)]
#[command(
    name = "slipscan",
    version,
    about = "Self-hosted personal finance + accounting"
)]
struct Cli {
    /// Path to a SlipScan SQLite database file. Overrides the managed data
    /// folder (see `slipscan data status`), which is the default since it is
    /// what the desktop app and server resolve too.
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    /// Override the fixed app-config directory holding the data-folder
    /// pointer file (tests/containers; the default data folder becomes
    /// `<dir>/data`). Normal use never needs this.
    #[arg(long, global = true, hide = true)]
    config_dir: Option<PathBuf>,

    /// Machine-readable JSON output instead of human text.
    #[arg(long, global = true)]
    json: bool,

    /// Book to operate on (id or exact name). Optional when only one exists.
    #[arg(long, global = true)]
    book: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliBookKind {
    Personal,
    Business,
}

impl From<CliBookKind> for BookKind {
    fn from(kind: CliBookKind) -> Self {
        match kind {
            CliBookKind::Personal => BookKind::Personal,
            CliBookKind::Business => BookKind::Business,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliLocationKind {
    Branch,
    Warehouse,
    Site,
}

impl From<CliLocationKind> for LocationKind {
    fn from(kind: CliLocationKind) -> Self {
        match kind {
            CliLocationKind::Branch => LocationKind::Branch,
            CliLocationKind::Warehouse => LocationKind::Warehouse,
            CliLocationKind::Site => LocationKind::Site,
        }
    }
}

/// `book set-multi-location` modes — the tri-state override on `books`
/// (Phase 6 decision #3): derive it, or pin it either way.
#[derive(Debug, Clone, Copy, ValueEnum)]
enum MultiLocationMode {
    /// Derive from the `locations` row count (the default for every book).
    Auto,
    On,
    Off,
}

/// Which mailbox connector `mail-sync` drives. `imap` is the default so
/// existing invocations are unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum MailProvider {
    /// Any IMAP host (Proton Bridge on 127.0.0.1 included).
    Imap,
    /// Gmail API `history.list` deltas, your own OAuth client.
    Gmail,
    /// Microsoft Graph delta queries, your own app registration.
    Graph,
}

impl MailProvider {
    fn as_str(self) -> &'static str {
        match self {
            MailProvider::Imap => "imap",
            MailProvider::Gmail => "gmail",
            MailProvider::Graph => "graph",
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ListTarget {
    Books,
    Accounts,
    Transactions,
    Documents,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ReportKind {
    /// Trial balance.
    Tb,
    /// Profit & loss.
    Pl,
    /// Balance sheet.
    Bs,
    /// Tax-period summary (named by your region profile — e.g. VAT201 in
    /// South Africa). `vat` is accepted as an alias for compatibility.
    #[value(alias = "vat")]
    Tax,
    /// Per-member expense + contribution rollup (household attribution).
    /// Needs `--from`/`--to`.
    Members,
    /// Net position per member over a period — "who owes whom" (household
    /// attribution). Needs `--from`/`--to`.
    SettleUp,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Create the database (and optionally a first book).
    Init {
        /// Name for the first book.
        #[arg(long)]
        name: Option<String>,
        /// Kind of the first book.
        #[arg(long, value_enum, default_value_t = CliBookKind::Personal)]
        kind: CliBookKind,
        /// Region profile for the new book (chart of accounts, tax rates and
        /// report labels are data, not code). Defaults to the generic
        /// international profile; see --list-regions.
        #[arg(long)]
        region: Option<String>,
        /// ISO-4217 book currency (e.g. EUR, INR, JPY). Defaults to the
        /// region profile's currency — pass this to book in any currency.
        #[arg(long)]
        currency: Option<String>,
        /// Seed the region profile's default chart of accounts into the new
        /// book.
        #[arg(long)]
        seed_coa: bool,
        /// List the built-in region profiles and exit.
        #[arg(long)]
        list_regions: bool,
    },
    /// Import document/statement files (pdf, images, html, csv, ofx). With
    /// --preset, CSV statements are also parsed into transactions.
    Import {
        /// Files to import.
        #[arg(required_unless_present = "list_presets")]
        paths: Vec<PathBuf>,
        /// Statement-preset id (see --list-presets, e.g. za-fnb,
        /// generic-mdy): parse each CSV with this column mapping and import
        /// the lines as transactions (requires --account).
        #[arg(long)]
        preset: Option<String>,
        /// Account (id or exact name) the statement lines belong to.
        /// Required with --preset; create one with `slipscan account add`.
        #[arg(long)]
        account: Option<String>,
        /// List the statement-preset catalog (grouped by region) and exit.
        #[arg(long)]
        list_presets: bool,
    },
    /// Watch a drop folder: import everything ingestable already in it, then
    /// keep importing files as they land (content-hash dedup means a rescan
    /// never double-imports). Runs until interrupted; Ctrl-C to stop.
    Watch {
        /// Folder to scan and watch (recursively).
        dir: PathBuf,
        /// Import what is already there and exit, without watching — for
        /// cron/launchd.
        #[arg(long)]
        once: bool,
    },
    /// Run extraction on pending slips via the configured provider.
    Extract {
        /// Maximum documents to process this run.
        #[arg(long, default_value_t = 25)]
        limit: usize,
    },
    /// Poll a configured mailbox and import receipt documents.
    MailSync {
        /// Mailbox provider to sync: generic IMAP (the default, unchanged),
        /// Gmail (history deltas), or Microsoft Graph (delta queries). Each
        /// reads its own settings key: mail.imap.config, mail.gmail.config,
        /// mail.graph.config.
        #[arg(long, value_enum, default_value_t = MailProvider::Imap)]
        provider: MailProvider,
        /// Run the provider's user-initiated OAuth grant and exit (Gmail:
        /// loopback + PKCE in your browser; Graph: device code). Tokens go
        /// straight into the vault and are never displayed. Not for imap,
        /// which authenticates with a vault password.
        #[arg(long)]
        login: bool,
        /// Where to store fetched attachments (default: the data folder's
        /// `documents/` store, or `<db dir>/slipscan-documents` with --db).
        #[arg(long)]
        storage_dir: Option<PathBuf>,
        /// Also turn bank-alert emails ("a card purchase of … was made at …")
        /// into transactions, using the `mailrules` packs installed in this
        /// book. Requires --account: alerts are booked there, and an alert
        /// whose account hint contradicts it is declined, never rehomed.
        /// Off by default — without it a sync imports documents only, exactly
        /// as before.
        #[arg(long, requires = "account")]
        alerts: bool,
        /// Account (id or name) that parsed bank alerts are booked to.
        #[arg(long)]
        account: Option<String>,
    },
    /// Reconciliation: suggest and confirm matches.
    Recon {
        #[command(subcommand)]
        action: ReconAction,
    },
    /// Reports: trial balance, profit & loss, balance sheet, tax summary,
    /// per-member expense/contribution, settle-up.
    Report {
        #[arg(value_enum)]
        kind: ReportKind,
        /// CSV output (trial balance only).
        #[arg(long)]
        csv: bool,
        /// Start date (YYYY-MM-DD), inclusive — required for `members` and
        /// `settle-up`; every other report kind ignores it.
        #[arg(long)]
        from: Option<String>,
        /// End date (YYYY-MM-DD), inclusive — required for `members` and
        /// `settle-up`.
        #[arg(long)]
        to: Option<String>,
    },
    /// Exchange rates via your configured OpenRate endpoint (opt-in: with no
    /// URL configured, SlipScan makes zero FX network calls).
    Fx {
        #[command(subcommand)]
        action: FxAction,
    },
    /// Accounts (bank/cash/card) within a book.
    Account {
        #[command(subcommand)]
        action: AccountAction,
    },
    /// Net worth over time (PARITY.md "Net worth over time"): periodic
    /// per-account balance snapshots, backfilled from the transaction
    /// ledger, queried as a series.
    Networth {
        #[command(subcommand)]
        action: NetworthAction,
    },
    /// The selected book's profile: kind, and the multi-location override
    /// (ROADMAP.md "Phase 6" — Book profiles). Create additional books with
    /// `slipscan init --name <name> --kind business` against an existing
    /// database.
    Book {
        #[command(subcommand)]
        action: BookAction,
    },
    /// Locations (branches/warehouses/sites) within a book (Phase 6.1).
    Location {
        #[command(subcommand)]
        action: LocationAction,
    },
    /// Household members: local data describing whose money it is, never a
    /// login (see ARCHITECTURE.md "Household members & per-person
    /// attribution").
    Member {
        #[command(subcommand)]
        action: MemberAction,
    },
    /// Override (or clear) a transaction's attributed member. Metadata
    /// only — never touches amount/currency/category.
    Attribute {
        /// Transaction id.
        transaction_id: String,
        /// Member id or label; `-` clears the attribution.
        #[arg(allow_hyphen_values = true)]
        member: String,
    },
    /// Split a transaction across members. Metadata only — never touches
    /// amount/currency/category.
    Split {
        /// Transaction id.
        transaction_id: String,
        /// `member:amount_minor` pairs (member id or label), e.g.
        /// `alice:1500 bailey:1500`; must sum to the transaction's absolute
        /// amount. No pairs at all clears the split.
        shares: Vec<String>,
    },
    /// Tax rates for a book (list and configure — e.g. the generic
    /// profile's configurable standard rate).
    Tax {
        #[command(subcommand)]
        action: TaxAction,
    },
    /// Signed classification/category packs.
    Pack {
        #[command(subcommand)]
        action: PackAction,
    },
    /// Payments: watch reference codes on inbound transactions and fire
    /// signed webhooks to your endpoints (email in -> webhook out).
    Pay {
        #[command(subcommand)]
        action: PayAction,
    },
    /// Credential vault: set/replace/revoke/list. Secrets are read from a
    /// no-echo prompt (or stdin when piped) and are never displayed.
    Vault {
        #[command(subcommand)]
        action: VaultAction,
    },
    /// Device identity and accountless pairing. **Identity only — nothing
    /// syncs between devices yet** (docs/NODES.md).
    Device {
        #[command(subcommand)]
        action: DeviceAction,
    },
    /// The signed operation log: what this device would replicate, if it
    /// could. There is no transport — nothing is sent anywhere
    /// (docs/NODES.md).
    Sync {
        #[command(subcommand)]
        action: SyncAction,
    },
    /// The movable data folder: where the database and documents live, and
    /// how to move it (your folder, your cloud, your responsibility).
    Data {
        #[command(subcommand)]
        action: DataAction,
    },
    /// Run the headless server (binds 127.0.0.1 unless --lan).
    Serve {
        /// Listen address, e.g. 127.0.0.1:7151.
        #[arg(long)]
        listen: Option<SocketAddr>,
        /// Explicitly opt in to a non-loopback bind (LAN exposure).
        #[arg(long)]
        lan: bool,
        /// Serve without bearer-token auth (loopback binds only).
        #[arg(long)]
        no_auth: bool,
        /// Generate a fresh API token, invalidating the old one.
        #[arg(long)]
        reset_token: bool,
    },
    /// List entities.
    List {
        #[arg(value_enum)]
        what: ListTarget,
    },
}

#[derive(Debug, Subcommand)]
enum DataAction {
    /// Show the current data folder, its sizes, and the pointer-file path.
    Status,
    /// Move the data folder (database + documents) to a new location:
    /// copy, per-file checksum verify, open/migrate check on the copy,
    /// atomic pointer swap — the old copy is only removed after the swap
    /// is verified, so aborting at any point is safe.
    Move {
        /// Destination folder (created if missing). Refused when it is
        /// inside the current folder, not writable, or already contains a
        /// SlipScan database (open that one instead).
        target: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum ReconAction {
    /// Compute and list suggested matches.
    Suggest,
    /// Confirm a suggested match by id.
    Confirm { match_id: String },
}

#[derive(Debug, Subcommand)]
enum AccountAction {
    /// Create an account in the selected book.
    Add {
        /// Account display name, e.g. "Cheque".
        name: String,
        /// Account kind: bank, cash, card, asset or liability.
        #[arg(long, default_value = "bank")]
        kind: String,
        /// ISO-4217 currency; defaults to the book currency.
        #[arg(long)]
        currency: Option<String>,
        /// Bank/institution label.
        #[arg(long)]
        institution: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum NetworthAction {
    /// Record today's (or `--date`'s) balance for every account in the
    /// book, one snapshot each. Safe to run repeatedly — an account that
    /// already has a snapshot for that date keeps it rather than gaining a
    /// duplicate.
    Capture {
        /// `YYYY-MM-DD`; defaults to today (UTC).
        #[arg(long)]
        date: Option<String>,
    },
    /// Reconstruct historical snapshots for every account from the
    /// transaction ledger already recorded — the difference between a chart
    /// that starts today and one that is useful on day one. Safe to run
    /// repeatedly: only dates still missing a snapshot ever gain one.
    Backfill,
    /// The net-worth series over an inclusive date range: every account's
    /// balance at each point plus the total converted to the book's
    /// currency (see the command's own doc comment for the multi-currency
    /// caveat: conversion uses today's cached FX rate, not a historical
    /// one, and an unconvertible currency is excluded from the total and
    /// named rather than mis-summed).
    Series {
        /// Start date (YYYY-MM-DD), inclusive.
        #[arg(long)]
        from: String,
        /// End date (YYYY-MM-DD), inclusive.
        #[arg(long)]
        to: String,
    },
}

/// Book profile: the personal/business/multi-location disclosure rules
/// (ROADMAP.md "Phase 6" — Book profiles). Every field this resolves is a
/// display fact; core accepts contacts/catalogue/location writes on a
/// personal book regardless of what a UI currently shows.
#[derive(Debug, Subcommand)]
enum BookAction {
    /// Show the selected book's resolved profile: kind, location count,
    /// the multi-location flag, and which capability groups are visible.
    Profile,
    /// Change the book's kind later, in either direction. Downgrading only
    /// hides screens — it deletes nothing in `locations`, `contacts`,
    /// `product_categories`, `products` or `product_variants`.
    SetKind {
        #[arg(value_enum)]
        kind: CliBookKind,
    },
    /// Pin or clear the multi-location override. `auto` (the default for
    /// every book) derives the flag from the `locations` row count; `on`/
    /// `off` pin it regardless of how many locations exist.
    SetMultiLocation {
        #[arg(value_enum)]
        mode: MultiLocationMode,
    },
}

/// Locations: branches, sites and warehouses within a book (Phase 6.1).
/// Additive and optional — a book with none behaves exactly as it always
/// has; adding a second is what the multi-location flag derives from.
#[derive(Debug, Subcommand)]
enum LocationAction {
    /// Add a location to the selected book.
    Add {
        /// Location display name, e.g. "Johannesburg".
        name: String,
        /// branch (storefront/office), warehouse (bulk storage) or site
        /// (anything else).
        #[arg(long, value_enum, default_value = "branch")]
        kind: CliLocationKind,
        /// Optional short code, e.g. "JHB-01"; unique within the book when
        /// set.
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        address: Option<String>,
    },
    /// List locations in the book.
    List,
    /// Update a location's name/kind/code/address/archived state.
    Update {
        /// Location id.
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, value_enum)]
        kind: Option<CliLocationKind>,
        #[arg(long, conflicts_with = "clear_code")]
        code: Option<String>,
        /// Clear the code (as opposed to leaving it unchanged).
        #[arg(long)]
        clear_code: bool,
        #[arg(long, conflicts_with = "clear_address")]
        address: Option<String>,
        /// Clear the address (as opposed to leaving it unchanged).
        #[arg(long)]
        clear_address: bool,
        #[arg(long, conflicts_with = "unarchive")]
        archive: bool,
        #[arg(long)]
        unarchive: bool,
    },
    /// Remove a location outright. No reassignment guard yet — nothing in
    /// core references a location (see migration `0009_locations`).
    Remove {
        /// Location id.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
enum MemberAction {
    /// Add a member to the book.
    Add {
        /// Display label, e.g. "Alex".
        label: String,
        /// Short display initial; defaults to the label's first
        /// alphanumeric character, uppercased.
        #[arg(long)]
        initial: Option<String>,
        /// Cosmetic hex colour swatch; defaults to the next built-in swatch.
        #[arg(long)]
        colour: Option<String>,
        /// Account (id or exact name) this member owns by default — new
        /// transactions on it attribute to this member unless overridden.
        #[arg(long)]
        account: Option<String>,
    },
    /// List members of the book.
    List,
    /// Update a member's label/initial/colour/default account.
    Update {
        /// Member id.
        id: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        initial: Option<String>,
        #[arg(long)]
        colour: Option<String>,
        /// Set the default account (id or exact name).
        #[arg(long, conflicts_with = "clear_account")]
        account: Option<String>,
        /// Clear the default account (as opposed to leaving it unchanged).
        #[arg(long)]
        clear_account: bool,
    },
    /// Remove a member. Refused when they carry any attribution or split
    /// unless --reassign names another member to move it onto first.
    Remove {
        /// Member id.
        id: String,
        /// Move the member's attributions/splits onto this member id first.
        #[arg(long)]
        reassign: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum TaxAction {
    /// List the book's configured tax rates.
    Rates,
    /// Set a tax rate's percentage in basis points (1500 = 15.00%) — how
    /// the generic profile's standard-rate placeholder gets its actual rate.
    SetRate {
        /// Rate code, e.g. STD.
        code: String,
        /// Basis points, 0..=10000.
        rate_bps: i64,
    },
}

#[derive(Debug, Subcommand)]
enum FxAction {
    /// Show the FX configuration and locally cached rates (never a network
    /// call).
    Status,
    /// Set the OpenRate base URL; pass an empty string to clear it (FX off).
    SetUrl { url: String },
    /// Fetch and cache the current rate for a currency pair — an explicit
    /// network call to your configured OpenRate endpoint, nowhere else.
    Rate { from: String, to: String },
    /// Convert an amount (in minor units) using the locally cached rate for
    /// the pair (never a network call; fetch first with `fx rate`).
    Convert {
        from: String,
        to: String,
        #[arg(allow_negative_numbers = true)]
        amount_minor: i64,
        /// Replay at this pinned decimal rate (e.g. a previously recorded
        /// conversion's rate) instead of the current cached rate — booked
        /// conversions reproduce exactly, never re-rated.
        #[arg(long)]
        rate: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum PackAction {
    /// Verify a signed pack and install it into a book.
    Install {
        /// Path to the pack manifest JSON (the exact signed bytes).
        manifest: PathBuf,
        /// Detached ed25519 signature: hex, or @file (hex or raw 64 bytes).
        #[arg(long)]
        signature: String,
        /// Publisher verifying key: hex, or @file (hex or raw 32 bytes).
        #[arg(long)]
        public_key: String,
    },
    /// Check a pack without installing it: the signature, the signer's
    /// fingerprint, and what installing it here would actually do.
    ///
    /// Takes the same three inputs as `pack install` and accepts exactly the
    /// documents `pack install` accepts — both the current payload format and
    /// the legacy flat manifest — so a pack can never be called invalid here
    /// and then install successfully. Installs nothing and trusts nothing;
    /// this is where you read a publisher's fingerprint before deciding.
    Verify {
        /// Path to the pack document (the exact signed bytes).
        manifest: PathBuf,
        /// Detached ed25519 signature: hex, or @file (hex or raw 64 bytes).
        #[arg(long)]
        signature: String,
        /// Publisher verifying key: hex, or @file (hex or raw 32 bytes).
        #[arg(long)]
        public_key: String,
    },
    /// Install the built-in seed packs into a book: the SA pair
    /// (za-personal, za-business-vat) and the global intl-starter.
    ///
    /// Opt-in on purpose — which taxonomy a book starts from is your call,
    /// not something book creation guesses. Safe to re-run: a seed already
    /// installed is skipped, and categories you already have are adopted by
    /// (parent, name), never duplicated.
    Seed,
    /// List installed packs.
    List,
    /// Remove an installed pack's rules from a book. Categories it created
    /// stay (your history still points at them), and so does the signer pin.
    Uninstall {
        /// Pack id, e.g. `za-personal` (see `slipscan pack list`).
        pack_id: String,
    },
    /// Compare a month's spend against the installed benchmark packs —
    /// "you vs households like yours", computed entirely on this machine.
    ///
    /// A read, and only a read: benchmark packs are public files of cohort
    /// aggregates and nothing is transmitted. Contribution is not
    /// implemented at all (docs/BENCHMARKS.md).
    Benchmark {
        /// Calendar month to compare, `YYYY-MM`.
        #[arg(long)]
        period: String,
    },
    /// Manage where packs may be fetched from.
    ///
    /// There is no registry and no default source. SlipScan makes no
    /// outbound request about packs until you add one here.
    Source {
        #[command(subcommand)]
        action: PackSourceAction,
    },
    /// List what a source offers, and what installing each would do.
    ///
    /// Installs nothing. This is where you see a publisher's fingerprint —
    /// check it against their own channel before you accept it.
    Fetch {
        /// Source name (see `pack source list`).
        source: String,
    },
    /// Fetch one pack from a source and install it into a book.
    ///
    /// The signature is checked on the bytes before anything touches the
    /// database, and a signer you have never seen here is refused until you
    /// pass its fingerprint with --accept-signer. A pack id whose publisher
    /// key has changed is refused outright — there is no flag for that.
    Pull {
        /// Source name (see `pack source list`).
        source: String,
        /// Pack id, e.g. `za-personal` (see `pack fetch <source>`).
        pack_id: String,
        /// Accept this signer fingerprint on first sight (the `ab12-cd34-…`
        /// shown by `pack fetch`). Compare it against the publisher's own
        /// channel first — that comparison is what makes this mean anything.
        #[arg(long)]
        accept_signer: Option<String>,
        /// Exact document name from `pack fetch`, when a source offers more
        /// than one copy of the same pack id (two publishers, say).
        #[arg(long)]
        document: Option<String>,
    },
    /// Publish a signed pack into a folder: source — a synced folder, a USB
    /// stick, or a git checkout you then commit.
    ///
    /// Writes into a directory named for your key's fingerprint, so two
    /// publishers sharing one folder never write the same path and a
    /// file-sync service never sees a conflict.
    Publish {
        /// Folder source to write into (see `pack source list`).
        source: String,
        /// Path to the pack document (the exact signed bytes).
        manifest: PathBuf,
        /// Detached ed25519 signature: hex, or @file (hex or raw 64 bytes).
        #[arg(long)]
        signature: String,
        /// Publisher verifying key: hex, or @file (hex or raw 32 bytes).
        #[arg(long)]
        public_key: String,
    },
}

#[derive(Debug, Subcommand)]
enum PackSourceAction {
    /// Add a source. Nothing is contacted by adding one.
    ///
    /// URI forms: `file:<path>` (one pack), `folder:<path>` (a directory, a
    /// synced share, a USB stick), `git:<url>[#ref]`, or `https://<url>`.
    /// Plain `http://` is refused: the signature is what is trusted, but a
    /// plaintext fetch still tells the network which packs you run.
    Add {
        /// Short handle you will refer to it by.
        name: String,
        /// The source URI.
        uri: String,
    },
    /// Forget a source. Installed packs are untouched.
    Remove { name: String },
    /// List configured sources. Empty on a fresh install, and that is the
    /// whole privacy story: no source, no request.
    List,
}

#[derive(Debug, Subcommand)]
enum PayAction {
    /// Watch a reference code: when an inbound transaction carries it (as a
    /// whole token, case-insensitive), your webhook endpoints are notified.
    Watch {
        /// The reference code, e.g. the EFT reference you gave a customer.
        reference: String,
        /// Only match this exact amount, in minor units (e.g. cents).
        /// Requires --currency.
        #[arg(long)]
        amount: Option<i64>,
        /// ISO-4217 currency for --amount, e.g. ZAR.
        #[arg(long)]
        currency: Option<String>,
        /// Label carried in the webhook payload (e.g. "Rent July").
        #[arg(long)]
        label: Option<String>,
    },
    /// List watch codes.
    Watches,
    /// Stop watching a code by id.
    Unwatch { id: String },
    /// Webhook endpoints (add prints the signing secret exactly once).
    Endpoint {
        #[command(subcommand)]
        action: PayEndpointAction,
    },
    /// List webhook endpoints (metadata only — never secrets).
    Endpoints,
    /// List webhook deliveries: queued, delivered and failed.
    Deliveries {
        /// Only failed (abandoned) deliveries.
        #[arg(long)]
        failed: bool,
    },
    /// POST every due pending delivery to its endpoint now. Retries follow
    /// the backoff schedule; `serve` mode flushes automatically.
    Deliver,
}

#[derive(Debug, Subcommand)]
enum PayEndpointAction {
    /// Register a webhook receiver. The signing secret is generated here,
    /// stored write-only in the vault, and printed exactly once.
    Add {
        /// Receiver URL, http(s); no embedded credentials — deliveries are
        /// authenticated by the HMAC signature.
        url: String,
        /// Display label, e.g. "Shop backend".
        #[arg(long)]
        label: String,
    },
    /// Rotate an endpoint's signing secret (the new one prints exactly
    /// once; the old one stops signing immediately).
    Rotate { id: String },
    /// Remove an endpoint: its queued deliveries are dropped and its
    /// vault-held signing secret is revoked.
    Remove { id: String },
}

#[derive(Debug, Subcommand)]
enum VaultAction {
    /// Store a new credential (prompts for the secret; never echoes).
    Set {
        /// Credential name, e.g. imap.fastmail
        name: String,
    },
    /// Rotate an existing credential (prompts for the new secret).
    Replace { name: String },
    /// Destroy a credential.
    Revoke { name: String },
    /// List credential metadata (never material).
    List,
}

/// Device identity and pairing — **identity only; nothing syncs yet**
/// (docs/NODES.md).
///
/// There are no accounts: this device's ed25519 public key *is* its id, and
/// its private half lives in the write-only vault. Pairing is a local,
/// human-in-the-loop ceremony carried out of band — SlipScan opens no socket
/// to do it and there is no coordinator, directory or default endpoint.
#[derive(Debug, Subcommand)]
enum DeviceAction {
    /// Generate this device's keypair. Refused if one already exists.
    Init {
        /// Cosmetic name for this device, e.g. "laptop" or "home server".
        /// Not an identity: two devices may share a label.
        #[arg(long, default_value = "this device")]
        label: String,
    },
    /// Show this device's id and key-name (its human-comparable
    /// fingerprint) — what the other person must see match.
    Show,
    /// List paired devices, including revoked tombstones.
    List,
    /// Show the key-name of a device id (this device's, if none is given).
    Fingerprint {
        /// Device id (hex public key). Defaults to this device.
        device_id: Option<String>,
    },
    /// Mint a single-use pairing invite to carry to the other device.
    /// The printed blob contains a claim token — treat it as a credential
    /// until it is redeemed or expires.
    Invite {
        /// Cosmetic label for the device you expect to pair with.
        #[arg(long, default_value = "a device")]
        label: String,
        /// Invite lifetime in seconds.
        #[arg(long, default_value_t = DEFAULT_INVITE_TTL_SECONDS)]
        ttl: i64,
    },
    /// Redeem an invite from another device: pins it, and prints the
    /// acceptance blob to carry back.
    Accept {
        /// The `ss-pair1.…` blob from `slipscan device invite`.
        blob: String,
        /// The key-name shown on the other device. **This comparison is the
        /// authentication** — a mismatch is refused.
        #[arg(
            long,
            conflicts_with = "unverified",
            required_unless_present = "unverified"
        )]
        expect_keyname: Option<String>,
        /// Skip the key-name comparison. You are then trusting whatever the
        /// blob carried, with nothing checking it came from the right
        /// device.
        #[arg(long)]
        unverified: bool,
    },
    /// Redeem the acceptance blob that came back, completing the pairing.
    /// Burns the invite's single-use claim token.
    Confirm {
        /// The `ss-pair1.…` blob from `slipscan device accept`.
        blob: String,
        /// The key-name shown on the other device (see `accept`).
        #[arg(
            long,
            conflicts_with = "unverified",
            required_unless_present = "unverified"
        )]
        expect_keyname: Option<String>,
        /// Skip the key-name comparison (see `accept`).
        #[arg(long)]
        unverified: bool,
    },
    /// List invites this device has minted. Never shows a claim token.
    Invites,
    /// Withdraw an unredeemed invite.
    CancelInvite { id: String },
    /// Revoke a paired device. The pin becomes a tombstone, so the key
    /// cannot silently pair again.
    Revoke {
        /// Device id (hex public key).
        device_id: String,
    },
    /// Drop a device's pin entirely, tombstone included — the deliberate
    /// local reset that lets a revoked key pair again.
    Forget {
        /// Device id (hex public key).
        device_id: String,
    },
    /// Rotate this device's key. Signed by the key it replaces; the device
    /// id changes, so peers must pair again.
    Rotate,
    /// Show this device's rotation chain.
    Rotations,
    /// Destroy this device's key and identity — the deliberate local reset.
    /// Peer pins are kept; use `forget` for those.
    Reset {
        /// Required: this destroys the private key and cannot be undone.
        #[arg(long)]
        yes: bool,
    },
}

/// The signed operation log — **the record half of sync; there is no
/// transport** (docs/NODES.md).
///
/// Every change to a replicated table is captured by the database itself and
/// sealed into an operation signed with this device's key. Each op is
/// verifiable on its own, by anyone holding the author's public key, with no
/// connection and no server involved.
///
/// None of these commands sends anything anywhere. There is no endpoint to
/// configure, and a fresh install makes no outbound call — not because a
/// default is unset, but because no code exists that could make one.
#[derive(Debug, Subcommand)]
enum SyncAction {
    /// What the log holds, and what still cannot be done with it.
    Status,
    /// Sign every change captured since the last seal.
    Seal,
    /// List operations in order.
    Log {
        /// Restrict to one book (operations are namespaced per book).
        #[arg(long)]
        book: Option<String>,
        /// Show at most this many, oldest first.
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Verify every operation independently: its signature, and that the
    /// indexed columns still agree with what was signed.
    Verify,
}

fn main() -> anyhow::Result<()> {
    register_pack_classifier();
    run(Cli::parse())
}

/// Wire installed pack rules into core's categorisation, for this whole
/// process.
///
/// `slipscan_packs::register_classifier`'s own contract is "call it once at
/// startup, in every binary that imports transactions" — and this binary
/// imports transactions (`import --preset`, `watch`, `mail-sync`, `extract`).
/// Registering only inside the install path would mean a run that has not
/// installed a pack *this invocation* — i.e. essentially every run — skipped
/// every `contains`, `regex` and `keyword` rule already sitting in the
/// database. Exact rules would still fire, because installing seeds those
/// into core's own `merchant_mappings`, which made the gap quiet rather than
/// absent.
///
/// Idempotent (the first registration in a process wins) and free until a
/// book actually has pack rules. Returns whether this call registered.
fn register_pack_classifier() -> bool {
    slipscan_packs::register_classifier()
}

/// Where this invocation's data lives, resolved once per run.
struct DataEnv {
    /// The shared pointer resolver (`slipscan-core::datadir`) — the same one
    /// the server and desktop use, so every surface agrees.
    resolver: DataDirResolver,
    /// Database the commands operate on. An explicit `--db` wins; otherwise
    /// the managed data folder's `slipscan.db`.
    db: PathBuf,
    /// Documents store belonging to `db`: the managed folder's `documents/`,
    /// or `<db dir>/slipscan-documents` beside an explicit `--db`.
    docs_dir: PathBuf,
    /// Whether `db` came from the resolver (no `--db` override).
    managed: bool,
}

fn data_env(cli: &Cli) -> anyhow::Result<DataEnv> {
    let resolver = match &cli.config_dir {
        Some(dir) => DataDirResolver::new(dir.clone(), dir.join("data")),
        None => DataDirResolver::system().context("locating the platform config directory")?,
    };
    Ok(match &cli.db {
        Some(db) => DataEnv {
            resolver,
            docs_dir: default_storage_dir(db),
            db: db.clone(),
            managed: false,
        },
        None => {
            let dir = resolver.resolve()?;
            DataEnv {
                db: datadir::db_path(&dir),
                docs_dir: datadir::documents_dir(&dir),
                resolver,
                managed: true,
            }
        }
    })
}

/// Create the database's parent directory (the data folder on first run).
fn ensure_parent_dir(db: &Path) -> anyhow::Result<()> {
    if let Some(parent) = db.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating data folder {}", parent.display()))?;
    }
    Ok(())
}

fn open_service(db: &Path) -> anyhow::Result<CoreService> {
    ensure_parent_dir(db)?;
    CoreService::open(db).with_context(|| format!("opening database at {}", db.display()))
}

/// Resolve `--book` (id or exact name); with no flag, a sole book wins.
fn resolve_book(svc: &CoreService, selector: Option<&str>) -> anyhow::Result<Book> {
    let mut books = svc.book_list()?;
    match selector {
        Some(sel) => books
            .into_iter()
            .find(|b| b.id == sel || b.name == sel)
            .ok_or_else(|| anyhow!("no book with id or name {sel:?}; see `slipscan list books`")),
        None => match books.len() {
            0 => bail!("no books yet; create one with `slipscan init --name <name>`"),
            1 => Ok(books.remove(0)),
            n => bail!("{n} books exist; pick one with --book <id-or-name>"),
        },
    }
}

/// Resolve an account within `book_id` by id or exact name.
fn resolve_account(svc: &CoreService, book_id: &str, selector: &str) -> anyhow::Result<Account> {
    svc.account_list(book_id)?
        .into_iter()
        .find(|a| a.id == selector || a.name == selector)
        .ok_or_else(|| {
            anyhow!(
                "no account with id or name {selector:?} in this book; \
                 see `slipscan list accounts` or create one with `slipscan account add`"
            )
        })
}

/// Resolve a member within `book_id` by id or exact label.
fn resolve_member(svc: &CoreService, book_id: &str, selector: &str) -> anyhow::Result<Member> {
    svc.member_list(book_id)?
        .into_iter()
        .find(|m| m.id == selector || m.label == selector)
        .ok_or_else(|| {
            anyhow!(
                "no member with id or label {selector:?} in this book; \
                 see `slipscan member list` or add one with `slipscan member add`"
            )
        })
}

/// `--from`/`--to` are required for the household attribution reports
/// (`members`, `settle-up`) since their service calls take a mandatory
/// inclusive date range — every other report kind ignores them.
fn require_range<'a>(
    from: Option<&'a str>,
    to: Option<&'a str>,
) -> anyhow::Result<(&'a str, &'a str)> {
    match (from, to) {
        (Some(f), Some(t)) => Ok((f, t)),
        _ => bail!("this report needs --from and --to (YYYY-MM-DD, inclusive date range)"),
    }
}

/// Turn the CLI's `--expect-keyname` / `--unverified` pair into the core's
/// explicit check.
///
/// Clap already guarantees exactly one of them is present, so the `None`
/// arm is unreachable in practice — but it resolves to the *safe* side
/// anyway rather than silently skipping the comparison that authenticates a
/// pairing.
fn keyname_check(expect: &Option<String>, unverified: bool) -> KeynameCheck<'_> {
    match expect {
        Some(name) => KeynameCheck::Expect(name),
        None if unverified => KeynameCheck::ConfirmedByHuman,
        None => KeynameCheck::Expect(""),
    }
}

/// `pack verify --json`: the shared preflight plus the one field that is not
/// part of it. Flattened, so the pack's fields are named exactly as
/// `pack fetch --json` and the desktop's verify screen name them — a preflight
/// that reads differently per surface is how the surfaces drift apart.
#[derive(serde::Serialize)]
struct PackVerifyOutput {
    /// Always `true`: a signature that did not check out exits non-zero with
    /// the failure instead of reporting itself as a result.
    valid: bool,
    #[serde(flatten)]
    plan: ops::PackOfferPlan,
}

/// `""` or `"s"`, for a count in a sentence.
fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

/// The human name of an operation kind.
///
/// The discriminators are read from the engine rather than written out here:
/// the substrate's own adoption notes say never to hard-code them, and a
/// display helper is exactly where a stale copy would go unnoticed.
fn kind_name(kind: u8) -> &'static str {
    use slipscan_core::sync::op_kinds;
    match kind {
        k if k == op_kinds::LWW_SET => "set",
        k if k == op_kinds::SET_ADD => "add",
        _ => "?",
    }
}

fn emit<T: serde::Serialize>(
    json_mode: bool,
    value: &T,
    human: impl FnOnce(),
) -> anyhow::Result<()> {
    if json_mode {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        human();
    }
    Ok(())
}

/// Minor units → "1234.56" (sign-safe).
fn fmt_minor(minor: i64) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let abs = minor.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

/// Byte counts in human units for `data status` / `data move` output.
fn fmt_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    match bytes {
        b if b < KIB => format!("{b} B"),
        b if b < KIB * KIB => format!("{:.1} KiB", b as f64 / KIB as f64),
        b if b < KIB * KIB * KIB => format!("{:.1} MiB", b as f64 / (KIB * KIB) as f64),
        b => format!("{:.1} GiB", b as f64 / (KIB * KIB * KIB) as f64),
    }
}

/// Rate staleness in human units — a stale weekend rate must say so.
fn fmt_age(age_secs: Option<i64>) -> String {
    match age_secs {
        None => "unknown".to_string(),
        Some(s) if s < 120 => format!("{s}s"),
        Some(s) if s < 7_200 => format!("{}m", s / 60),
        Some(s) if s < 172_800 => format!("{}h", s / 3_600),
        Some(s) => format!("{}d", s / 86_400),
    }
}

/// `--signature`/`--public-key` argument: hex, or `@file` (hex text or raw
/// bytes of exactly `expected_len`).
fn read_bytes_arg(arg: &str, expected_len: usize, what: &str) -> anyhow::Result<Vec<u8>> {
    let text = match arg.strip_prefix('@') {
        Some(path) => {
            let raw = std::fs::read(path).with_context(|| format!("reading {what} {path}"))?;
            if raw.len() == expected_len {
                return Ok(raw);
            }
            String::from_utf8(raw).with_context(|| format!("{what} file is not hex text"))?
        }
        None => arg.to_string(),
    };
    let bytes = slipscan_server::hex_decode(text.trim())
        .ok_or_else(|| anyhow!("{what} is not valid hex"))?;
    if bytes.len() != expected_len {
        bail!("{what} must be {expected_len} bytes, got {}", bytes.len());
    }
    Ok(bytes)
}

/// Read secret material without ever echoing or logging it: a no-echo
/// prompt on a TTY, the first stdin line when piped. Never argv.
fn read_secret(prompt: &str) -> anyhow::Result<SecretString> {
    use std::io::{BufRead, IsTerminal};
    use zeroize::Zeroize as _;
    if std::io::stdin().is_terminal() {
        let secret = rpassword::prompt_password(prompt).context("reading secret")?;
        Ok(SecretString::new(secret))
    } else {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .context("reading secret from stdin")?;
        let trimmed = line.trim_end_matches(['\n', '\r']);
        let secret = SecretString::new(trimmed);
        // Wipe the intermediate buffer too — SecretString only zeroizes its
        // own copy of the material.
        line.zeroize();
        Ok(secret)
    }
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Runtime::new().context("starting async runtime")
}

/// Transport capabilities for one pack-source read: where git checkouts are
/// cached, and the HTTPS client.
///
/// Built **only** when a pack-source command runs, and it still reaches
/// nowhere on its own — slipscan-packs has no URL, and every request goes to
/// a base the user added with `pack source add`. Local `file:` and `folder:`
/// sources never touch either capability.
fn pack_transport_context(
    env: &DataEnv,
) -> anyhow::Result<slipscan_packs::transport::TransportContext> {
    // Cache git checkouts beside the data the user already chose to keep,
    // so "my data folder" stays the one thing to back up or delete.
    let cache = env
        .db
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let http = slipscan_ingest::packs::ReqwestPackHttp::new().map_err(|e| anyhow!(e))?;
    Ok(slipscan_packs::transport::TransportContext::new()
        .with_cache_dir(cache)
        .with_http(std::sync::Arc::new(http)))
}

/// API keys for BYO-key providers come from the credential vault — the
/// [`slipscan_extract::KeySource`] contract. Holds only the db path; a fresh
/// vault handle is opened per key use so the material's scope is one call.
struct VaultKeySource {
    db: PathBuf,
}

impl slipscan_extract::KeySource for VaultKeySource {
    fn use_key(
        &self,
        name: &str,
        consume: &mut dyn FnMut(&SecretString),
    ) -> Result<(), slipscan_extract::ExtractError> {
        let vault = VaultHandle::open(&self.db).map_err(slipscan_extract::keys::vault_error)?;
        vault
            .use_with(name, |secret| {
                consume(secret);
                Ok(())
            })
            .map_err(slipscan_extract::keys::vault_error)
    }
}

/// Instantiate a configured extraction provider by name with its default
/// config. Every provider only talks to the endpoint the user chose by
/// configuring it (BYO key / local model) — never anywhere else.
fn build_provider(
    db: &Path,
    name: &str,
) -> anyhow::Result<Box<dyn slipscan_extract::ExtractionProvider>> {
    use slipscan_extract as ext;
    use std::sync::Arc;

    let transport: Arc<dyn ext::Transport> = Arc::new(ext::ReqwestTransport::new());
    let keys: ext::SharedKeySource = Arc::new(VaultKeySource {
        db: db.to_path_buf(),
    });
    Ok(match name {
        "anthropic" => Box::new(ext::AnthropicProvider::new(
            Default::default(),
            transport,
            keys,
        )),
        "gemini" => Box::new(ext::GeminiProvider::new(
            Default::default(),
            transport,
            keys,
        )),
        "openai" => Box::new(ext::OpenAiCompatProvider::new(
            Default::default(),
            transport,
            keys,
        )),
        "ollama" => Box::new(ext::OllamaProvider::new(Default::default(), transport)),
        "heuristic" => Box::new(ext::HeuristicProvider),
        other => bail!(
            "unknown extraction provider {other:?}; expected anthropic, gemini, openai, \
             ollama or heuristic"
        ),
    })
}

fn default_storage_dir(db: &Path) -> PathBuf {
    db.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join("slipscan-documents")
}

/// The backing pieces of the credential vault the OAuth mailbox connectors
/// consume: the same envelope-encrypted store `slipscan vault set` writes to
/// and `mail-sync`'s IMAP path reads.
///
/// Returned unassembled because `Vault` borrows both: the caller builds it
/// and hands connectors a `&dyn VaultAccess`, so material only ever reaches
/// them inside `use_with`, and rotated OAuth tokens go straight back in.
fn vault_backend(db: &Path) -> anyhow::Result<(Db, Box<dyn SecretStore>)> {
    Ok((
        Db::open(db).with_context(|| format!("opening the vault in {}", db.display()))?,
        Box::new(KeyringSecretStore::default()),
    ))
}

/// Read a mailbox connector's config JSON out of the settings table. The
/// stored value carries vault entry *names*, never secret material.
fn mailbox_config<T: serde::de::DeserializeOwned>(
    svc: &CoreService,
    provider: MailProvider,
    key: &str,
    fields: &str,
) -> anyhow::Result<T> {
    let raw = svc.settings_get(key)?.ok_or_else(|| {
        anyhow!(
            "no {} mailbox configured; store a config JSON under settings key {key:?} with \
             fields {fields}",
            provider.as_str()
        )
    })?;
    serde_json::from_str(&raw).with_context(|| format!("parsing the stored {key} JSON"))
}

const GMAIL_CONFIG_FIELDS: &str = "client_id, client_secret_ref, token_ref, label_id, \
     pubsub_topic, pubsub_subscription (the *_ref fields name vault entries, never secrets)";
const GRAPH_CONFIG_FIELDS: &str =
    "client_id, tenant, folder, token_ref (token_ref names a vault entry, never a secret)";

/// A missing vault entry, explained as the command that fixes it.
fn vault_entry_hint(err: IngestError, provider: MailProvider) -> anyhow::Error {
    match err {
        IngestError::MissingCredential(name) => anyhow!(
            "missing vault entry {name:?}: store it with `slipscan vault set {name}`, or — if \
             it is the token entry — complete the grant with `slipscan mail-sync --provider \
             {} --login`",
            provider.as_str()
        ),
        other => other.into(),
    }
}

/// `mail-sync --login`: run the provider's user-initiated OAuth grant. The
/// resulting tokens are written into the vault by the flow itself — no token
/// material crosses back into this process.
///
/// Prompts go to stderr so `--json` output stays machine-readable.
fn mail_login(
    svc: &CoreService,
    db: &Path,
    provider: MailProvider,
    json: bool,
) -> anyhow::Result<()> {
    let (vault_db, keychain) = vault_backend(db)?;
    let vault = Vault::new(vault_db.conn(), &*keychain);
    let http = ReqwestHttpClient::new()?;
    let rt = runtime()?;

    let token_ref = match provider {
        MailProvider::Imap => bail!(
            "imap has no OAuth grant; store the mailbox password with \
             `slipscan vault set <password_secret_ref>`"
        ),
        MailProvider::Gmail => {
            let config: GmailConfig =
                mailbox_config(svc, provider, GMAIL_CONFIG_SETTING, GMAIL_CONFIG_FIELDS)?;
            let oauth = config.oauth();
            rt.block_on(async {
                let flow = begin_loopback_flow(&oauth).await?;
                eprintln!(
                    "Open this URL to authorize SlipScan against your own Google OAuth \
                     client:\n  {}",
                    flow.authorize_url()
                );
                eprintln!("Waiting for the redirect to {} …", flow.redirect_uri());
                flow.finish(&http, &vault, &oauth).await
            })
            .map_err(|e| vault_entry_hint(e, provider))?;
            config.token_ref
        }
        MailProvider::Graph => {
            let config: GraphConfig =
                mailbox_config(svc, provider, GRAPH_CONFIG_SETTING, GRAPH_CONFIG_FIELDS)?;
            rt.block_on(async {
                let authorization = begin_device_login(&http, &config).await?;
                eprintln!(
                    "Open {} and enter the code {} to authorize SlipScan (the code expires in \
                     {} minutes).",
                    authorization.verification_uri,
                    authorization.user_code,
                    authorization.expires_in.as_secs() / 60
                );
                finish_device_login(&http, &vault, &config, authorization).await
            })
            .map_err(|e| vault_entry_hint(e, provider))?;
            config.token_ref
        }
    };

    let out = serde_json::json!({
        "provider": provider.as_str(),
        "login": "complete",
        "token_ref": token_ref,
    });
    emit(json, &out, || {
        println!(
            "Connected. Tokens are in the vault under {token_ref:?} and are never displayed; \
             sync with `slipscan mail-sync --provider {}`.",
            provider.as_str()
        );
    })
}

/// One `watch` round (the startup scan, or one batch of filesystem events).
fn report_folder_round(
    json: bool,
    phase: &str,
    dir: &Path,
    outcome: &FolderImportOutcome,
) -> anyhow::Result<()> {
    let out = serde_json::json!({
        "phase": phase,
        "dir": dir.display().to_string(),
        "imported": outcome.imported.iter().map(|d| serde_json::json!({
            "document_id": d.id,
            "path": d.file_path,
        })).collect::<Vec<_>>(),
        "duplicates": outcome.duplicates,
        "skipped": outcome.skipped,
    });
    emit(json, &out, || {
        for doc in &outcome.imported {
            println!("imported\t{}\t{}", doc.id, doc.file_path);
        }
        println!(
            "{phase}: {} imported, {} duplicate(s), {} skipped",
            outcome.imported.len(),
            outcome.duplicates,
            outcome.skipped
        );
    })
}

fn run(cli: Cli) -> anyhow::Result<()> {
    // One resolution per run: pointer file (or `--db` override) decides where
    // the database and documents live for every command below.
    let env = data_env(&cli)?;
    match cli.command {
        Command::Init {
            ref name,
            kind,
            ref region,
            ref currency,
            seed_coa,
            list_regions,
        } => {
            if list_regions {
                // Pure data listing — no database is created or touched.
                let infos = slipscan_core::region::region_infos();
                return emit(cli.json, &infos, || {
                    for r in &infos {
                        println!(
                            "{}\t{}\tcountry {}\tcurrency {}\ttax report {}",
                            r.id,
                            r.display_name,
                            r.country.as_deref().unwrap_or("-"),
                            r.default_currency.as_deref().unwrap_or("-"),
                            r.tax_report_name
                        );
                    }
                });
            }
            let svc = open_service(&env.db)?;
            if seed_coa && name.is_none() {
                bail!("--seed-coa needs --name (a book to seed)");
            }
            let book = match name {
                Some(name) => {
                    // Default is the generic international profile — never a
                    // hardcoded jurisdiction; core rejects unknown ids. An
                    // explicit --currency overrides the profile's default so
                    // a book can be denominated in any currency, day one.
                    let book = svc.book_create(NewBook {
                        name: name.clone(),
                        kind: kind.into(),
                        currency: currency.clone(),
                        country: None,
                        region: region.clone(),
                    })?;
                    if seed_coa {
                        svc.coa_seed(&book.id)?;
                    }
                    Some(book)
                }
                None => None,
            };
            let out = serde_json::json!({
                "db": env.db.display().to_string(),
                "book": book,
                "coa_seeded": seed_coa,
            });
            emit(cli.json, &out, || {
                if let Some(book) = &book {
                    println!(
                        "Created book {} ({}) — region {}, currency {}",
                        book.name, book.id, book.region, book.currency
                    );
                    if seed_coa {
                        println!("Seeded the region profile's chart of accounts.");
                    }
                }
                println!("Database ready at {}", env.db.display());
            })
        }

        Command::Import {
            ref paths,
            ref preset,
            ref account,
            list_presets,
        } => {
            if list_presets {
                // Pure catalog data — presets are region data, not code.
                let groups = slipscan_ingest::bank::presets::statement_presets_by_region();
                return emit(cli.json, &groups, || {
                    for g in &groups {
                        println!("{} — {}", g.region, g.region_name);
                        for p in &g.presets {
                            println!("  {}\t{}", p.id, p.bank_name);
                        }
                    }
                });
            }
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            // With --preset, each CSV is parsed into transactions via the
            // preset's column mapping (in addition to being stored as a
            // statement document).
            let preset = match preset.as_deref() {
                None => None,
                Some(id) => {
                    let preset = slipscan_ingest::bank::presets::statement_preset(id)
                        .ok_or_else(|| {
                            anyhow!("unknown statement preset {id:?}; see `slipscan import --list-presets`")
                        })?;
                    let account = account.as_deref().ok_or_else(|| {
                        anyhow!(
                            "--preset needs --account <id-or-name> (create one with \
                             `slipscan account add`)"
                        )
                    })?;
                    Some((preset, resolve_account(&svc, &book.id, account)?))
                }
            };
            let mut results = Vec::new();
            for path in paths {
                let (status, id) =
                    match import_document_file(&svc, &book.id, path, DocumentSource::Upload) {
                        Ok(FileImport::Imported(doc)) => ("imported", Some(doc.id.clone())),
                        Ok(FileImport::Duplicate { existing_id }) => {
                            ("duplicate", Some(existing_id))
                        }
                        Err(IngestError::UnsupportedFile(_)) => ("unsupported", None),
                        Err(e) => return Err(e).context(format!("importing {}", path.display())),
                    };
                let statement = match &preset {
                    None => None,
                    Some((preset, account)) => {
                        let lines =
                            preset
                                .adapter_for_path(path)?
                                .parse_all()
                                .with_context(|| {
                                    format!("parsing {} with preset {}", path.display(), preset.id)
                                })?;
                        let outcome = import_statement_lines(
                            &svc,
                            &book.id,
                            &account.id,
                            TransactionSource::Import,
                            lines,
                        )?;
                        Some(serde_json::json!({
                            "preset": preset.id,
                            "account_id": account.id,
                            "transactions_imported": outcome.imported.len(),
                            "duplicates": outcome.duplicates,
                            "content_duplicates": outcome.content_duplicates,
                        }))
                    }
                };
                results.push(serde_json::json!({
                    "path": path.display().to_string(),
                    "status": status,
                    "document_id": id,
                    "statement": statement,
                }));
            }
            emit(cli.json, &results, || {
                for r in &results {
                    println!(
                        "{}\t{}\t{}",
                        r["status"].as_str().unwrap_or(""),
                        r["document_id"].as_str().unwrap_or("-"),
                        r["path"].as_str().unwrap_or("")
                    );
                    if let Some(s) = r["statement"].as_object() {
                        println!(
                            "  transactions: {} imported, {} duplicate(s) ({} ambiguous \
                             cross-batch)",
                            s["transactions_imported"], s["duplicates"], s["content_duplicates"]
                        );
                    }
                }
            })
        }

        Command::Watch { ref dir, once } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            if !dir.is_dir() {
                bail!("{} is not a folder", dir.display());
            }
            // Start watching *before* the scan so a file that lands mid-scan
            // is still seen; content-hash dedup absorbs the overlap.
            let watcher = if once {
                None
            } else {
                Some(FolderWatcher::watch(dir)?)
            };
            let scanned = scan_folder(&svc, &book.id, dir)?;
            report_folder_round(cli.json, "scan", dir, &scanned)?;
            let Some(watcher) = watcher else {
                return Ok(());
            };

            eprintln!("Watching {} — Ctrl-C to stop.", dir.display());
            loop {
                let paths = watcher.next_paths(WATCH_POLL)?;
                if paths.is_empty() {
                    continue;
                }
                let outcome = import_paths(&svc, &book.id, &paths)?;
                report_folder_round(cli.json, "watch", dir, &outcome)?;
            }
        }

        Command::Account { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                AccountAction::Add {
                    name,
                    kind,
                    currency,
                    institution,
                } => {
                    let kind: slipscan_core::domain::AccountKind = kind.parse()?;
                    // Default is the *book's* currency — profile data the
                    // user picked, never a hardcoded one.
                    let account = svc.account_create(slipscan_core::domain::NewAccount {
                        book_id: book.id.clone(),
                        name: name.clone(),
                        kind,
                        currency: currency.clone().unwrap_or_else(|| book.currency.clone()),
                        institution: institution.clone(),
                        account_number_masked: None,
                        opening_balance_minor: None,
                    })?;
                    emit(cli.json, &account, || {
                        println!(
                            "Created account {} ({}) — {} {}",
                            account.name, account.id, account.kind, account.currency
                        );
                    })
                }
            }
        }

        Command::Networth { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                NetworthAction::Capture { date } => {
                    let as_of = date.clone().unwrap_or_else(slipscan_core::util::today);
                    let snapshots = svc.networth_capture(&book.id, &as_of)?;
                    emit(cli.json, &snapshots, || {
                        println!(
                            "Captured {} account snapshot{} as of {as_of} — {}",
                            snapshots.len(),
                            plural(snapshots.len()),
                            book.name
                        );
                        for s in &snapshots {
                            println!(
                                "{}\t{} {}\t{}",
                                s.account_id,
                                fmt_minor(s.balance_minor),
                                s.currency,
                                s.source
                            );
                        }
                    })
                }
                NetworthAction::Backfill => {
                    let created = svc.networth_backfill(&book.id)?;
                    emit(cli.json, &created, || {
                        if created.is_empty() {
                            println!(
                                "Nothing to backfill — every account/date already has a snapshot."
                            );
                        } else {
                            println!(
                                "Backfilled {} snapshot{} from the transaction ledger.",
                                created.len(),
                                plural(created.len())
                            );
                        }
                    })
                }
                NetworthAction::Series { from, to } => {
                    let series = svc.networth_series(&book.id, from, to)?;
                    emit(cli.json, &series, || {
                        if series.points.is_empty() {
                            println!(
                                "No net-worth snapshots between {from} and {to}. \
                                 Run `slipscan networth capture` or `slipscan networth backfill` first."
                            );
                            return;
                        }
                        println!("Net worth — {} ({from}..{to})", book.name);
                        for p in &series.points {
                            print!(
                                "{}\t{} {}",
                                p.as_of_date,
                                fmt_minor(p.total_minor),
                                series.currency
                            );
                            if !p.unconverted.is_empty() {
                                print!(
                                    "\t(excludes {}: no cached rate)",
                                    p.unconverted.join(", ")
                                );
                            }
                            println!();
                        }
                        if !series.conversions.is_empty() {
                            println!("Converted using the cached rate (not historical):");
                            for c in &series.conversions {
                                println!(
                                    "  {}/{} = {} (as of {}, age {})",
                                    c.from_currency,
                                    c.to_currency,
                                    c.rate,
                                    c.as_of,
                                    fmt_age(c.age_secs)
                                );
                            }
                        }
                    })
                }
            }
        }

        Command::Book { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                BookAction::Profile => {
                    let profile = svc.book_profile(&book.id)?;
                    emit(cli.json, &profile, || {
                        println!("Book {} ({}) — kind {}", book.name, book.id, profile.kind);
                        println!(
                            "  locations: {} ({})",
                            profile.location_count,
                            match profile.multi_location_override {
                                Some(true) => "multi-location pinned on",
                                Some(false) => "multi-location pinned off",
                                None if profile.multi_location => "multi-location — derived",
                                None => "single-location — derived",
                            }
                        );
                        let mut groups = vec!["accounts", "transactions", "budgets", "members"];
                        if profile.show_contacts {
                            groups.push("contacts");
                        }
                        if profile.show_catalogue {
                            groups.push("catalogue");
                        }
                        if profile.show_purchasing {
                            groups.push("purchasing");
                        }
                        if profile.show_sales {
                            groups.push("sales");
                        }
                        if profile.show_locations {
                            groups.push("locations");
                        }
                        println!("  shows: {}", groups.join(", "));
                    })
                }
                BookAction::SetKind { kind } => {
                    let updated = svc.book_set_kind(&book.id, (*kind).into())?;
                    emit(cli.json, &updated, || {
                        println!("Book {} is now kind {}", updated.name, updated.kind);
                    })
                }
                BookAction::SetMultiLocation { mode } => {
                    let over = match mode {
                        MultiLocationMode::Auto => None,
                        MultiLocationMode::On => Some(true),
                        MultiLocationMode::Off => Some(false),
                    };
                    let updated = svc.book_set_multi_location_override(&book.id, over)?;
                    emit(cli.json, &updated, || {
                        println!(
                            "Book {} multi-location override: {}",
                            updated.name,
                            match updated.multi_location_override {
                                Some(true) => "on",
                                Some(false) => "off",
                                None => "auto (derived)",
                            }
                        );
                    })
                }
            }
        }

        Command::Location { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                LocationAction::Add {
                    name,
                    kind,
                    code,
                    address,
                } => {
                    let location = svc.location_create(NewLocation {
                        book_id: book.id.clone(),
                        name: name.clone(),
                        kind: Some((*kind).into()),
                        code: code.clone(),
                        address: address.clone(),
                    })?;
                    emit(cli.json, &location, || {
                        println!(
                            "Created location {} ({}) — {}",
                            location.name, location.id, location.kind
                        );
                    })
                }
                LocationAction::List => {
                    let locations = svc.location_list(&book.id)?;
                    emit(cli.json, &locations, || {
                        if locations.is_empty() {
                            println!(
                                "No locations yet. Add one with `slipscan location add <name>`."
                            );
                        }
                        for l in &locations {
                            println!(
                                "{}\t{}\t{}\t{}{}",
                                l.id,
                                l.name,
                                l.kind,
                                l.code.as_deref().unwrap_or("-"),
                                if l.is_archived { "\t(archived)" } else { "" }
                            );
                        }
                    })
                }
                LocationAction::Update {
                    id,
                    name,
                    kind,
                    code,
                    clear_code,
                    address,
                    clear_address,
                    archive,
                    unarchive,
                } => {
                    let code = if *clear_code {
                        Some(None)
                    } else {
                        code.clone().map(Some)
                    };
                    let address = if *clear_address {
                        Some(None)
                    } else {
                        address.clone().map(Some)
                    };
                    let is_archived = if *archive {
                        Some(true)
                    } else if *unarchive {
                        Some(false)
                    } else {
                        None
                    };
                    let location = svc.location_update(
                        id,
                        LocationPatch {
                            name: name.clone(),
                            kind: kind.map(Into::into),
                            code,
                            address,
                            is_archived,
                        },
                    )?;
                    emit(cli.json, &location, || {
                        println!("Updated location {} ({})", location.name, location.id);
                    })
                }
                LocationAction::Remove { id } => {
                    svc.location_delete(id)?;
                    emit(cli.json, &serde_json::json!({ "removed": id }), || {
                        println!("Removed location {id}.");
                    })
                }
            }
        }

        Command::Member { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                MemberAction::Add {
                    label,
                    initial,
                    colour,
                    account,
                } => {
                    let default_account_id = match account {
                        Some(sel) => Some(resolve_account(&svc, &book.id, sel)?.id),
                        None => None,
                    };
                    let member = svc.member_add(NewMember {
                        book_id: book.id.clone(),
                        label: label.clone(),
                        initial: initial.clone(),
                        colour: colour.clone(),
                        default_account_id,
                    })?;
                    emit(cli.json, &member, || {
                        println!(
                            "Created member {} ({}) — initial {}, colour {}{}",
                            member.label,
                            member.id,
                            member.initial,
                            member.colour,
                            match &member.default_account_id {
                                Some(id) => format!(", default account {id}"),
                                None => String::new(),
                            }
                        );
                    })
                }
                MemberAction::List => {
                    let members = svc.member_list(&book.id)?;
                    emit(cli.json, &members, || {
                        if members.is_empty() {
                            println!("No members yet. Add one with `slipscan member add <label>`.");
                        }
                        for m in &members {
                            println!(
                                "{}\t{}\t{}\t{}\t{}",
                                m.id,
                                m.label,
                                m.initial,
                                m.colour,
                                m.default_account_id.as_deref().unwrap_or("-")
                            );
                        }
                    })
                }
                MemberAction::Update {
                    id,
                    label,
                    initial,
                    colour,
                    account,
                    clear_account,
                } => {
                    let default_account_id = if *clear_account {
                        Some(None)
                    } else if let Some(sel) = account {
                        Some(Some(resolve_account(&svc, &book.id, sel)?.id))
                    } else {
                        None
                    };
                    let member = svc.member_update(
                        id,
                        MemberPatch {
                            label: label.clone(),
                            initial: initial.clone(),
                            colour: colour.clone(),
                            default_account_id,
                        },
                    )?;
                    emit(cli.json, &member, || {
                        println!("Updated member {} ({})", member.label, member.id);
                    })
                }
                MemberAction::Remove { id, reassign } => {
                    svc.member_remove(id, reassign.as_deref())?;
                    emit(
                        cli.json,
                        &serde_json::json!({ "removed": id }),
                        || match reassign {
                            Some(target) => println!(
                                "Removed member {id} — attributions/splits reassigned to \
                                 {target}."
                            ),
                            None => println!("Removed member {id}."),
                        },
                    )
                }
            }
        }

        Command::Attribute {
            ref transaction_id,
            ref member,
        } => {
            let svc = open_service(&env.db)?;
            let txn = svc.transaction_get(transaction_id)?;
            let member_id = if member == "-" {
                None
            } else {
                Some(resolve_member(&svc, &txn.book_id, member)?.id)
            };
            let updated = svc.transaction_attribute(transaction_id, member_id.as_deref())?;
            emit(cli.json, &updated, || match &updated.attributed_member_id {
                Some(id) => println!("Attributed {transaction_id} to member {id}."),
                None => println!("Cleared the attribution on {transaction_id}."),
            })
        }

        Command::Split {
            ref transaction_id,
            ref shares,
        } => {
            let svc = open_service(&env.db)?;
            let txn = svc.transaction_get(transaction_id)?;
            let mut parsed = Vec::with_capacity(shares.len());
            for raw in shares {
                let (member_sel, amount_str) = raw.split_once(':').ok_or_else(|| {
                    anyhow!("split share {raw:?} must be member:amount_minor, e.g. alice:1500")
                })?;
                let member = resolve_member(&svc, &txn.book_id, member_sel)?;
                let share_minor: i64 = amount_str
                    .parse()
                    .with_context(|| format!("parsing amount in split share {raw:?}"))?;
                parsed.push(SplitShare {
                    member_id: member.id,
                    share_minor,
                });
            }
            let splits = svc.transaction_split_set(transaction_id, parsed)?;
            emit(cli.json, &splits, || {
                if splits.is_empty() {
                    println!("Cleared the split on {transaction_id}.");
                } else {
                    println!("Split {transaction_id} across {} member(s):", splits.len());
                    for s in &splits {
                        println!("  {}\t{}", s.member_id, fmt_minor(s.share_minor));
                    }
                }
            })
        }

        Command::Tax { ref action } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            match action {
                TaxAction::Rates => {
                    let rates = svc.vat_rate_list(&book.id)?;
                    emit(cli.json, &rates, || {
                        for r in &rates {
                            println!("{}\t{}\t{} bps", r.code, r.name, r.rate_bps);
                        }
                    })
                }
                TaxAction::SetRate { code, rate_bps } => {
                    let updated = svc.vat_rate_set_bps(&book.id, code, *rate_bps)?;
                    emit(cli.json, &updated, || {
                        println!(
                            "Set {} ({}) to {} bps ({}.{:02}%)",
                            updated.code,
                            updated.name,
                            updated.rate_bps,
                            updated.rate_bps / 100,
                            updated.rate_bps % 100
                        );
                    })
                }
            }
        }

        Command::Extract { limit } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            let Some(provider_name) = svc.settings_get(EXTRACT_PROVIDER_SETTING)? else {
                bail!(
                    "no extraction provider configured; set the {EXTRACT_PROVIDER_SETTING:?} \
                     setting once a provider adapter is available (BYO key or local model — \
                     SlipScan never talks to anything you did not configure)"
                );
            };
            let provider = build_provider(&env.db, &provider_name)?;
            let outcome = runtime()?.block_on(extractor::run_extraction(
                &svc,
                provider.as_ref(),
                &book.id,
                limit,
            ))?;
            emit(cli.json, &outcome, || {
                println!(
                    "Extracted {}, failed {}, skipped {} (unsupported type).",
                    outcome.extracted.len(),
                    outcome.failed.len(),
                    outcome.skipped.len()
                );
                for f in &outcome.failed {
                    println!("failed\t{}\t{}", f.document_id, f.error);
                }
            })
        }

        Command::MailSync {
            provider,
            login,
            ref storage_dir,
            alerts,
            ref account,
        } => {
            let svc = open_service(&env.db)?;
            if login {
                return mail_login(&svc, &env.db, provider, cli.json);
            }
            let book = resolve_book(&svc, cli.book.as_deref())?;
            // Default is the unified documents store: the managed folder's
            // `documents/`, or `<db dir>/slipscan-documents` with `--db`.
            let dir = storage_dir.clone().unwrap_or_else(|| env.docs_dir.clone());
            // No sender allowlist on this surface yet: the per-mailbox filter
            // has no configuration key, so the CLI syncs the whole configured
            // folder/label (provider-side rules still apply).
            let filter = MailboxFilter::default();

            // Bank-alert parsing is opt-in and needs somewhere to book to.
            // Rules come only from installed `mailrules` packs — SlipScan
            // ships none, so this does nothing until the user installs one.
            let alert_target = match (alerts, account.as_deref()) {
                (true, Some(selector)) => {
                    let account = resolve_account(&svc, &book.id, selector)?;
                    let rules = AlertRules::load(&svc, &book.id)?;
                    if rules.is_empty() {
                        bail!(
                            "--alerts is on, but this book has no `mailrules` pack \
                             installed, so no bank-alert format is known. Install one \
                             with `slipscan pack install`; SlipScan ships no bank \
                             patterns of its own (see docs/EMAIL.md)."
                        );
                    }
                    Some((rules, account))
                }
                _ => None,
            };

            let alert_sync = alert_target.as_ref().map(|(rules, account)| AlertSync {
                rules,
                account_id: &account.id,
            });

            let rt = runtime()?;
            let synced: MailboxSyncOutcome = match provider {
                MailProvider::Imap => {
                    let config: ImapConfig = mailbox_config(
                        &svc,
                        provider,
                        MAIL_CONFIG_SETTING,
                        "host, port, folder, username, password_secret_ref (the name of a \
                         vault credential)",
                    )?;
                    let vault = VaultHandle::open(&env.db)?;
                    let password = vault
                        .use_with(&config.password_secret_ref, |secret| {
                            Ok(SecretString::new(secret.expose_secret()))
                        })
                        .with_context(|| {
                            format!(
                                "loading vault credential {0:?} (store it with \
                                 `slipscan vault set {0}`)",
                                config.password_secret_ref
                            )
                        })?;
                    drop(vault);
                    let synced = rt.block_on(async {
                        let transport = connect_tls(&config, &password).await?;
                        let cursors = SettingsCursorStore::new(&svc);
                        let mut connector = ImapConnector::new(config.clone(), transport, cursors);
                        sync_mailbox_with_alerts(
                            &mut connector,
                            &svc,
                            &book.id,
                            &dir,
                            &filter,
                            alert_sync,
                        )
                        .await
                    })?;
                    drop(password);
                    synced
                }
                MailProvider::Gmail => {
                    let config: GmailConfig =
                        mailbox_config(&svc, provider, GMAIL_CONFIG_SETTING, GMAIL_CONFIG_FIELDS)?;
                    let (vault_db, keychain) = vault_backend(&env.db)?;
                    let vault = Vault::new(vault_db.conn(), &*keychain);
                    let mut cursors = SettingsCursorStore::new(&svc);
                    let mut connector = GmailConnector::new(
                        config,
                        ReqwestHttpClient::new()?,
                        &mut cursors,
                        &vault,
                    );
                    rt.block_on(sync_mailbox_with_alerts(
                        &mut connector,
                        &svc,
                        &book.id,
                        &dir,
                        &filter,
                        alert_sync,
                    ))
                    .map_err(|e| vault_entry_hint(e, provider))?
                }
                MailProvider::Graph => {
                    let config: GraphConfig =
                        mailbox_config(&svc, provider, GRAPH_CONFIG_SETTING, GRAPH_CONFIG_FIELDS)?;
                    let (vault_db, keychain) = vault_backend(&env.db)?;
                    let vault = Vault::new(vault_db.conn(), &*keychain);
                    let mut cursors = SettingsCursorStore::new(&svc);
                    let mut connector = GraphConnector::new(
                        config,
                        ReqwestHttpClient::new()?,
                        &mut cursors,
                        &vault,
                    );
                    rt.block_on(sync_mailbox_with_alerts(
                        &mut connector,
                        &svc,
                        &book.id,
                        &dir,
                        &filter,
                        alert_sync,
                    ))
                    .map_err(|e| vault_entry_hint(e, provider))?
                }
            };
            let (fetched, imported, duplicates) = (
                synced.messages_seen,
                synced.documents.len(),
                synced.duplicates,
            );

            // Email in -> webhook out in one command: flush any due payment
            // deliveries the sync's ingestion enqueued (or that were already
            // waiting on their backoff). With nothing due this POSTs nowhere
            // — and when it does POST, only to the webhook endpoint URLs the
            // user registered.
            let webhook_transport = slipscan_ingest::pay::ReqwestWebhookTransport::new()?;
            let webhooks = rt.block_on(
                svc.pay_deliver_due(&webhook_transport, &slipscan_core::util::now_iso()),
            )?;
            let webhooks_delivered = webhooks
                .iter()
                .filter(|d| d.state == PayDeliveryState::Delivered)
                .count();

            // Bank alerts. Declines are reported, never swallowed: a rule
            // that claimed a message and then could not read it is the pack
            // author's bug, and silence would hide it.
            let declines: Vec<serde_json::Value> = synced
                .alert_declines
                .iter()
                .map(|(message_id, decline)| {
                    serde_json::json!({
                        "message": message_id,
                        "reason": decline.to_string(),
                    })
                })
                .collect();

            let out = serde_json::json!({
                "provider": provider.as_str(),
                "messages": fetched,
                "documents_imported": imported,
                "duplicates": duplicates,
                "storage_dir": dir.display().to_string(),
                "alerts_enabled": alert_target.is_some(),
                "transactions_imported": synced.transactions.len(),
                "transaction_duplicates": synced.transaction_duplicates,
                "alerts_declined": declines,
                "webhooks_attempted": webhooks.len(),
                "webhooks_delivered": webhooks_delivered,
            });
            emit(cli.json, &out, || {
                println!(
                    "Fetched {fetched} message(s) over {}: {imported} document(s) imported, \
                     {duplicates} duplicate(s).",
                    provider.as_str()
                );
                if let Some((rules, account)) = &alert_target {
                    println!(
                        "Bank alerts ({} rule(s)) -> {}: {} transaction(s) imported, \
                         {} duplicate(s).",
                        rules.rule_count(),
                        account.name,
                        synced.transactions.len(),
                        synced.transaction_duplicates,
                    );
                    for (message_id, decline) in &synced.alert_declines {
                        println!("declined\tmessage {message_id}\t{decline}");
                    }
                }
                if !webhooks.is_empty() {
                    println!(
                        "Webhooks: {webhooks_delivered} of {} due delivery(ies) delivered \
                         (the rest follow the retry schedule; see `slipscan pay deliveries`).",
                        webhooks.len()
                    );
                }
            })
        }

        Command::Recon { ref action } => {
            let svc = open_service(&env.db)?;
            match action {
                ReconAction::Suggest => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let matches = svc.recon_suggest(&book.id)?;
                    emit(cli.json, &matches, || {
                        if matches.is_empty() {
                            println!("No suggested matches.");
                        }
                        for m in &matches {
                            println!(
                                "{}\ttxn {}\tdoc {}\tconfidence {:.2}",
                                m.id,
                                m.transaction_id,
                                m.document_id.as_deref().unwrap_or("-"),
                                m.confidence
                            );
                        }
                    })
                }
                ReconAction::Confirm { match_id } => {
                    let confirmed = svc.recon_confirm(match_id)?;
                    emit(cli.json, &confirmed, || {
                        println!("Confirmed match {}", confirmed.id);
                    })
                }
            }
        }

        Command::Report {
            kind,
            csv,
            ref from,
            ref to,
        } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            if csv && !matches!(kind, ReportKind::Tb) {
                bail!("--csv is currently only supported for the trial balance (tb)");
            }
            match kind {
                ReportKind::Tb => {
                    let rows = svc.report_trial_balance(&book.id)?;
                    if csv {
                        print!("{}", slipscan_core::csv::trial_balance_csv(&rows));
                        return Ok(());
                    }
                    emit(cli.json, &rows, || {
                        println!("Trial balance — {}", book.name);
                        for r in &rows {
                            println!(
                                "{}\t{}\t{}\t{}\t{}",
                                r.code,
                                r.name,
                                r.currency,
                                fmt_minor(r.debit_minor),
                                fmt_minor(r.credit_minor)
                            );
                        }
                        // Totals per currency — sums never mix currencies.
                        let mut totals: std::collections::BTreeMap<&str, (i64, i64)> =
                            std::collections::BTreeMap::new();
                        for r in &rows {
                            let entry = totals.entry(r.currency.as_str()).or_insert((0, 0));
                            entry.0 += r.debit_minor;
                            entry.1 += r.credit_minor;
                        }
                        for (currency, (d, c)) in totals {
                            println!("TOTAL\t\t{currency}\t{}\t{}", fmt_minor(d), fmt_minor(c));
                        }
                    })
                }
                ReportKind::Pl => {
                    let pl = ops::report_profit_loss(&svc, &book.id)?;
                    emit(cli.json, &pl, || {
                        println!("Profit & loss — {}", book.name);
                        for r in &pl.income {
                            println!(
                                "income\t{}\t{}\t{}",
                                r.code,
                                r.name,
                                fmt_minor(r.amount_minor)
                            );
                        }
                        for r in &pl.expenses {
                            println!(
                                "expense\t{}\t{}\t{}",
                                r.code,
                                r.name,
                                fmt_minor(r.amount_minor)
                            );
                        }
                        println!("Income total\t{}", fmt_minor(pl.income_total_minor));
                        println!("Expense total\t{}", fmt_minor(pl.expense_total_minor));
                        println!("Net profit\t{}", fmt_minor(pl.net_profit_minor));
                    })
                }
                ReportKind::Bs => {
                    let bs = ops::report_balance_sheet(&svc, &book.id)?;
                    emit(cli.json, &bs, || {
                        println!("Balance sheet — {}", book.name);
                        for (section, rows) in [
                            ("asset", &bs.assets),
                            ("liability", &bs.liabilities),
                            ("equity", &bs.equity),
                        ] {
                            for r in rows {
                                println!(
                                    "{section}\t{}\t{}\t{}",
                                    r.code,
                                    r.name,
                                    fmt_minor(r.amount_minor)
                                );
                            }
                        }
                        println!("Assets\t{}", fmt_minor(bs.assets_total_minor));
                        println!("Liabilities\t{}", fmt_minor(bs.liabilities_total_minor));
                        println!("Equity\t{}", fmt_minor(bs.equity_total_minor));
                        println!(
                            "Retained earnings\t{}",
                            fmt_minor(bs.retained_earnings_minor)
                        );
                        println!("Balanced\t{}", bs.balanced);
                    })
                }
                ReportKind::Tax => {
                    let tax = ops::report_tax(&svc, &book.id)?;
                    emit(cli.json, &tax, || {
                        // The report is named by the book's region profile
                        // ("VAT201" in South Africa, "Tax summary" generically).
                        println!("{} — {}", tax.report_name, book.name);
                        for r in &tax.rates {
                            println!("rate\t{}\t{}\t{} bps", r.code, r.name, r.rate_bps);
                        }
                        for a in &tax.accounts {
                            println!(
                                "account\t{}\t{}\t{}\t{}",
                                a.code,
                                a.name,
                                fmt_minor(a.debit_minor),
                                fmt_minor(a.credit_minor)
                            );
                        }
                        println!("Net tax position\t{}", fmt_minor(tax.net_minor));
                    })
                }
                ReportKind::Members => {
                    let (from, to) = require_range(from.as_deref(), to.as_deref())?;
                    let expense = svc.report_member_expense(&book.id, from, to)?;
                    let contribution = svc.report_member_contribution(&book.id, from, to)?;
                    let out = serde_json::json!({
                        "expense": expense,
                        "contribution": contribution,
                    });
                    emit(cli.json, &out, || {
                        println!(
                            "Member expense & contribution — {} ({from}..{to})",
                            book.name
                        );
                        println!("Expense:");
                        for r in &expense {
                            println!(
                                "  {}\t{}\t{}",
                                r.member_label,
                                r.currency,
                                fmt_minor(r.total_minor)
                            );
                        }
                        println!("Contribution:");
                        for r in &contribution {
                            println!(
                                "  {}\t{}\t{}",
                                r.member_label,
                                r.currency,
                                fmt_minor(r.total_minor)
                            );
                        }
                    })
                }
                ReportKind::SettleUp => {
                    let (from, to) = require_range(from.as_deref(), to.as_deref())?;
                    let rows = svc.report_settle_up(&book.id, from, to)?;
                    emit(cli.json, &rows, || {
                        println!("Settle-up — {} ({from}..{to})", book.name);
                        for r in &rows {
                            println!(
                                "{}\t{}\tcontrib {}\texpense {}\tnet {}",
                                r.member_label,
                                r.currency,
                                fmt_minor(r.contributions_minor),
                                fmt_minor(r.expenses_minor),
                                fmt_minor(r.net_minor)
                            );
                        }
                    })
                }
            }
        }

        Command::Fx { ref action } => {
            let svc = open_service(&env.db)?;
            match action {
                FxAction::Status => {
                    let status = svc.fx_status()?;
                    emit(cli.json, &status, || {
                        match status.base_url.as_deref() {
                            Some(url) => println!("OpenRate endpoint: {url}"),
                            None => println!(
                                "FX is off: no OpenRate endpoint configured \
                                 (set one with `slipscan fx set-url <URL>`)."
                            ),
                        }
                        if status.cached_rates.is_empty() {
                            println!("No cached rates.");
                        }
                        for r in &status.cached_rates {
                            println!(
                                "{}/{}\t{}\tas of {}\tgrade {}\tfetched {}\tage {}",
                                r.from_currency,
                                r.to_currency,
                                r.rate,
                                r.as_of,
                                r.grade,
                                r.fetched_at,
                                fmt_age(r.age_secs)
                            );
                        }
                    })
                }
                FxAction::SetUrl { url } => {
                    svc.fx_configure(url)?;
                    let cleared = url.trim().is_empty();
                    let status = svc.fx_status()?;
                    emit(cli.json, &status, || {
                        if cleared {
                            println!("FX turned off: OpenRate endpoint cleared.");
                        } else {
                            println!(
                                "OpenRate endpoint set to {} — rates are only ever fetched \
                                 when you ask (fx rate).",
                                status.base_url.as_deref().unwrap_or("")
                            );
                        }
                    })
                }
                FxAction::Rate { from, to } => {
                    // The one FX path that talks to the network — explicitly
                    // requested here, and only to the configured endpoint.
                    let transport = slipscan_ingest::fx::ReqwestFxTransport::new()?;
                    let quote = runtime()?.block_on(svc.fx_fetch_rate(&transport, from, to))?;
                    emit(cli.json, &quote, || {
                        println!(
                            "{}/{} = {} (as of {}, grade {}, age {}, sources: {})",
                            quote.from_currency,
                            quote.to_currency,
                            quote.rate,
                            quote.as_of,
                            quote.grade,
                            fmt_age(quote.age_sec),
                            if quote.sources.is_empty() {
                                "-".to_string()
                            } else {
                                quote.sources.join(", ")
                            }
                        );
                    })
                }
                FxAction::Convert {
                    from,
                    to,
                    amount_minor,
                    rate,
                } => {
                    let conversion = match rate.as_deref() {
                        // Pinned-rate replay: a booked conversion reproduces
                        // exactly, no matter how the cache moved since.
                        Some(rate) => svc.fx_convert_at(from, to, *amount_minor, rate)?,
                        None => svc.fx_convert(from, to, *amount_minor)?,
                    };
                    emit(cli.json, &conversion, || {
                        println!(
                            "{} {} = {} {} (rate {} as of {}, grade {}, age {})",
                            fmt_minor(conversion.amount_minor),
                            conversion.from_currency,
                            fmt_minor(conversion.converted_minor),
                            conversion.to_currency,
                            conversion.rate,
                            if conversion.as_of.is_empty() {
                                "-"
                            } else {
                                &conversion.as_of
                            },
                            conversion.grade,
                            fmt_age(conversion.age_secs)
                        );
                    })
                }
            }
        }

        Command::Pack { ref action } => {
            let svc = open_service(&env.db)?;
            match action {
                PackAction::Install {
                    manifest,
                    signature,
                    public_key,
                } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let bytes = std::fs::read(manifest)
                        .with_context(|| format!("reading {}", manifest.display()))?;
                    let sig = read_bytes_arg(signature, 64, "signature")?;
                    let key = read_bytes_arg(public_key, 32, "public key")?;
                    let result = ops::pack_install(&svc, &book.id, &bytes, &sig, &key)?;
                    emit(cli.json, &result, || {
                        println!(
                            "Installed {} {} into {}: {} categories created, {} reused, {} rules",
                            result.name,
                            result.version,
                            book.name,
                            result.categories_created,
                            result.categories_existing,
                            result.rules
                        );
                    })
                }
                PackAction::Verify {
                    manifest,
                    signature,
                    public_key,
                } => {
                    // Verify answers "what would `install` do here", so it
                    // takes the same three inputs, resolves a book the same
                    // way, and — this being the whole point — decides what a
                    // pack *is* with the same code: `plan_document` starts at
                    // the `verify_detached` the installer starts at, so the
                    // set of documents this accepts is by construction the set
                    // `pack install` accepts. It used to parse the file itself
                    // (`verify_pack`, legacy shape only) and so rejected
                    // current-format packs it would then install happily.
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let bytes = std::fs::read(manifest)
                        .with_context(|| format!("reading {}", manifest.display()))?;
                    let sig = read_bytes_arg(signature, 64, "signature")?;
                    let key = read_bytes_arg(public_key, 32, "public key")?;
                    let plan = svc
                        .with_connection(|conn| {
                            slipscan_packs::plan_document(conn, &book.id, &bytes, &sig, &key)
                        })
                        .context("pack verification failed")?;
                    // Reported in the shape `pack fetch` and the desktop's
                    // verify screen already use, so one pack reads the same
                    // whichever surface you ask.
                    let out = PackVerifyOutput {
                        valid: true,
                        plan: plan.into(),
                    };
                    emit(cli.json, &out, || {
                        let plan = &out.plan;
                        fn plural(count: u32, one: &str, many: &str) -> String {
                            format!("{count} {}", if count == 1 { one } else { many })
                        }
                        println!(
                            "Signature valid over the exact {} bytes of {}.",
                            bytes.len(),
                            manifest.display()
                        );
                        println!(
                            "  pack       {} {} ({}, {})",
                            plan.pack_id,
                            plan.version,
                            plan.kind,
                            plan.region.as_deref().unwrap_or("global"),
                        );
                        println!(
                            "  name       {}{}",
                            plan.name,
                            plan.author
                                .as_deref()
                                .map(|a| format!(" — by {a}"))
                                .unwrap_or_default(),
                        );
                        println!(
                            "  contents   {}, {}, {}",
                            plural(plan.categories, "category", "categories"),
                            plural(plan.merchant_rules, "merchant rule", "merchant rules"),
                            plural(plan.keyword_rules, "keyword rule", "keyword rules"),
                        );
                        // The fingerprint, and whether it means anything here
                        // yet. These are the lines the command exists for.
                        let conflicting_pin = plan
                            .pinned_fingerprint
                            .as_deref()
                            .filter(|pinned| *pinned != plan.signer_fingerprint);
                        if let Some(pinned) = conflicting_pin {
                            // The pack id belongs to another key. No amount of
                            // out-of-band checking of *this* fingerprint helps,
                            // so do not invite the user to do any: say whose
                            // pack id it is, and stop.
                            println!(
                                "  signer     {} — NOT the key this pack id belongs to",
                                plan.signer_fingerprint
                            );
                            println!(
                                "  pack id    {} is pinned to {pinned}. A publisher key change is \
                                 a refusal,",
                                plan.pack_id
                            );
                            println!(
                                "             never a silent re-pin, and no flag on any surface \
                                 overrides it."
                            );
                        } else {
                            match plan.trusted_as.as_deref() {
                                Some(label) => println!(
                                    "  signer     {} — trusted here as {label:?}",
                                    plan.signer_fingerprint
                                ),
                                None => {
                                    println!(
                                        "  signer     {} — NEW SIGNER, no key like this is \
                                         trusted on this machine",
                                        plan.signer_fingerprint
                                    );
                                    println!(
                                        "             Compare it against the publisher's own \
                                         channel first: passing"
                                    );
                                    println!(
                                        "             --public-key to `pack install` IS the trust \
                                         decision. (A pack"
                                    );
                                    println!(
                                        "             pulled from a source is stricter — it \
                                         refuses until you pass"
                                    );
                                    println!(
                                        "             --accept-signer {}.)",
                                        plan.signer_fingerprint
                                    );
                                }
                            }
                            if plan.pinned_fingerprint.is_some() {
                                println!("  pack id    pinned to this signer already");
                            } else {
                                println!(
                                    "  pack id    not pinned yet — installing binds {} to this \
                                     key; a later",
                                    plan.pack_id
                                );
                                println!(
                                    "             version signed by any other key is refused, \
                                     with no override."
                                );
                            }
                        }
                        match plan.refusal.as_deref() {
                            Some(why) => println!("  install    WOULD REFUSE: {why}"),
                            None => println!(
                                "  install    would {} into {}{}",
                                plan.action,
                                book.name,
                                plan.installed_version
                                    .as_deref()
                                    .map(|v| format!(" (over {v})"))
                                    .unwrap_or_else(|| " (nothing installed there yet)".into()),
                            ),
                        }
                    })
                }
                PackAction::Seed => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let installed = ops::pack_install_seeds(&svc, &book.id)?;
                    emit(cli.json, &installed, || {
                        if installed.is_empty() {
                            println!("Seed packs already installed in {}.", book.name);
                        }
                        for result in &installed {
                            println!(
                                "Installed {} {} into {}: {} categories created, {} reused, {} rules",
                                result.name,
                                result.version,
                                book.name,
                                result.categories_created,
                                result.categories_existing,
                                result.rules
                            );
                        }
                    })
                }
                PackAction::Uninstall { pack_id } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let removed = ops::pack_uninstall(&svc, &book.id, pack_id)?;
                    emit(
                        cli.json,
                        &serde_json::json!({ "pack_id": pack_id, "removed": removed }),
                        || {
                            if removed {
                                println!(
                                    "Removed {} from {}. Categories it created were kept.",
                                    pack_id, book.name
                                );
                            } else {
                                println!("{} is not installed in {}.", pack_id, book.name);
                            }
                        },
                    )
                }
                PackAction::Benchmark { period } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let reports = ops::pack_benchmark(&svc, &book.id, period)?;
                    emit(cli.json, &reports, || {
                        if reports.is_empty() {
                            println!(
                                "No benchmark packs installed in {}. Install one with \
                                 `slipscan pack install`.",
                                book.name
                            );
                        }
                        for report in &reports {
                            println!(
                                "{} — {} household {} band {}, {} ({} contributions minimum)",
                                report.pack_id,
                                report.cohort.region,
                                report.cohort.household_size,
                                report.cohort.income_band,
                                report.currency,
                                report.k_floor
                            );
                            if let Some(reason) = &report.skipped {
                                println!("  not compared: {reason}");
                                continue;
                            }
                            if report.comparisons.is_empty() {
                                println!("  no stats for {period}.");
                            }
                            for c in &report.comparisons {
                                let position = match c.position {
                                    slipscan_packs::QuartilePosition::BelowP25 => "below p25",
                                    slipscan_packs::QuartilePosition::Typical => "typical",
                                    slipscan_packs::QuartilePosition::AboveP75 => "above p75",
                                };
                                println!(
                                    "  {}\tyou {}\tmedian {}\t{:+}\t{}\t(n={})",
                                    c.category_key,
                                    c.yours_minor,
                                    c.median_minor,
                                    c.delta_minor,
                                    position,
                                    c.sample_size
                                );
                            }
                            if !report.unmapped_keys.is_empty() {
                                println!(
                                    "  no local category for: {}",
                                    report.unmapped_keys.join(", ")
                                );
                            }
                        }
                    })
                }
                PackAction::List => {
                    let installed = ops::pack_list(&svc)?;
                    emit(cli.json, &installed, || {
                        if installed.is_empty() {
                            println!("No packs installed.");
                        }
                        for entry in &installed {
                            println!(
                                "{}\t{}\t{}\tbook {}\tinstalled {}",
                                entry.manifest.id,
                                entry.manifest.name,
                                entry.manifest.version,
                                entry.book_id,
                                entry.installed_at
                            );
                        }
                    })
                }

                // -- pack sources: the fetch half (docs/PACKS.md) ----------
                //
                // No source exists until one is added here. `fetch` reads and
                // shows; `pull` verifies then installs; nothing between them
                // can skip a gate, because both go through the one
                // `slipscan_packs::transport` path.
                PackAction::Source { action } => match action {
                    PackSourceAction::Add { name, uri } => {
                        let added = ops::pack_source_add(&svc, name, uri)?;
                        emit(cli.json, &added, || {
                            println!(
                                "Added pack source {} -> {} ({}). {}",
                                added.name,
                                added.uri,
                                added.kind,
                                if added.network {
                                    "Nothing has been contacted; it is read when you \
                                     run `pack fetch`."
                                } else {
                                    "Local only — nothing here touches a network."
                                }
                            );
                        })
                    }
                    PackSourceAction::Remove { name } => {
                        let removed = ops::pack_source_remove(&svc, name)?;
                        emit(
                            cli.json,
                            &serde_json::json!({ "name": name, "removed": removed }),
                            || {
                                if removed {
                                    println!(
                                        "Removed pack source {name}. Installed packs are \
                                         untouched."
                                    );
                                } else {
                                    println!("No pack source named {name}.");
                                }
                            },
                        )
                    }
                    PackSourceAction::List => {
                        let sources = ops::pack_source_list(&svc)?;
                        emit(cli.json, &sources, || {
                            if sources.is_empty() {
                                println!(
                                    "No pack sources configured — SlipScan makes no outbound \
                                     request about packs. Add one with \
                                     `slipscan pack source add <name> <uri>`."
                                );
                            }
                            for source in &sources {
                                println!(
                                    "{}\t{}\t{}\tadded {}\tlast read {}",
                                    source.name,
                                    source.uri,
                                    if source.network { "network" } else { "local" },
                                    source.added_at,
                                    source.last_synced_at.as_deref().unwrap_or("never"),
                                );
                            }
                        })
                    }
                },
                PackAction::Fetch { source } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let ctx = pack_transport_context(&env)?;
                    let offers = ops::pack_source_fetch(&svc, &book.id, source, &ctx)?;
                    emit(cli.json, &offers, || {
                        if offers.is_empty() {
                            println!("{source} offers no packs.");
                        }
                        for offer in &offers {
                            match (&offer.verified, &offer.error) {
                                (Some(plan), _) => {
                                    println!(
                                        "{}\t{}\t{}\t{}\tsigner {}\t{}",
                                        plan.pack_id,
                                        plan.version,
                                        plan.kind,
                                        plan.region.as_deref().unwrap_or("global"),
                                        plan.signer_fingerprint,
                                        match plan.trusted_as.as_deref() {
                                            Some(label) => format!("trusted as {label}"),
                                            None => "NEW SIGNER — check this fingerprint \
                                                     out-of-band"
                                                .to_string(),
                                        },
                                    );
                                    match plan.refusal.as_deref() {
                                        Some(why) => println!("  would refuse: {why}"),
                                        None => println!(
                                            "  would {}{}: {} categories, {} merchant rules, \
                                             {} keyword rules",
                                            plan.action,
                                            plan.installed_version
                                                .as_deref()
                                                .map(|v| format!(" from {v}"))
                                                .unwrap_or_default(),
                                            plan.categories,
                                            plan.merchant_rules,
                                            plan.keyword_rules,
                                        ),
                                    }
                                }
                                // One unreadable file must not hide the rest
                                // of a shared folder.
                                (None, Some(err)) => println!(
                                    "{}\t{}\tUNVERIFIED ({}): {err}",
                                    offer.pack_id, offer.version, offer.document
                                ),
                                (None, None) => {}
                            }
                        }
                    })
                }
                PackAction::Pull {
                    source,
                    pack_id,
                    accept_signer,
                    document,
                } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let ctx = pack_transport_context(&env)?;
                    let result = ops::pack_source_install(
                        &svc,
                        &book.id,
                        source,
                        pack_id,
                        document.as_deref(),
                        accept_signer.as_deref(),
                        &ctx,
                    )?;
                    emit(cli.json, &result, || {
                        println!(
                            "Installed {} {} from {} into {}: {} categories created, \
                             {} reused, {} rules",
                            result.name,
                            result.version,
                            source,
                            book.name,
                            result.categories_created,
                            result.categories_existing,
                            result.rules
                        );
                    })
                }
                PackAction::Publish {
                    source,
                    manifest,
                    signature,
                    public_key,
                } => {
                    let bytes = std::fs::read(manifest)
                        .with_context(|| format!("reading {}", manifest.display()))?;
                    let sig = read_bytes_arg(signature, 64, "signature")?;
                    let key = read_bytes_arg(public_key, 32, "public key")?;
                    let report = ops::pack_source_publish(&svc, source, &bytes, &sig, &key)?;
                    emit(cli.json, &report, || {
                        if report.unchanged {
                            println!(
                                "{} {} is already published to {} under {} — identical bytes, \
                                 nothing rewritten.",
                                report.pack_id, report.version, report.source, report.fingerprint
                            );
                        } else {
                            println!(
                                "Published {} {} to {} under {}:",
                                report.pack_id, report.version, report.source, report.fingerprint
                            );
                        }
                        for path in &report.written {
                            println!("  {path}");
                        }
                    })
                }
            }
        }

        Command::Pay { ref action } => {
            let svc = open_service(&env.db)?;
            match action {
                PayAction::Watch {
                    reference,
                    amount,
                    currency,
                    label,
                } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let watch = svc.pay_watch_add(NewPayWatch {
                        book_id: book.id.clone(),
                        code: reference.clone(),
                        label: label.clone(),
                        expected_amount_minor: *amount,
                        expected_currency: currency.clone(),
                    })?;
                    emit(cli.json, &watch, || {
                        let filter = match (&watch.expected_amount_minor, &watch.expected_currency)
                        {
                            (Some(minor), Some(cur)) => {
                                format!(" for exactly {} {cur}", fmt_minor(*minor))
                            }
                            _ => String::new(),
                        };
                        println!(
                            "Watching {}{filter} (id {}) — a matching inbound transaction \
                             fires your webhook endpoints.",
                            watch.code, watch.id
                        );
                    })
                }
                PayAction::Watches => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let watches = svc.pay_watch_list(&book.id)?;
                    emit(cli.json, &watches, || {
                        if watches.is_empty() {
                            println!("No watch codes. Add one with `slipscan pay watch <ref>`.");
                        }
                        for w in &watches {
                            let amount = match (&w.expected_amount_minor, &w.expected_currency) {
                                (Some(minor), Some(cur)) => format!("{} {cur}", fmt_minor(*minor)),
                                _ => "any amount".to_string(),
                            };
                            println!(
                                "{}\t{}\t{}\t{}\t{}",
                                w.id,
                                w.code,
                                w.label.as_deref().unwrap_or("-"),
                                amount,
                                if w.enabled { "enabled" } else { "disabled" }
                            );
                        }
                    })
                }
                PayAction::Unwatch { id } => {
                    svc.pay_watch_remove(id)?;
                    emit(cli.json, &serde_json::json!({ "removed": id }), || {
                        println!("Stopped watching (removed {id}).");
                    })
                }
                PayAction::Endpoint {
                    action: PayEndpointAction::Add { url, label },
                } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let created = svc.pay_endpoint_add(NewPayEndpoint {
                        book_id: book.id.clone(),
                        label: label.clone(),
                        url: url.clone(),
                    })?;
                    // The one sanctioned display of the signing secret: the
                    // JSON body in --json mode, print_endpoint_secret's
                    // stdout line otherwise. Never stored displayable again.
                    emit(cli.json, &created, || print_endpoint_secret(&created))
                }
                PayAction::Endpoint {
                    action: PayEndpointAction::Rotate { id },
                } => {
                    let rotated = svc.pay_endpoint_rotate_secret(id)?;
                    emit(cli.json, &rotated, || {
                        eprintln!("Rotated the signing secret; the old one no longer signs.");
                        print_endpoint_secret(&rotated);
                    })
                }
                PayAction::Endpoint {
                    action: PayEndpointAction::Remove { id },
                } => {
                    svc.pay_endpoint_remove(id)?;
                    emit(cli.json, &serde_json::json!({ "removed": id }), || {
                        println!(
                            "Removed endpoint {id}: queued deliveries dropped, signing \
                             secret revoked."
                        );
                    })
                }
                PayAction::Endpoints => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let endpoints = svc.pay_endpoint_list(&book.id)?;
                    emit(cli.json, &endpoints, || {
                        if endpoints.is_empty() {
                            println!(
                                "No webhook endpoints. Add one with \
                                 `slipscan pay endpoint add <url> --label <label>`."
                            );
                        }
                        for e in &endpoints {
                            println!(
                                "{}\t{}\t{}\t{}",
                                e.id,
                                e.label,
                                e.url,
                                if e.enabled { "enabled" } else { "disabled" }
                            );
                        }
                    })
                }
                PayAction::Deliveries { failed } => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let mut deliveries = svc.pay_delivery_list(&book.id)?;
                    if *failed {
                        deliveries.retain(|d| d.state == PayDeliveryState::Failed);
                    }
                    emit(cli.json, &deliveries, || {
                        if deliveries.is_empty() {
                            println!("No deliveries.");
                        }
                        for d in &deliveries {
                            println!(
                                "{}\t{}\tattempts {}\tendpoint {}\tnext {}\t{}",
                                d.id,
                                d.state,
                                d.attempts,
                                d.endpoint_id,
                                d.next_attempt_at,
                                d.last_status
                                    .map(|s| format!("HTTP {s}"))
                                    .or_else(|| d.last_error.clone())
                                    .unwrap_or_else(|| "-".into())
                            );
                        }
                    })
                }
                PayAction::Deliver => {
                    // The explicit flush: POSTs go only to the webhook
                    // endpoint URLs the user registered, nowhere else.
                    let transport = slipscan_ingest::pay::ReqwestWebhookTransport::new()?;
                    let now = slipscan_core::util::now_iso();
                    let updated = runtime()?.block_on(svc.pay_deliver_due(&transport, &now))?;
                    emit(cli.json, &updated, || {
                        if updated.is_empty() {
                            println!("Nothing due.");
                            return;
                        }
                        let delivered = updated
                            .iter()
                            .filter(|d| d.state == PayDeliveryState::Delivered)
                            .count();
                        let failed = updated
                            .iter()
                            .filter(|d| d.state == PayDeliveryState::Failed)
                            .count();
                        println!(
                            "Attempted {}: {delivered} delivered, {} pending retry, \
                             {failed} failed.",
                            updated.len(),
                            updated.len() - delivered - failed
                        );
                    })
                }
            }
        }

        Command::Vault { ref action } => {
            ensure_parent_dir(&env.db)?;
            let vault = VaultHandle::open(&env.db)
                .with_context(|| format!("opening vault in {}", env.db.display()))?;
            match action {
                VaultAction::Set { name } => {
                    let secret = read_secret(&format!("Secret for {name} (not echoed): "))?;
                    let meta = vault.set(name, secret)?;
                    emit(cli.json, &meta, || {
                        println!(
                            "Stored {} (v{}, fingerprint {})",
                            meta.name, meta.version, meta.fingerprint
                        );
                    })
                }
                VaultAction::Replace { name } => {
                    let secret = read_secret(&format!("New secret for {name} (not echoed): "))?;
                    let meta = vault.replace(name, secret)?;
                    emit(cli.json, &meta, || {
                        println!(
                            "Rotated {} (v{}, fingerprint {})",
                            meta.name, meta.version, meta.fingerprint
                        );
                    })
                }
                VaultAction::Revoke { name } => {
                    vault.revoke(name)?;
                    emit(cli.json, &serde_json::json!({ "revoked": name }), || {
                        println!("Revoked {name}");
                    })
                }
                VaultAction::List => {
                    let entries = vault.list()?;
                    emit(cli.json, &entries, || {
                        if entries.is_empty() {
                            println!("Vault is empty.");
                        }
                        for e in &entries {
                            println!(
                                "{}\tv{}\tfp {}\tcreated {}\trotated {}\tlast used {}",
                                e.name,
                                e.version,
                                e.fingerprint,
                                e.created_at,
                                e.rotated_at.as_deref().unwrap_or("-"),
                                e.last_used_at.as_deref().unwrap_or("-"),
                            );
                        }
                    })
                }
            }
        }

        // Device identity & pairing (docs/NODES.md). Identity only: no
        // transport, no endpoint — nothing here syncs anything. The signed
        // operation log is `Command::Sync` below, and it sends nothing either.
        // The whole ceremony is local, which is why it lives here in full
        // while the server serves only the read and revoke halves.
        Command::Device { ref action } => {
            ensure_parent_dir(&env.db)?;
            let devices = DeviceHandle::open(&env.db)
                .with_context(|| format!("opening device identity in {}", env.db.display()))?;
            match action {
                DeviceAction::Init { label } => {
                    let identity = devices.initialize(label)?;
                    emit(cli.json, &identity, || {
                        println!("This device is {}", identity.label);
                        println!("  device id  {}", identity.public_key);
                        println!("  key-name   {}", identity.keyname);
                        println!();
                        println!(
                            "The key-name is what you compare out loud when pairing. \
                             Nothing syncs yet — this is identity only."
                        );
                    })
                }
                DeviceAction::Show => {
                    let identity = devices.identity()?;
                    emit(cli.json, &identity, || match &identity {
                        Some(identity) => {
                            println!("This device is {}", identity.label);
                            println!("  device id  {}", identity.public_key);
                            println!("  key-name   {}", identity.keyname);
                            if let Some(rotated) = &identity.rotated_at {
                                println!("  rotated    {rotated}");
                            }
                        }
                        None => println!(
                            "This device has no identity yet — run `slipscan device init`."
                        ),
                    })
                }
                DeviceAction::Fingerprint { device_id } => {
                    let (id, name) = match device_id {
                        Some(id) => (id.clone(), slipscan_core::device::keyname(id)?),
                        None => {
                            let identity = devices.identity()?.context(
                                "this device has no identity yet — run `slipscan device init`",
                            )?;
                            (identity.public_key, identity.keyname)
                        }
                    };
                    emit(
                        cli.json,
                        &serde_json::json!({ "device_id": id, "keyname": name }),
                        || {
                            println!("{name}");
                            println!("({id})");
                        },
                    )
                }
                DeviceAction::List => {
                    let peers = devices.peer_list()?;
                    emit(cli.json, &peers, || {
                        if peers.is_empty() {
                            println!(
                                "No paired devices. `slipscan device invite` starts a pairing."
                            );
                        }
                        for peer in &peers {
                            println!(
                                "{}\t{}\t{}\tpaired {}\t{}",
                                peer.label,
                                peer.keyname,
                                peer.public_key,
                                peer.paired_at,
                                match &peer.revoked_at {
                                    Some(at) => format!("REVOKED {at}"),
                                    None => "active".to_string(),
                                }
                            );
                        }
                        if !peers.is_empty() {
                            println!();
                            println!("Paired, but nothing syncs yet — this is identity only.");
                        }
                    })
                }
                DeviceAction::Invite { label, ttl } => {
                    let invite = devices.invite_create(label, *ttl)?;
                    emit(cli.json, &invite, || {
                        println!("{}", invite.blob);
                        println!();
                        println!("Carry that to the other device and run:");
                        println!(
                            "  slipscan device accept <blob> --expect-keyname {}",
                            invite.keyname
                        );
                        println!();
                        println!("This device's key-name is {}", invite.keyname);
                        println!("Expires {} — single use.", invite.expires_at);
                        println!(
                            "The blob contains a one-time claim token: treat it as a credential."
                        );
                    })
                }
                DeviceAction::Accept {
                    blob,
                    expect_keyname,
                    unverified,
                } => {
                    let accepted =
                        devices.pair_accept(blob, keyname_check(expect_keyname, *unverified))?;
                    emit(cli.json, &accepted, || {
                        println!("Pinned {} ({})", accepted.peer.label, accepted.peer.keyname);
                        if *unverified {
                            println!(
                                "  WARNING: --unverified — nothing checked this key came from \
                                 the device you meant."
                            );
                        }
                        println!();
                        println!("{}", accepted.blob);
                        println!();
                        println!("Carry that back to the inviting device and run:");
                        println!(
                            "  slipscan device confirm <blob> --expect-keyname <its key-name>"
                        );
                    })
                }
                DeviceAction::Confirm {
                    blob,
                    expect_keyname,
                    unverified,
                } => {
                    let peer =
                        devices.pair_confirm(blob, keyname_check(expect_keyname, *unverified))?;
                    emit(cli.json, &peer, || {
                        println!("Pinned {} ({})", peer.label, peer.keyname);
                        println!("  device id {}", peer.public_key);
                        if *unverified {
                            println!(
                                "  WARNING: --unverified — nothing checked this key came from \
                                 the device you meant."
                            );
                        }
                        println!();
                        println!(
                            "Both devices are now paired. Nothing syncs yet: each device keeps \
                             a signed log of its own changes and there is no transport to carry \
                             it (docs/NODES.md)."
                        );
                    })
                }
                DeviceAction::Invites => {
                    let invites = devices.invite_list()?;
                    emit(cli.json, &invites, || {
                        if invites.is_empty() {
                            println!("No invites.");
                        }
                        for invite in &invites {
                            println!(
                                "{}\t{}\texpires {}\t{}",
                                invite.id,
                                invite.label,
                                invite.expires_at,
                                match &invite.redeemed_at {
                                    Some(at) => format!("redeemed {at}"),
                                    None => "outstanding".to_string(),
                                }
                            );
                        }
                    })
                }
                DeviceAction::CancelInvite { id } => {
                    let cancelled = devices.invite_cancel(id)?;
                    emit(
                        cli.json,
                        &serde_json::json!({ "cancelled": cancelled }),
                        || {
                            if cancelled {
                                println!("Withdrew invite {id}.");
                            } else {
                                println!(
                                    "No outstanding invite {id} (already redeemed, or unknown)."
                                );
                            }
                        },
                    )
                }
                DeviceAction::Revoke { device_id } => {
                    let peer = devices.peer_revoke(device_id)?;
                    emit(cli.json, &peer, || {
                        println!("Revoked {} ({}).", peer.label, peer.keyname);
                        println!(
                            "The pin is kept as a tombstone, so this key cannot pair again by \
                             itself. Use `slipscan device forget {}` if you really mean to let \
                             it back in.",
                            peer.public_key
                        );
                    })
                }
                DeviceAction::Forget { device_id } => {
                    let forgotten = devices.peer_forget(device_id)?;
                    emit(
                        cli.json,
                        &serde_json::json!({ "forgotten": forgotten }),
                        || {
                            if forgotten {
                                println!("Dropped the pin for {device_id}. It may pair again.");
                            } else {
                                println!("No pinned device {device_id}.");
                            }
                        },
                    )
                }
                DeviceAction::Rotate => {
                    let (identity, rotation) = devices.rotate()?;
                    emit(
                        cli.json,
                        &serde_json::json!({ "identity": identity, "rotation": rotation }),
                        || {
                            println!("Rotated this device's key.");
                            println!("  was  {}", rotation.old_public_key);
                            println!("  now  {}", identity.public_key);
                            println!("  key-name {}", identity.keyname);
                            println!();
                            println!(
                                "The device id changed, so peers still hold the old key: pair \
                                 again with each of them."
                            );
                        },
                    )
                }
                DeviceAction::Rotations => {
                    let chain = devices.rotations()?;
                    emit(cli.json, &chain, || {
                        if chain.is_empty() {
                            println!("This device's key has never been rotated.");
                        }
                        for entry in &chain {
                            println!(
                                "{}\t{} -> {}\t{}",
                                entry.rotated_at,
                                entry.old_public_key,
                                entry.new_public_key,
                                if entry.verify() {
                                    "verified"
                                } else {
                                    "INVALID"
                                }
                            );
                        }
                    })
                }
                DeviceAction::Reset { yes } => {
                    if !yes {
                        bail!(
                            "`device reset` destroys this device's private key and its identity. \
                             Pass --yes if that is what you mean."
                        );
                    }
                    devices.reset()?;
                    emit(cli.json, &serde_json::json!({ "reset": true }), || {
                        println!("Destroyed this device's key and identity.");
                        println!("Peer pins were kept — use `slipscan device forget` for those.");
                    })
                }
            }
        }

        // The signed operation log (docs/NODES.md phase 2). Local-only, and
        // not because of a policy: there is no transport, so there is nothing
        // for a served route to talk to.
        Command::Sync { ref action } => {
            ensure_parent_dir(&env.db)?;
            let oplog = OplogHandle::open(&env.db)
                .with_context(|| format!("opening the operation log in {}", env.db.display()))?;
            match action {
                SyncAction::Status => {
                    let status = oplog.status()?;
                    emit(cli.json, &status, || {
                        match (&status.device, &status.keyname) {
                            (Some(id), Some(name)) => {
                                println!("This device  {name}");
                                println!("             {id}");
                            }
                            _ => println!(
                                "This device has no identity yet — run `slipscan device init`. \
                                 Changes are being recorded and will sign once it does."
                            ),
                        }
                        println!();
                        println!("Operations   {}", status.ops);
                        println!(
                            "Unsealed     {}{}",
                            status.pending,
                            if status.pending > 0 {
                                "  (run `slipscan sync seal`)"
                            } else {
                                ""
                            }
                        );
                        if let Some((wall, counter)) = status.clock {
                            println!("Clock        {wall}.{counter}");
                        }
                        if !status.namespaces.is_empty() {
                            println!();
                            println!("Per book:");
                            for entry in &status.namespaces {
                                println!("  {}\t{} operations", entry.ns, entry.ops);
                            }
                        }
                        if !status.version_vector.is_empty() {
                            println!();
                            println!("Authors seen:");
                            for (author, wall, counter) in &status.version_vector {
                                println!("  {author}\tup to {wall}.{counter}");
                            }
                        }
                        println!();
                        println!("Paired devices: {}", status.live_peers);
                        println!(
                            "Nothing is sent anywhere. SlipScan has no sync transport yet: \
                             this log records and signs what WOULD replicate, and that is all."
                        );
                    })
                }
                SyncAction::Seal => {
                    let report = oplog.seal()?;
                    emit(cli.json, &report, || {
                        if report.captured == 0 {
                            println!("Nothing to seal — every change is already signed.");
                            return;
                        }
                        println!(
                            "Sealed {} operation{} from {} captured change{}.",
                            report.sealed,
                            plural(report.sealed),
                            report.captured,
                            plural(report.captured),
                        );
                        if report.captured > report.sealed + report.already_present {
                            println!(
                                "  {} change{} collapsed: several edits to one row are one \
                                 last-writer-wins operation.",
                                report.captured - report.sealed - report.already_present,
                                plural(report.captured - report.sealed - report.already_present),
                            );
                        }
                        if report.already_present > 0 {
                            println!(
                                "  {} were already recorded (an operation's content is its id).",
                                report.already_present
                            );
                        }
                    })
                }
                SyncAction::Log { book, limit } => {
                    let ops = oplog.ops(book.as_deref(), Some(*limit))?;
                    let rendered: Vec<_> = ops
                        .iter()
                        .map(|op| {
                            serde_json::json!({
                                "op_id": op.op_id,
                                "book": op.ns,
                                "kind": kind_name(op.kind),
                                "target": op.target,
                                "author": op.author,
                                "hlc": format!("{}.{}", op.hlc_wall, op.hlc_counter),
                                "origin": op.origin.as_str(),
                                "recorded_at": op.recorded_at,
                            })
                        })
                        .collect();
                    emit(cli.json, &rendered, || {
                        if ops.is_empty() {
                            println!(
                                "The log is empty. `slipscan sync seal` signs pending changes."
                            );
                            return;
                        }
                        for op in &ops {
                            println!(
                                "{}.{}\t{}\t{}\t{}",
                                op.hlc_wall,
                                op.hlc_counter,
                                kind_name(op.kind),
                                op.target,
                                &op.op_id[..16],
                            );
                        }
                    })
                }
                SyncAction::Verify => {
                    let report = oplog.verify()?;
                    emit(cli.json, &report, || {
                        if report.checked == 0 {
                            // "0 verified, all sound" is a vacuous green, and
                            // a scripted check would read it as an answer. Say
                            // what was actually examined: nothing.
                            println!(
                                "The log is empty — nothing was verified. \
                                 `slipscan sync seal` signs pending changes."
                            );
                            return;
                        }
                        if report.is_sound() {
                            println!(
                                "{} operation{} verified — every signature checks out under its \
                                 own author's key.",
                                report.checked,
                                plural(report.checked)
                            );
                            return;
                        }
                        println!(
                            "{} of {} operation{} DO NOT VERIFY:",
                            report.failures.len(),
                            report.checked,
                            plural(report.checked)
                        );
                        for (op_id, reason) in &report.failures {
                            println!("  {op_id}\t{reason}");
                        }
                    })?;
                    // A log that does not verify is a failure, not a report.
                    // Exiting 0 here would let a scripted check pass over a
                    // tampered log — the one thing this command exists to
                    // catch.
                    if !report.is_sound() {
                        bail!(
                            "{} operation(s) in this device's log do not verify",
                            report.failures.len()
                        );
                    }
                    Ok(())
                }
            }
        }

        Command::Serve {
            listen,
            lan,
            no_auth,
            reset_token,
        } => {
            let svc = open_service(&env.db)?;
            let addr = listen.unwrap_or(slipscan_server::DEFAULT_ADDR);
            // Mantra #3: non-loopback binds are an explicit user opt-in.
            if !addr.ip().is_loopback() && !lan {
                bail!(
                    "{addr} is not loopback; pass --lan to explicitly opt in to LAN exposure \
                     (and terminate TLS in front of SlipScan)"
                );
            }
            if no_auth && !addr.ip().is_loopback() {
                bail!("--no-auth is only allowed on loopback binds");
            }
            let require_auth = !no_auth;
            if require_auth {
                if let Ok(token) = std::env::var(TOKEN_ENV) {
                    slipscan_server::set_auth_token(&svc, &token)?;
                    eprintln!("Using API token from {TOKEN_ENV} (only its SHA-256 is stored).");
                } else if reset_token {
                    print_token(&slipscan_server::rotate_auth_token(&svc)?);
                } else {
                    match slipscan_server::ensure_auth_token(&svc)? {
                        AuthToken::Generated(token) => print_token(&token),
                        AuthToken::Existing => eprintln!(
                            "Using the existing API token (pass --reset-token to rotate it)."
                        ),
                    }
                }
            } else {
                eprintln!("Warning: serving without authentication on {addr} (loopback only).");
            }
            eprintln!("Serving on http://{addr}");
            let vault = VaultHandle::open(&env.db)?;
            // FX transport for the explicit fx_fetch_rate route: built per
            // fetch, only ever pointed at the user-configured OpenRate URL.
            let fx_transport: slipscan_server::FxTransportFactory = std::sync::Arc::new(|| {
                Ok(Box::new(slipscan_ingest::fx::ReqwestFxTransport::new()?)
                    as Box<dyn slipscan_core::fx::FxTransport>)
            });
            // Payment delivery loop: serve mode flushes due webhook
            // deliveries on an interval — POSTs only ever go to the
            // endpoint URLs the user registered, and an empty queue means
            // zero network activity.
            let pay_transport: slipscan_server::PayTransportFactory = std::sync::Arc::new(|| {
                Ok(
                    Box::new(slipscan_ingest::pay::ReqwestWebhookTransport::new()?)
                        as Box<dyn slipscan_core::pay::WebhookTransport>,
                )
            });
            // Pack transport for the pack_source_* routes: a git checkout
            // cache beside the data folder, plus an HTTPS client. It has no
            // endpoint of its own — every request goes to a source the user
            // added, and with no source added none is ever made.
            let pack_cache = env
                .db
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            let pack_transport: slipscan_server::PackTransportFactory =
                std::sync::Arc::new(move || {
                    let http = slipscan_ingest::packs::ReqwestPackHttp::new()
                        .map_err(slipscan_core::CoreError::FxTransport)?;
                    Ok(slipscan_packs::transport::TransportContext::new()
                        .with_cache_dir(pack_cache.clone())
                        .with_http(std::sync::Arc::new(http)))
                });
            // The data_status route only makes sense when the served
            // database *is* the managed folder's; with an explicit --db the
            // route answers 503 instead of describing the wrong folder.
            let data_dir = env.managed.then(|| env.resolver.clone());
            // Device identity for the read-only device routes and peer
            // revocation. Attaching it exposes no key material and no claim
            // token: the ceremony and every key-minting op stay local (see
            // slipscan_server::devices), and nothing here syncs anything.
            let devices = DeviceHandle::open(&env.db)
                .with_context(|| format!("opening device identity in {}", env.db.display()))?;
            runtime()?.block_on(slipscan_server::serve(
                svc,
                Some(vault),
                Some(devices),
                Some(fx_transport),
                Some(pay_transport),
                Some(pack_transport),
                data_dir,
                ServerConfig { addr, require_auth },
            ))?;
            Ok(())
        }

        Command::Data { ref action } => match action {
            DataAction::Status => {
                let status = datadir::status(&env.resolver)?;
                emit(cli.json, &status, || {
                    let location = if status.pointer_set {
                        "set by pointer"
                    } else {
                        "platform default"
                    };
                    println!("Data folder: {} ({location})", status.data_dir);
                    println!(
                        "Database:    {} ({})",
                        status.db_path,
                        if status.db_exists {
                            fmt_bytes(status.db_size_bytes)
                        } else {
                            "not created yet".to_string()
                        }
                    );
                    println!(
                        "Documents:   {} ({} file(s), {})",
                        status.documents_dir,
                        status.document_count,
                        fmt_bytes(status.documents_size_bytes)
                    );
                    println!("Pointer:     {}", status.pointer_path);
                    if !env.managed {
                        println!(
                            "Note: --db {} overrides this folder for the other commands \
                             of this invocation.",
                            env.db.display()
                        );
                    }
                    // The contract's in-app guidance, verbatim in spirit:
                    // backup is the user's own cloud on this folder.
                    println!(
                        "Backup is yours: keep this folder inside a folder your own cloud \
                         syncs (iCloud Drive, Dropbox, Syncthing, Nextcloud, a NAS) — \
                         SlipScan ships no backup service. Credentials stay in the OS \
                         keychain and are re-entered after a restore, by design."
                    );
                })
            }
            DataAction::Move { target } => {
                if cli.db.is_some() {
                    bail!(
                        "`data move` moves the managed data folder (the one the pointer \
                         file names); --db does not apply here"
                    );
                }
                let json = cli.json;
                let mut last_step: Option<MoveStep> = None;
                let report = datadir::move_data_dir(&env.resolver, target, &mut |p| {
                    if json {
                        return;
                    }
                    if last_step != Some(p.step) {
                        last_step = Some(p.step);
                        let label = match p.step {
                            MoveStep::Validate => "Validating target…",
                            MoveStep::CopyDatabase => "Copying database…",
                            MoveStep::CopyDocuments => "Copying documents…",
                            MoveStep::VerifyCopy => {
                                "Verifying the copy (open, migrate, integrity)…"
                            }
                            MoveStep::SwapPointer => "Switching the pointer…",
                            MoveStep::RemoveOld => "Removing the old copy…",
                        };
                        eprintln!("{label}");
                    }
                    if p.step == MoveStep::CopyDocuments && p.total > 0 && p.done == p.total {
                        eprintln!("  {} file(s) copied, each checksum-verified", p.total);
                    }
                })?;
                emit(cli.json, &report, || {
                    println!(
                        "Moved the data folder: {} -> {} ({} file(s), {}, {} stored document \
                         path(s) updated).",
                        report.from,
                        report.to,
                        report.files_copied,
                        fmt_bytes(report.bytes_copied),
                        report.documents_rewritten
                    );
                    match &report.old_remove_error {
                        None => println!("Old copy removed."),
                        Some(err) => println!(
                            "The new folder is active, but removing the old copy failed \
                             ({err}); delete it manually."
                        ),
                    }
                })
            }
        },

        Command::List { what } => {
            let svc = open_service(&env.db)?;
            match what {
                ListTarget::Books => {
                    let books = svc.book_list()?;
                    emit(cli.json, &books, || {
                        for b in &books {
                            println!(
                                "{}\t{}\t{}\t{}\t{}",
                                b.id, b.kind, b.name, b.region, b.currency
                            );
                        }
                    })
                }
                ListTarget::Accounts => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let accounts = svc.account_list(&book.id)?;
                    emit(cli.json, &accounts, || {
                        for a in &accounts {
                            println!("{}\t{}\t{}\t{}", a.id, a.kind, a.name, a.currency);
                        }
                    })
                }
                ListTarget::Transactions => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let txns = svc.transaction_list(&book.id, &TransactionFilter::default())?;
                    // A book with no members yet has every transaction
                    // unattributed (None) — the lookup below degrades to "-"
                    // for all of them, unchanged from before members existed.
                    let members = svc.member_list(&book.id)?;
                    emit(cli.json, &txns, || {
                        for t in &txns {
                            let attributed = match &t.attributed_member_id {
                                Some(id) => members
                                    .iter()
                                    .find(|m| &m.id == id)
                                    .map(|m| m.label.as_str())
                                    .unwrap_or("?"),
                                None => "-",
                            };
                            println!(
                                "{}\t{}\t{}\t{}\t{}\t{}",
                                t.id,
                                t.posted_date,
                                fmt_minor(t.amount_minor),
                                t.currency,
                                t.merchant.as_deref().unwrap_or("-"),
                                attributed
                            );
                        }
                    })
                }
                ListTarget::Documents => {
                    let book = resolve_book(&svc, cli.book.as_deref())?;
                    let docs = svc.document_list(&book.id, None)?;
                    emit(cli.json, &docs, || {
                        for d in &docs {
                            println!(
                                "{}\t{}\t{}\t{}",
                                d.id,
                                d.status,
                                d.kind,
                                d.original_name.as_deref().unwrap_or(&d.file_path)
                            );
                        }
                    })
                }
            }
        }
    }
}

/// The one and only time a generated token is visible. The token goes to
/// stdout (so it can be captured); explanation goes to stderr.
fn print_token(token: &str) {
    eprintln!("Generated API token — shown once, only its SHA-256 is stored:");
    println!("{token}");
}

/// The sanctioned single display of a webhook signing secret (add/rotate).
/// Same split as [`print_token`]: the secret goes to stdout so it can be
/// captured; everything else goes to stderr. In `--json` mode the emitted
/// `PayEndpointWithSecret` carries it instead — still exactly once.
fn print_endpoint_secret(created: &PayEndpointWithSecret) {
    eprintln!(
        "Endpoint {} ({}) -> {}",
        created.endpoint.label, created.endpoint.id, created.endpoint.url
    );
    eprintln!(
        "Signing secret — shown once, then held write-only in the vault \
         (lost means rotate):"
    );
    println!("{}", created.secret);
    eprintln!(
        "Receivers verify: hex(HMAC-SHA256(secret, \"{{timestamp}}.{{nonce}}.\" + body)) \
         == X-SlipScan-Signature, with the timestamp/nonce from the \
         X-SlipScan-Timestamp / X-SlipScan-Nonce headers."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_init_with_seed_coa() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "--db",
            "/tmp/x.sqlite",
            "init",
            "--name",
            "Personal",
            "--seed-coa",
        ])
        .unwrap();
        assert_eq!(cli.db, Some(PathBuf::from("/tmp/x.sqlite")));
        match cli.command {
            Command::Init { name, seed_coa, .. } => {
                assert_eq!(name.as_deref(), Some("Personal"));
                assert!(seed_coa);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_import_with_book_and_multiple_paths() {
        let cli =
            Cli::try_parse_from(["slipscan", "--book", "Biz", "import", "a.pdf", "b.jpg"]).unwrap();
        assert_eq!(cli.book.as_deref(), Some("Biz"));
        match cli.command {
            Command::Import { paths, .. } => assert_eq!(paths.len(), 2),
            other => panic!("unexpected {other:?}"),
        }
        // No paths at all is a parse error.
        assert!(Cli::try_parse_from(["slipscan", "import"]).is_err());
    }

    #[test]
    fn parses_extract_and_mail_sync() {
        let cli = Cli::try_parse_from(["slipscan", "extract", "--limit", "5"]).unwrap();
        assert!(matches!(cli.command, Command::Extract { limit: 5 }));

        let cli =
            Cli::try_parse_from(["slipscan", "mail-sync", "--storage-dir", "/tmp/docs"]).unwrap();
        match cli.command {
            Command::MailSync {
                provider,
                login,
                storage_dir,
                alerts,
                account,
            } => {
                // Existing invocations are unchanged: imap, no login, and
                // bank-alert parsing off unless it is asked for.
                assert_eq!(provider, MailProvider::Imap);
                assert!(!login);
                assert_eq!(storage_dir, Some(PathBuf::from("/tmp/docs")));
                assert!(!alerts);
                assert_eq!(account, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn mail_sync_alerts_requires_an_account_to_book_to() {
        // Alerts become transactions, so there is no sensible default target
        // and clap refuses the combination rather than guessing one.
        assert!(Cli::try_parse_from(["slipscan", "mail-sync", "--alerts"]).is_err());

        let cli = Cli::try_parse_from(["slipscan", "mail-sync", "--alerts", "--account", "Cheque"])
            .unwrap();
        match cli.command {
            Command::MailSync {
                alerts, account, ..
            } => {
                assert!(alerts);
                assert_eq!(account.as_deref(), Some("Cheque"));
            }
            other => panic!("unexpected {other:?}"),
        }

        // --account on its own is harmless: it simply names an account that
        // nothing books to yet.
        let cli = Cli::try_parse_from(["slipscan", "mail-sync", "--account", "Cheque"]).unwrap();
        match cli.command {
            Command::MailSync { alerts, .. } => assert!(!alerts),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_mail_sync_providers_and_login() {
        for (arg, expected) in [
            ("imap", MailProvider::Imap),
            ("gmail", MailProvider::Gmail),
            ("graph", MailProvider::Graph),
        ] {
            let cli = Cli::try_parse_from(["slipscan", "mail-sync", "--provider", arg, "--login"])
                .unwrap();
            match cli.command {
                Command::MailSync {
                    provider, login, ..
                } => {
                    assert_eq!(provider, expected);
                    assert!(login);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert!(Cli::try_parse_from(["slipscan", "mail-sync", "--provider", "pigeon"]).is_err());
    }

    #[test]
    fn parses_watch_folder() {
        let cli = Cli::try_parse_from(["slipscan", "watch", "/tmp/drop"]).unwrap();
        match cli.command {
            Command::Watch { dir, once } => {
                assert_eq!(dir, PathBuf::from("/tmp/drop"));
                assert!(!once, "watching is the default");
            }
            other => panic!("unexpected {other:?}"),
        }
        let cli = Cli::try_parse_from(["slipscan", "watch", "/tmp/drop", "--once"]).unwrap();
        assert!(matches!(cli.command, Command::Watch { once: true, .. }));
        // The folder is required.
        assert!(Cli::try_parse_from(["slipscan", "watch"]).is_err());
    }

    #[test]
    fn parses_recon_actions() {
        let cli = Cli::try_parse_from(["slipscan", "recon", "suggest"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Recon {
                action: ReconAction::Suggest
            }
        ));
        let cli = Cli::try_parse_from(["slipscan", "recon", "confirm", "m-1"]).unwrap();
        match cli.command {
            Command::Recon {
                action: ReconAction::Confirm { match_id },
            } => assert_eq!(match_id, "m-1"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_report_kinds_and_csv() {
        for (arg, expected) in [
            ("tb", ReportKind::Tb),
            ("pl", ReportKind::Pl),
            ("bs", ReportKind::Bs),
            ("tax", ReportKind::Tax),
            // Old name kept as an alias: `report vat` still works.
            ("vat", ReportKind::Tax),
        ] {
            let cli = Cli::try_parse_from(["slipscan", "report", arg]).unwrap();
            match cli.command {
                Command::Report { kind, csv, .. } => {
                    assert!(matches!(
                        (kind, expected),
                        (ReportKind::Tb, ReportKind::Tb)
                            | (ReportKind::Pl, ReportKind::Pl)
                            | (ReportKind::Bs, ReportKind::Bs)
                            | (ReportKind::Tax, ReportKind::Tax)
                    ));
                    assert!(!csv);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        let cli = Cli::try_parse_from(["slipscan", "report", "tb", "--csv"]).unwrap();
        assert!(matches!(cli.command, Command::Report { csv: true, .. }));
    }

    #[test]
    fn parses_report_members_and_settle_up() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "report",
            "members",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
        ])
        .unwrap();
        match cli.command {
            Command::Report {
                kind: ReportKind::Members,
                from,
                to,
                ..
            } => {
                assert_eq!(from.as_deref(), Some("2026-01-01"));
                assert_eq!(to.as_deref(), Some("2026-12-31"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            Cli::try_parse_from(["slipscan", "report", "settle-up"])
                .unwrap()
                .command,
            Command::Report {
                kind: ReportKind::SettleUp,
                ..
            }
        ));
    }

    #[test]
    fn parses_member_actions() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "member",
            "add",
            "Alex",
            "--initial",
            "A",
            "--colour",
            "#112233",
            "--account",
            "Joint",
        ])
        .unwrap();
        match cli.command {
            Command::Member {
                action:
                    MemberAction::Add {
                        label,
                        initial,
                        colour,
                        account,
                    },
            } => {
                assert_eq!(label, "Alex");
                assert_eq!(initial.as_deref(), Some("A"));
                assert_eq!(colour.as_deref(), Some("#112233"));
                assert_eq!(account.as_deref(), Some("Joint"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["slipscan", "member", "list"]).is_ok());

        let cli = Cli::try_parse_from([
            "slipscan",
            "member",
            "update",
            "m-1",
            "--label",
            "Alexis",
            "--clear-account",
        ])
        .unwrap();
        match cli.command {
            Command::Member {
                action:
                    MemberAction::Update {
                        id,
                        label,
                        clear_account,
                        account,
                        ..
                    },
            } => {
                assert_eq!(id, "m-1");
                assert_eq!(label.as_deref(), Some("Alexis"));
                assert!(clear_account);
                assert!(account.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        // --account and --clear-account are mutually exclusive.
        assert!(Cli::try_parse_from([
            "slipscan",
            "member",
            "update",
            "m-1",
            "--account",
            "x",
            "--clear-account",
        ])
        .is_err());

        let cli = Cli::try_parse_from(["slipscan", "member", "remove", "m-1", "--reassign", "m-2"])
            .unwrap();
        match cli.command {
            Command::Member {
                action: MemberAction::Remove { id, reassign },
            } => {
                assert_eq!(id, "m-1");
                assert_eq!(reassign.as_deref(), Some("m-2"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_attribute_and_split() {
        let cli = Cli::try_parse_from(["slipscan", "attribute", "t-1", "m-1"]).unwrap();
        match cli.command {
            Command::Attribute {
                transaction_id,
                member,
            } => {
                assert_eq!(transaction_id, "t-1");
                assert_eq!(member, "m-1");
            }
            other => panic!("unexpected {other:?}"),
        }
        // The clearing sentinel parses fine despite the leading hyphen.
        let cli = Cli::try_parse_from(["slipscan", "attribute", "t-1", "-"]).unwrap();
        match cli.command {
            Command::Attribute { member, .. } => assert_eq!(member, "-"),
            other => panic!("unexpected {other:?}"),
        }

        let cli = Cli::try_parse_from(["slipscan", "split", "t-1", "m-1:1500", "m-2:500"]).unwrap();
        match cli.command {
            Command::Split {
                transaction_id,
                shares,
            } => {
                assert_eq!(transaction_id, "t-1");
                assert_eq!(shares, vec!["m-1:1500", "m-2:500"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        // No shares at all is valid (clears the split).
        assert!(Cli::try_parse_from(["slipscan", "split", "t-1"]).is_ok());
    }

    #[test]
    fn parses_init_region_flags() {
        let cli =
            Cli::try_parse_from(["slipscan", "init", "--name", "Biz", "--region", "za"]).unwrap();
        match cli.command {
            Command::Init { name, region, .. } => {
                assert_eq!(name.as_deref(), Some("Biz"));
                assert_eq!(region.as_deref(), Some("za"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let cli = Cli::try_parse_from(["slipscan", "init", "--list-regions"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Init {
                list_regions: true,
                ..
            }
        ));
    }

    #[test]
    fn init_creates_regioned_books_and_defaults_to_generic() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("r.sqlite");
        run(Cli::try_parse_from([
            "slipscan",
            "--db",
            db.to_str().unwrap(),
            "--json",
            "init",
            "--name",
            "SA Biz",
            "--kind",
            "business",
            "--region",
            "za",
            "--seed-coa",
        ])
        .unwrap())
        .unwrap();
        run(Cli::try_parse_from([
            "slipscan",
            "--db",
            db.to_str().unwrap(),
            "--json",
            "init",
            "--name",
            "Anywhere",
        ])
        .unwrap())
        .unwrap();

        let svc = CoreService::open(&db).unwrap();
        let books = svc.book_list().unwrap();
        let sa = books.iter().find(|b| b.name == "SA Biz").unwrap();
        assert_eq!(sa.region, "za");
        assert_eq!(sa.currency, "ZAR");
        // Seeded from the za profile: VAT control accounts present.
        assert!(svc
            .coa_list(&sa.id)
            .unwrap()
            .iter()
            .any(|c| c.code == "1400" && c.name.contains("VAT")));
        // No region flag → the generic international profile, never a
        // hardcoded jurisdiction.
        let generic = books.iter().find(|b| b.name == "Anywhere").unwrap();
        assert_eq!(generic.region, "generic");

        // Unknown regions are rejected by core, surfaced as an error.
        let err = run(Cli::try_parse_from([
            "slipscan",
            "--db",
            db.to_str().unwrap(),
            "init",
            "--name",
            "Nope",
            "--region",
            "atlantis",
        ])
        .unwrap())
        .unwrap_err()
        .to_string();
        assert!(err.contains("atlantis"), "{err}");
    }

    #[test]
    fn init_currency_flag_overrides_the_profile_default() {
        // Regression: `init` had no --currency, so a generic-region book was
        // always USD — a JPY/EUR user could not create a correctly
        // denominated book from the CLI.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("c.sqlite");
        run(Cli::try_parse_from([
            "slipscan",
            "--db",
            db.to_str().unwrap(),
            "--json",
            "init",
            "--name",
            "Mumbai",
            "--currency",
            "inr",
        ])
        .unwrap())
        .unwrap();
        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        assert_eq!(book.region, "generic");
        assert_eq!(book.currency, "INR", "normalized override wins");
    }

    #[test]
    fn tax_rate_is_configurable_end_to_end_for_a_generic_book() {
        // Regression: the generic profile's STD rate seeded at 0 bps with no
        // CLI surface able to change it — all tax math ran at 0%.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "W", "--region", "generic", "--seed-coa"]).unwrap();
        run_cli(&["tax", "rates"]).unwrap();
        run_cli(&["tax", "set-rate", "STD", "750"]).unwrap();

        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        let rates = svc.vat_rate_list(&book.id).unwrap();
        let std = rates.iter().find(|r| r.code == "STD").unwrap();
        assert_eq!(std.rate_bps, 750);
        // Out-of-range rejected.
        assert!(run_cli(&["tax", "set-rate", "STD", "10001"]).is_err());
    }

    /// `book profile` / `book set-kind` / `book set-multi-location` and
    /// `location add`/`list`/`update`/`remove` end to end (ROADMAP.md
    /// "Phase 6" — 6.0 Book profiles) — the CLI half of the same-name/
    /// same-payload parity `docs/API.md` tracks against the HTTP routes.
    #[test]
    fn book_profile_and_location_commands_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Biz", "--kind", "business"]).unwrap();

        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        drop(svc);

        // Fresh business book: no locations yet, so the axis is not shown.
        run_cli(&["book", "profile"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        let profile = svc.book_profile(&book.id).unwrap();
        assert!(profile.show_contacts && !profile.show_locations);
        drop(svc);

        run_cli(&["location", "add", "HQ"]).unwrap();
        run_cli(&[
            "location",
            "add",
            "Depot",
            "--kind",
            "warehouse",
            "--code",
            "DEP-1",
        ])
        .unwrap();
        run_cli(&["location", "list"]).unwrap();

        let svc = CoreService::open(&db).unwrap();
        let locations = svc.location_list(&book.id).unwrap();
        assert_eq!(locations.len(), 2);
        let depot = locations.iter().find(|l| l.name == "Depot").unwrap();
        assert_eq!(depot.kind, LocationKind::Warehouse);
        assert_eq!(depot.code.as_deref(), Some("DEP-1"));
        let depot_id = depot.id.clone();
        let profile = svc.book_profile(&book.id).unwrap();
        assert!(
            profile.multi_location && profile.show_locations,
            "a second location derives multi-location on"
        );
        drop(svc);

        // Pin the override off despite two locations, then back to auto.
        run_cli(&["book", "set-multi-location", "off"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(!svc.book_profile(&book.id).unwrap().multi_location);
        drop(svc);
        run_cli(&["book", "set-multi-location", "auto"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.book_profile(&book.id).unwrap().multi_location);
        drop(svc);

        // Archive, then remove, the depot location.
        run_cli(&["location", "update", &depot_id, "--archive"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.location_get(&depot_id).unwrap().is_archived);
        drop(svc);
        run_cli(&["location", "remove", &depot_id]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.location_get(&depot_id).is_err());
        drop(svc);

        // Downgrade to personal hides business groups; it deletes nothing —
        // the surviving HQ location is still there.
        run_cli(&["book", "set-kind", "personal"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        let profile = svc.book_profile(&book.id).unwrap();
        assert!(!profile.show_contacts && !profile.show_catalogue);
        assert_eq!(svc.location_list(&book.id).unwrap().len(), 1);

        // And back to business restores them.
        drop(svc);
        run_cli(&["book", "set-kind", "business"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.book_profile(&book.id).unwrap().show_contacts);
    }

    #[test]
    fn import_with_a_generic_preset_creates_transactions() {
        // Regression: the statement-preset catalog had no CLI consumer — a
        // US-format CSV imported as a document only, `list transactions`
        // stayed empty.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("p.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let csv_path = dir.path().join("us-statement.csv");
        std::fs::write(
            &csv_path,
            "Date,Description,Amount\n06/15/2026,ACME PAYROLL,\"2,345.67\"\n06/16/2026,COFFEE HOUSE,-4.50\n",
        )
        .unwrap();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "W", "--region", "generic", "--seed-coa"]).unwrap();
        run_cli(&["import", "--list-presets"]).unwrap();
        run_cli(&["account", "add", "Checking"]).unwrap();
        run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "generic-mdy",
            "--account",
            "Checking",
        ])
        .unwrap();

        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        let txns = svc
            .transaction_list(&book.id, &TransactionFilter::default())
            .unwrap();
        assert_eq!(txns.len(), 2, "statement lines became transactions");
        let payroll = txns
            .iter()
            .find(|t| t.description.as_deref() == Some("ACME PAYROLL"))
            .unwrap();
        assert_eq!(payroll.amount_minor, 234_567);
        assert_eq!(payroll.posted_date, "2026-06-15", "MM/DD/YYYY parsed");
        assert_eq!(payroll.currency, "USD", "account inherits book currency");
        // The statement document is stored too.
        assert_eq!(svc.document_list(&book.id, None).unwrap().len(), 1);

        // Unknown preset and missing --account fail with guidance.
        let err = run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "nope-bank",
            "--account",
            "Checking",
        ])
        .unwrap_err()
        .to_string();
        assert!(err.contains("--list-presets"), "{err}");
        let err = run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "generic-mdy",
        ])
        .unwrap_err()
        .to_string();
        assert!(err.contains("--account"), "{err}");
    }

    /// Bank-alert mail rules end to end through the CLI, exactly as a user
    /// meets them: author a `mailrules` pack as JSON, sign it, install it
    /// with `slipscan pack install`, and see it listed as its own kind.
    ///
    /// The JSON below is the on-disk format contract — if a field is renamed
    /// or a tag changes shape, this test is what notices.
    #[test]
    fn mailrules_pack_installs_through_the_cli_and_arms_mail_sync() {
        use ed25519_dalek::{Signer, SigningKey};

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("alerts.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Alerts", "--currency", "zar"]).unwrap();
        run_cli(&["account", "add", "Card"]).unwrap();

        // A wholly invented bank. SlipScan ships no bank patterns; this is a
        // fixture, which is the point of the pack kind.
        let payload = r#"{
  "meta": {
    "id": "fixture-bank-alerts",
    "name": "Fixture bank alerts",
    "version": "1.0.0",
    "author": "cli test"
  },
  "mailrules": {
    "rules": [
      {
        "id": "card-purchase",
        "description": "Card purchase notification",
        "from_patterns": ["meridian.example"],
        "subject_patterns": ["(?i)card purchase"],
        "amount": {
          "part": "body",
          "pattern": "(?i)purchase of ZAR ([\\d.,]+) at",
          "group": 1,
          "style": "point"
        },
        "currency": { "kind": "fixed", "code": "ZAR" },
        "date": { "kind": "received" },
        "merchant": {
          "part": "body",
          "pattern": "(?i) at (.+?) on your card",
          "group": 1
        },
        "direction": { "kind": "fixed", "direction": "debit" },
        "account_hint": {
          "part": "body",
          "pattern": "card ending (\\d{4})",
          "group": 1
        }
      }
    ]
  }
}"#;
        let payload_path = dir.path().join("payload.json");
        std::fs::write(&payload_path, payload).unwrap();

        let key = SigningKey::from_bytes(&[42u8; 32]);
        let signature: String = key
            .sign(payload.as_bytes())
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let public_key: String = key
            .verifying_key()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        // Install through the same library calls `ops::pack_install` makes —
        // verify the detached signature over the exact file bytes, trust the
        // signer on first use, install — rather than `run_cli(["pack",
        // "install", …])`. That is deliberate and not a shortcut: the pack
        // install *op* registers the process-wide classifier `OnceLock` as a
        // side effect, and `startup_hook_applies_contains_rules_without_\
        // installing_a_pack` in this same test binary asserts it is the first
        // to register. The install path itself is covered end to end in
        // slipscan-packs' `pack_flow` suite; what this test is here for is
        // the hand-authored JSON above, and what the CLI does with the result.
        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        let sig_bytes = read_bytes_arg(&signature, 64, "signature").unwrap();
        let key_bytes = read_bytes_arg(&public_key, 32, "public key").unwrap();
        let verified = slipscan_packs::verify_detached(
            &std::fs::read(&payload_path).unwrap(),
            &sig_bytes,
            &key_bytes,
        )
        .unwrap();
        svc.with_connection(|conn| -> anyhow::Result<()> {
            slipscan_packs::TrustStore::open(conn)?.trust(verified.signer(), "cli test")?;
            slipscan_packs::Installer::open(conn)?.install(&book.id, &verified)?;
            Ok(())
        })
        .unwrap();

        // It installed as its own kind, and created no categories or rules.
        let installed = svc
            .with_connection(|conn| slipscan_packs::Installer::open(conn)?.list(&book.id))
            .unwrap();
        let pack = installed
            .iter()
            .find(|p| p.pack_id == "fixture-bank-alerts")
            .expect("pack installed");
        assert_eq!(pack.kind, slipscan_packs::PackKind::MailRules);
        assert_eq!(pack.version, "1.0.0");
        assert!(svc.category_tree(&book.id).unwrap().is_empty());

        // The rules load and compile for the sync path.
        let rules = slipscan_ingest::email::AlertRules::load(&svc, &book.id).unwrap();
        assert_eq!(rules.rule_count(), 1);
        drop(svc);

        // With rules installed, `mail-sync --alerts` gets past rule loading
        // and stops on the thing that really is missing: a mailbox.
        let err = run_cli(&["mail-sync", "--alerts", "--account", "Card"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("mail.imap.config"), "{err}");

        // A tampered payload never verifies, however well-formed it is: the
        // signature covers the exact bytes, and a mailrules pack is not
        // special-cased anywhere in that.
        let tampered = payload.replace("1.0.0", "1.0.1");
        assert!(
            slipscan_packs::verify_detached(tampered.as_bytes(), &sig_bytes, &key_bytes).is_err()
        );
    }

    /// Turning alerts on in a book with no `mailrules` pack must say so
    /// plainly rather than silently importing nothing forever.
    #[test]
    fn mail_sync_alerts_without_a_pack_explains_itself() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("bare.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Bare"]).unwrap();
        run_cli(&["account", "add", "Card"]).unwrap();

        let err = run_cli(&["mail-sync", "--alerts", "--account", "Card"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("mailrules"), "{err}");
        assert!(err.contains("pack install"), "{err}");
    }

    /// Household members end-to-end through the CLI: add members, default
    /// attribution follows the owning account, override + split via the
    /// CLI, per-member reports come out right, and remove is refused until
    /// reassigned. See ARCHITECTURE.md "Household members & per-person
    /// attribution".
    #[test]
    fn members_attribution_and_reports_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("h.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Household", "--currency", "usd"]).unwrap();
        run_cli(&["account", "add", "Joint"]).unwrap();
        run_cli(&["member", "add", "Alex", "--account", "Joint"]).unwrap();
        run_cli(&["member", "add", "Bailey"]).unwrap();
        run_cli(&["member", "list"]).unwrap();

        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        let account = svc.account_list(&book.id).unwrap().remove(0);
        let members = svc.member_list(&book.id).unwrap();
        let alex = members.iter().find(|m| m.label == "Alex").unwrap().clone();
        let bailey = members
            .iter()
            .find(|m| m.label == "Bailey")
            .unwrap()
            .clone();
        assert_eq!(
            alex.default_account_id.as_deref(),
            Some(account.id.as_str())
        );
        drop(svc);

        // A grocery debit and a salary credit on the joint account.
        let csv_path = dir.path().join("joint.csv");
        std::fs::write(
            &csv_path,
            "Date,Description,Amount\n\
             06/01/2026,GROCERY STORE,-100.00\n\
             06/02/2026,SALARY,2000.00\n",
        )
        .unwrap();
        run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "generic-mdy",
            "--account",
            "Joint",
        ])
        .unwrap();

        let svc = CoreService::open(&db).unwrap();
        let txns = svc
            .transaction_list(&book.id, &TransactionFilter::default())
            .unwrap();
        assert_eq!(txns.len(), 2);
        // Default attribution follows the account's owning member.
        assert!(txns
            .iter()
            .all(|t| t.attributed_member_id.as_deref() == Some(alex.id.as_str())));
        let grocery = txns.iter().find(|t| t.amount_minor == -10_000).unwrap();
        let salary = txns.iter().find(|t| t.amount_minor == 200_000).unwrap();
        let (grocery_id, salary_id) = (grocery.id.clone(), salary.id.clone());
        drop(svc);

        // Re-attribute the grocery run to Bailey; split the salary 3:1.
        run_cli(&["attribute", &grocery_id, &bailey.id]).unwrap();
        run_cli(&[
            "split",
            &salary_id,
            &format!("{}:150000", alex.id),
            &format!("{}:50000", bailey.id),
        ])
        .unwrap();

        let svc = CoreService::open(&db).unwrap();
        assert_eq!(
            svc.transaction_get(&grocery_id)
                .unwrap()
                .attributed_member_id
                .as_deref(),
            Some(bailey.id.as_str())
        );
        assert_eq!(svc.transaction_splits_list(&salary_id).unwrap().len(), 2);
        drop(svc);

        // `report members`/`report settle-up` need --from/--to.
        let err = run_cli(&["report", "members"]).unwrap_err().to_string();
        assert!(err.contains("--from"), "{err}");
        run_cli(&[
            "report",
            "members",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
        ])
        .unwrap();
        run_cli(&[
            "report",
            "settle-up",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
        ])
        .unwrap();

        // Check the actual numbers behind those CLI calls.
        let svc = CoreService::open(&db).unwrap();
        let expense = svc
            .report_member_expense(&book.id, "2026-01-01", "2026-12-31")
            .unwrap();
        let bailey_expense = expense.iter().find(|r| r.member_label == "Bailey").unwrap();
        assert_eq!(
            bailey_expense.total_minor, 10_000,
            "grocery reattributed to Bailey"
        );

        let contribution = svc
            .report_member_contribution(&book.id, "2026-01-01", "2026-12-31")
            .unwrap();
        let alex_contribution = contribution
            .iter()
            .find(|r| r.member_label == "Alex")
            .unwrap();
        assert_eq!(alex_contribution.total_minor, 150_000, "split share");
        let bailey_contribution = contribution
            .iter()
            .find(|r| r.member_label == "Bailey")
            .unwrap();
        assert_eq!(bailey_contribution.total_minor, 50_000);

        let settle = svc
            .report_settle_up(&book.id, "2026-01-01", "2026-12-31")
            .unwrap();
        let alex_settle = settle.iter().find(|r| r.member_label == "Alex").unwrap();
        assert_eq!(alex_settle.contributions_minor, 150_000);
        assert_eq!(alex_settle.expenses_minor, 0);
        assert_eq!(alex_settle.net_minor, 150_000);
        let bailey_settle = settle.iter().find(|r| r.member_label == "Bailey").unwrap();
        assert_eq!(bailey_settle.contributions_minor, 50_000);
        assert_eq!(bailey_settle.expenses_minor, 10_000);
        assert_eq!(bailey_settle.net_minor, 40_000);
        drop(svc);

        // Update: rename and clear the default account.
        run_cli(&[
            "member",
            "update",
            &alex.id,
            "--label",
            "Alexis",
            "--clear-account",
        ])
        .unwrap();
        let svc = CoreService::open(&db).unwrap();
        let alexis = svc.member_get(&alex.id).unwrap();
        assert_eq!(alexis.label, "Alexis");
        assert_eq!(alexis.default_account_id, None);
        drop(svc);

        // Remove is refused while Bailey has attributions; --reassign moves
        // them onto Alex first, so the grocery transaction keeps its member.
        let err = run_cli(&["member", "remove", &bailey.id])
            .unwrap_err()
            .to_string();
        assert!(err.contains("reassign"), "{err}");
        run_cli(&["member", "remove", &bailey.id, "--reassign", &alex.id]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.member_get(&bailey.id).is_err());
        assert_eq!(
            svc.transaction_get(&grocery_id)
                .unwrap()
                .attributed_member_id
                .as_deref(),
            Some(alex.id.as_str())
        );
        drop(svc);

        // "-" clears an attribution.
        run_cli(&["attribute", &grocery_id, "-"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert_eq!(
            svc.transaction_get(&grocery_id)
                .unwrap()
                .attributed_member_id,
            None
        );

        // `list transactions` keeps working and does not choke on a member
        // that no longer exists after cleanup / on an unattributed row.
        drop(svc);
        run_cli(&["list", "transactions"]).unwrap();
    }

    #[test]
    fn parses_fx_actions_and_offline_paths_work() {
        let cli = Cli::try_parse_from(["slipscan", "fx", "status"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Fx {
                action: FxAction::Status
            }
        ));
        let cli = Cli::try_parse_from(["slipscan", "fx", "rate", "USD", "ZAR"]).unwrap();
        match cli.command {
            Command::Fx {
                action: FxAction::Rate { from, to },
            } => {
                assert_eq!(from, "USD");
                assert_eq!(to, "ZAR");
            }
            other => panic!("unexpected {other:?}"),
        }
        let cli = Cli::try_parse_from(["slipscan", "fx", "convert", "USD", "ZAR", "1000"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Fx {
                action: FxAction::Convert {
                    amount_minor: 1000,
                    ..
                }
            }
        ));

        // Offline flows end-to-end: set-url, status, identity convert; a
        // fetch while unconfigured fails fast without touching the network.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("fx.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_fx = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json", "fx"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_fx(&["status"]).unwrap();
        let err = run_fx(&["rate", "USD", "ZAR"]).unwrap_err().to_string();
        assert!(err.to_lowercase().contains("openrate"), "{err}");
        run_fx(&["set-url", "https://fx.example.org/"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        let status = svc.fx_status().unwrap();
        assert!(status.configured);
        assert_eq!(status.base_url.as_deref(), Some("https://fx.example.org"));
        drop(svc);
        run_fx(&["convert", "EUR", "eur", "-500"]).unwrap(); // identity, offline
                                                             // Cache miss (no fetch happened): convert errors instead of fetching.
        assert!(run_fx(&["convert", "USD", "ZAR", "100"]).is_err());
        run_fx(&["set-url", ""]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(!svc.fx_status().unwrap().configured);
    }

    #[test]
    fn fmt_age_humanizes() {
        assert_eq!(fmt_age(None), "unknown");
        assert_eq!(fmt_age(Some(45)), "45s");
        assert_eq!(fmt_age(Some(600)), "10m");
        assert_eq!(fmt_age(Some(93_600)), "26h");
        assert_eq!(fmt_age(Some(700_000)), "8d");
    }

    #[test]
    fn parses_pack_actions() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "pack",
            "install",
            "pack.json",
            "--signature",
            "@pack.sig",
            "--public-key",
            "aabb",
        ])
        .unwrap();
        match cli.command {
            Command::Pack {
                action:
                    PackAction::Install {
                        manifest,
                        signature,
                        public_key,
                    },
            } => {
                assert_eq!(manifest, PathBuf::from("pack.json"));
                assert_eq!(signature, "@pack.sig");
                assert_eq!(public_key, "aabb");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["slipscan", "pack", "list"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pack", "seed"]).is_ok());
        // Signature and key are mandatory for verify.
        assert!(Cli::try_parse_from(["slipscan", "pack", "verify", "pack.json"]).is_err());

        match Cli::try_parse_from(["slipscan", "pack", "uninstall", "za-personal"])
            .unwrap()
            .command
        {
            Command::Pack {
                action: PackAction::Uninstall { pack_id },
            } => assert_eq!(pack_id, "za-personal"),
            other => panic!("unexpected {other:?}"),
        }
        // A pack id is mandatory: `pack uninstall` with no argument must not
        // be a command that could plausibly remove "everything".
        assert!(Cli::try_parse_from(["slipscan", "pack", "uninstall"]).is_err());

        match Cli::try_parse_from(["slipscan", "pack", "benchmark", "--period", "2026-06"])
            .unwrap()
            .command
        {
            Command::Pack {
                action: PackAction::Benchmark { period },
            } => assert_eq!(period, "2026-06"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["slipscan", "pack", "benchmark"]).is_err());
    }

    #[test]
    fn parses_pack_source_actions() {
        match Cli::try_parse_from([
            "slipscan",
            "pack",
            "source",
            "add",
            "team",
            "git:https://example.org/packs.git#stable",
        ])
        .unwrap()
        .command
        {
            Command::Pack {
                action:
                    PackAction::Source {
                        action: PackSourceAction::Add { name, uri },
                    },
            } => {
                assert_eq!(name, "team");
                assert_eq!(uri, "git:https://example.org/packs.git#stable");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["slipscan", "pack", "source", "list"]).is_ok());
        // Both arguments are mandatory: a half-typed source must not become
        // one with a guessed URI.
        assert!(Cli::try_parse_from(["slipscan", "pack", "source", "add", "team"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "pack", "source", "remove"]).is_err());

        match Cli::try_parse_from([
            "slipscan",
            "pack",
            "pull",
            "team",
            "za-personal",
            "--accept-signer",
            "ab12-cd34-ef56-7890",
        ])
        .unwrap()
        .command
        {
            Command::Pack {
                action:
                    PackAction::Pull {
                        source,
                        pack_id,
                        accept_signer,
                        document,
                    },
            } => {
                assert_eq!(source, "team");
                assert_eq!(pack_id, "za-personal");
                assert_eq!(accept_signer.as_deref(), Some("ab12-cd34-ef56-7890"));
                assert!(document.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        // Accepting a signer is opt-in; without it an unknown one refuses.
        assert!(Cli::try_parse_from(["slipscan", "pack", "pull", "team", "za-personal"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pack", "pull", "team"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "pack", "fetch"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "pack", "fetch", "team"]).is_ok());
    }

    /// The fetch half, driven through `run()` exactly as a user would: add a
    /// folder source, publish a signed pack into it, read it back, and see
    /// the preflight verify the signature and report the signer.
    ///
    /// Deliberately stops short of `pack pull`: installing registers the
    /// process-wide pack classifier, and
    /// `startup_hook_applies_contains_rules_without_installing_a_pack` below
    /// depends on being the test that registers it. The install leg is proved
    /// against a real database in `slipscan_server::ops` and in
    /// slipscan-packs' `transport_flow` integration test.
    #[test]
    fn pack_sources_add_publish_and_read_through_the_cli() {
        use ed25519_dalek::{Signer, SigningKey};

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("packs.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let share = dir.path().join("share");
        std::fs::create_dir_all(&share).unwrap();

        let run_pack = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json", "pack"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };

        // A book to install into (and the one `pack fetch` preflights against).
        let svc = CoreService::open(&db).unwrap();
        svc.book_create(NewBook {
            name: "Personal".into(),
            kind: BookKind::Personal,
            currency: None,
            country: Some("ZA".into()),
            region: None,
        })
        .unwrap();
        drop(svc);

        // Nothing configured is a valid, quiet state — and it is the state
        // every install starts in.
        run_pack(&["source", "list"]).unwrap();

        // Plaintext and un-schemed strings are refusals, never guesses.
        assert!(run_pack(&["source", "add", "plain", "http://packs.example"]).is_err());
        assert!(run_pack(&["source", "add", "guessy", "/tmp/packs"]).is_err());

        let share_uri = format!("folder:{}", share.display());
        run_pack(&["source", "add", "share", &share_uri]).unwrap();
        // A name is taken once.
        assert!(run_pack(&["source", "add", "share", &share_uri]).is_err());

        // Publish a signed pack into the folder, through the CLI.
        let payload = serde_json::json!({
            "meta": {
                "id": "za-cli", "name": "CLI pack", "version": "1.0.0",
                "region": "ZA", "author": "cli tests"
            },
            "categories": [{ "key": "food", "name": "Food", "kind": "expense" }],
            "merchant_rules": [{
                "match": "contains", "pattern": "pick n pay",
                "category_key": "food", "confidence": 0.9
            }]
        });
        let document = serde_json::to_vec_pretty(&payload).unwrap();
        let doc_path = dir.path().join("za-cli.json");
        std::fs::write(&doc_path, &document).unwrap();
        let key = SigningKey::from_bytes(&[21u8; 32]);
        let signature: String = key
            .sign(&document)
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let public_key: String = key
            .verifying_key()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        run_pack(&[
            "publish",
            "share",
            doc_path.to_str().unwrap(),
            "--signature",
            &signature,
            "--public-key",
            &public_key,
        ])
        .unwrap();

        // The layout on disk is the one every reader expects: a directory
        // owned by this publisher's fingerprint, and nothing outside it.
        let fingerprint = slipscan_packs::key_fingerprint(&public_key);
        let pub_dir = share.join(&fingerprint);
        assert!(pub_dir.join("za-cli-1.0.0.pack.json").is_file());
        assert!(pub_dir.join("za-cli-1.0.0.pack.json.sig").is_file());
        assert!(pub_dir.join("signer.pub").is_file());
        assert!(pub_dir.join("index.json").is_file());
        assert_eq!(
            std::fs::read(pub_dir.join("za-cli-1.0.0.pack.json")).unwrap(),
            document,
            "the bytes on the share are the bytes that were signed"
        );

        // Reading verifies and preflights, and writes nothing to the book.
        run_pack(&["fetch", "share"]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(
            ops::pack_list(&svc).unwrap().is_empty(),
            "reading a source installs nothing"
        );
        drop(svc);

        // Publishing the same bytes again is a no-op rather than an edit —
        // which is what keeps a synced folder conflict-free.
        run_pack(&[
            "publish",
            "share",
            doc_path.to_str().unwrap(),
            "--signature",
            &signature,
            "--public-key",
            &public_key,
        ])
        .unwrap();

        // Publishing needs a folder; an https source is refused rather than
        // half-attempted.
        run_pack(&["source", "add", "web", "https://packs.example/pub"]).unwrap();
        assert!(run_pack(&[
            "publish",
            "web",
            doc_path.to_str().unwrap(),
            "--signature",
            &signature,
            "--public-key",
            &public_key,
        ])
        .is_err());

        run_pack(&["source", "remove", "share"]).unwrap();
        run_pack(&["source", "list"]).unwrap();
    }

    /// The two CLI surfaces used to disagree about *what a pack is*:
    /// `pack install` accepted both the current payload format and the legacy
    /// flat manifest (`verify_detached`), while `pack verify` parsed the file
    /// itself in the legacy shape only (`verify_pack`) and failed a
    /// current-format pack with `missing field 'id'`. So a user could be told
    /// a pack was invalid and then install it successfully — and be shown a
    /// signer's fingerprint for a pack id (`"ZA Legacy Pack!"`) that the
    /// installer was never going to use (`za-legacy-pack-`). For the one
    /// surface whose job is "inspect the fingerprint before you trust it",
    /// that is worse than not having it.
    ///
    /// This drives the same three files through both surfaces and asserts they
    /// agree. It fails on the old code at the *first* `verify` of the current
    /// payload.
    ///
    /// The install leg goes through the library calls `ops::pack_install`
    /// makes rather than `run(["pack", "install", …])` for the reason spelled
    /// out on `startup_hook_applies_contains_rules_without_installing_a_pack`
    /// below: the install *op* registers a process-wide classifier `OnceLock`,
    /// and that test asserts it is the first in this binary to register.
    /// `Installer::install` itself registers nothing.
    #[test]
    fn pack_verify_and_pack_install_agree_on_every_pack_file_shape() {
        use ed25519_dalek::{Signer, SigningKey};

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("parity.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_pack = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json", "pack"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };

        // Legacy flat manifest: an id the payload charset does not allow, and a
        // child category before its parent. Both were legal in that format, so
        // files like this stay installable — and `verify` has to describe what
        // installing them would actually produce.
        let legacy = serde_json::to_vec_pretty(&serde_json::json!({
            "id": "ZA Legacy Pack!",
            "name": "Legacy groceries",
            "version": "1.0.0",
            "author": "cli parity tests",
            "categories": [
                { "key": "food.dairy", "name": "Dairy", "parent_key": "food",
                  "kind": "expense" },
                { "key": "food", "name": "Food", "kind": "expense" }
            ],
            "rules": [
                { "match_type": "merchant_contains", "pattern": "pick n pay",
                  "category_key": "food", "confidence": 0.95 }
            ],
        }))
        .unwrap();
        // Current payload: no top-level `id` at all — the exact shape the
        // legacy-only reader rejected.
        let current = serde_json::to_vec_pretty(&serde_json::json!({
            "meta": {
                "id": "za-cli-current", "name": "Current groceries",
                "version": "1.0.0", "region": "ZA", "author": "cli parity tests"
            },
            "categories": [{ "key": "food", "name": "Food", "kind": "expense" }],
            "merchant_rules": [{
                "match": "contains", "pattern": "checkers",
                "category_key": "food", "confidence": 0.9
            }],
        }))
        .unwrap();
        // Tampered: one byte of the current payload flipped, still carrying the
        // signature that was genuine before the edit.
        let mut tampered = current.clone();
        let idx = tampered.len() - 4;
        tampered[idx] ^= 0x01;

        let hex = |bytes: &[u8]| -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() };
        // A publisher each, so "this signer is new here" is live for both.
        let legacy_key = SigningKey::from_bytes(&[23u8; 32]);
        let current_key = SigningKey::from_bytes(&[29u8; 32]);

        let write = |name: &str, doc: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, doc).unwrap();
            path.to_str().unwrap().to_string()
        };
        let legacy_path = write("legacy.json", &legacy);
        let current_path = write("current.json", &current);
        let tampered_path = write("tampered.json", &tampered);
        let legacy_sig = hex(&legacy_key.sign(&legacy).to_bytes());
        let current_sig = hex(&current_key.sign(&current).to_bytes());
        let legacy_pub = hex(legacy_key.verifying_key().as_bytes());
        let current_pub = hex(current_key.verifying_key().as_bytes());

        // Verify reports what installing would do *here*, so — like `pack
        // install` and like `pack fetch` — it needs a book to report against,
        // and says so rather than guessing.
        let err = run_pack(&[
            "verify",
            &legacy_path,
            "--signature",
            &legacy_sig,
            "--public-key",
            &legacy_pub,
        ])
        .unwrap_err()
        .to_string();
        assert!(err.contains("no books yet"), "{err}");

        run(
            Cli::try_parse_from(["slipscan", "--db", &db_arg, "init", "--name", "Personal"])
                .unwrap(),
        )
        .unwrap();

        // Surface 1: both shapes verify, the tampered file does not.
        for (label, path, sig, public) in [
            ("legacy", &legacy_path, &legacy_sig, &legacy_pub),
            ("current", &current_path, &current_sig, &current_pub),
        ] {
            run_pack(&["verify", path, "--signature", sig, "--public-key", public])
                .unwrap_or_else(|e| panic!("`pack verify` must accept the {label} shape: {e}"));
        }
        let err = run_pack(&[
            "verify",
            &tampered_path,
            "--signature",
            &current_sig,
            "--public-key",
            &current_pub,
        ])
        .unwrap_err()
        .to_string();
        assert!(err.contains("verification failed"), "{err}");

        // Surface 2: the same three files through the install path, with the
        // same verdicts — and the pack id verify reported is the id that lands.
        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        for (label, doc, sig, public, expect_id) in [
            (
                "legacy",
                &legacy,
                &legacy_sig,
                &legacy_pub,
                "za-legacy-pack-",
            ),
            (
                "current",
                &current,
                &current_sig,
                &current_pub,
                "za-cli-current",
            ),
        ] {
            let sig_bytes = read_bytes_arg(sig, 64, "signature").unwrap();
            let key_bytes = read_bytes_arg(public, 32, "public key").unwrap();
            let preview = svc
                .with_connection(|conn| {
                    slipscan_packs::plan_document(conn, &book.id, doc, &sig_bytes, &key_bytes)
                })
                .unwrap();
            assert_eq!(preview.pack_id, expect_id, "{label}");
            assert_eq!(
                preview.action,
                slipscan_packs::PlannedAction::Install,
                "{label}"
            );

            let verified = slipscan_packs::verify_detached(doc, &sig_bytes, &key_bytes)
                .unwrap_or_else(|e| {
                    panic!("`pack install` must accept the {label} shape too: {e}")
                });
            let installed = svc
                .with_connection(|conn| -> anyhow::Result<slipscan_packs::InstalledPack> {
                    slipscan_packs::TrustStore::open(conn)?
                        .trust(verified.signer(), "cli parity tests")?;
                    Ok(slipscan_packs::Installer::open(conn)?
                        .install(&book.id, &verified)?
                        .pack)
                })
                .unwrap();
            assert_eq!(installed.pack_id, preview.pack_id, "{label}");
            assert_eq!(installed.version, preview.version, "{label}");
            assert_eq!(
                slipscan_packs::key_fingerprint(&installed.signer),
                preview.signer_fingerprint,
                "{label}: verify showed the fingerprint the install recorded"
            );
        }
        let tampered_sig = read_bytes_arg(&current_sig, 64, "signature").unwrap();
        let tampered_key = read_bytes_arg(&current_pub, 32, "public key").unwrap();
        assert!(
            slipscan_packs::verify_detached(&tampered, &tampered_sig, &tampered_key).is_err(),
            "the install path refuses the tampered file that verify refused"
        );

        // Both surfaces now agree it is installed, and refuse it again.
        for (label, doc, sig, public) in [
            ("legacy", &legacy, &legacy_sig, &legacy_pub),
            ("current", &current, &current_sig, &current_pub),
        ] {
            let sig_bytes = read_bytes_arg(sig, 64, "signature").unwrap();
            let key_bytes = read_bytes_arg(public, 32, "public key").unwrap();
            let after = svc
                .with_connection(|conn| {
                    slipscan_packs::plan_document(conn, &book.id, doc, &sig_bytes, &key_bytes)
                })
                .unwrap();
            assert_eq!(
                after.action,
                slipscan_packs::PlannedAction::Refuse,
                "{label}"
            );
            assert!(
                after
                    .refusal
                    .as_deref()
                    .is_some_and(|why| why.contains("already installed")),
                "{label}: {:?}",
                after.refusal
            );
        }
        drop(svc);

        // And `pack verify` still exits 0 on an installed pack: "this would be
        // refused" is a report, not a verification failure.
        run_pack(&[
            "verify",
            &current_path,
            "--signature",
            &current_sig,
            "--public-key",
            &current_pub,
        ])
        .unwrap();
    }

    /// The gap this guards: `register_classifier`'s contract is "call it once
    /// at startup, in every binary that imports transactions", and for a long
    /// time the only caller was the *install* path. A CLI run that did not
    /// install a pack that invocation — which is essentially every run —
    /// therefore skipped every `contains`, `regex` and `keyword` rule already
    /// sitting in the database. Exact rules kept working (installs seed those
    /// into core's own `merchant_mappings`), which is what made the gap quiet.
    ///
    /// The before/after pair is the proof: the same import is uncategorised
    /// with no registration and categorised after `main()`'s hook runs, with
    /// no pack installed through any *surface* in between.
    ///
    /// NOTE for future edits: the classifier is a process-wide `OnceLock`. No
    /// other test in this binary may call `ops::pack_install`,
    /// `ops::pack_install_seeds`, `ops::pack_source_install`, or `run()` with
    /// a `pack install` / `pack seed` / `pack pull` command — any of those
    /// would register it as a side effect and this test would fail on its
    /// `assert!(register_pack_classifier())`. (`pack source`, `pack fetch` and
    /// `pack verify` are safe: reading a source or preflighting a file installs
    /// nothing and registers nothing. So is `Installer::install` called
    /// directly — the registration lives in the *op*, not the installer, which
    /// is why `pack_verify_and_pack_install_agree_on_every_pack_file_shape`
    /// drives its install leg through the library.)
    #[test]
    fn startup_hook_applies_contains_rules_without_installing_a_pack() {
        use slipscan_core::domain::{AccountKind, NewAccount, NewTransaction};
        use slipscan_core::secrets::MemorySecretStore;

        let svc = CoreService::new(
            Db::open_in_memory().unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book = svc
            .book_create(NewBook {
                name: "Test".into(),
                kind: BookKind::Personal,
                currency: None,
                country: Some("ZA".into()),
                region: None,
            })
            .unwrap();
        let account = svc
            .account_create(NewAccount {
                book_id: book.id.clone(),
                name: "Cheque".into(),
                kind: AccountKind::Bank,
                currency: "ZAR".into(),
                institution: None,
                account_number_masked: None,
                opening_balance_minor: None,
            })
            .unwrap();

        // Rules that were installed in some *earlier* session: written
        // straight through the packs library, which is not a surface and
        // registers nothing.
        svc.with_connection(|conn| slipscan_packs::builtin::install_seed_packs(conn, &book.id))
            .unwrap();

        let import = |occurrence: u32| {
            svc.transaction_create(NewTransaction {
                book_id: book.id.clone(),
                account_id: account.id.clone(),
                source: TransactionSource::Import,
                provider_txn_id: None,
                posted_date: "2026-07-01".into(),
                amount_minor: -45_900,
                currency: "ZAR".into(),
                // Matched only by za-personal's `contains "woolworths"` rule:
                // no exact rule, so nothing was seeded into merchant_mappings
                // for it.
                merchant: Some("WOOLWORTHS SANDTON CITY".into()),
                description: None,
                notes: None,
                category_id: None,
                document_id: None,
                dedupe_occurrence: occurrence,
            })
            .unwrap()
        };

        assert!(
            import(0).category_id.is_none(),
            "with no classifier registered, pack rules are invisible to core — \
             this is exactly the bug"
        );

        assert!(
            register_pack_classifier(),
            "this must be the first registration in the test binary; see the \
             note on this test"
        );

        let categorised = import(1)
            .category_id
            .expect("the contains rule must categorise once startup registered the classifier");
        let groceries = svc
            .category_tree(&book.id)
            .unwrap()
            .iter()
            .find(|node| node.category.name == "Groceries")
            .map(|node| node.category.id.clone())
            .expect("za-personal declares a top-level Groceries category");
        assert_eq!(categorised, groceries);
    }

    #[test]
    fn vault_commands_never_take_the_secret_as_an_argument() {
        let cli = Cli::try_parse_from(["slipscan", "vault", "set", "imap.main"]).unwrap();
        match cli.command {
            Command::Vault {
                action: VaultAction::Set { name },
            } => assert_eq!(name, "imap.main"),
            other => panic!("unexpected {other:?}"),
        }
        // A trailing secret positional must be rejected — secrets come from
        // the prompt/stdin only, never argv.
        assert!(Cli::try_parse_from(["slipscan", "vault", "set", "name", "s3cret"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "vault", "replace", "name", "s3cret"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "vault", "list"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "vault", "revoke", "name"]).is_ok());
    }

    /// The key-name comparison is what authenticates a pairing, so skipping
    /// it must be impossible to do by accident: `accept`/`confirm` refuse to
    /// parse unless the user either supplies the key-name they read off the
    /// other device or spells out `--unverified`.
    #[test]
    fn pairing_cannot_skip_the_keyname_check_by_omission() {
        for verb in ["accept", "confirm"] {
            assert!(
                Cli::try_parse_from(["slipscan", "device", verb, "ss-pair1.x"]).is_err(),
                "{verb} must not default to skipping the comparison"
            );
            assert!(Cli::try_parse_from([
                "slipscan",
                "device",
                verb,
                "ss-pair1.x",
                "--expect-keyname",
                "suba-gome-gina-delu-vosu-vazo-poti-kofi-zidu",
            ])
            .is_ok());
            assert!(Cli::try_parse_from([
                "slipscan",
                "device",
                verb,
                "ss-pair1.x",
                "--unverified"
            ])
            .is_ok());
            // Asking for both at once is contradictory, not a precedence
            // puzzle to resolve silently.
            assert!(Cli::try_parse_from([
                "slipscan",
                "device",
                verb,
                "ss-pair1.x",
                "--unverified",
                "--expect-keyname",
                "x",
            ])
            .is_err());
        }
    }

    /// `--expect-keyname` always wins over the skip flag if both somehow
    /// arrive, and an absent pair resolves to a comparison that cannot
    /// succeed rather than to "skip it".
    #[test]
    fn the_keyname_check_resolves_to_the_safe_side() {
        assert!(matches!(
            keyname_check(&Some("abc".to_string()), true),
            KeynameCheck::Expect("abc")
        ));
        assert!(matches!(
            keyname_check(&None, true),
            KeynameCheck::ConfirmedByHuman
        ));
        // Neither flag: never a silent skip.
        assert!(matches!(
            keyname_check(&None, false),
            KeynameCheck::Expect("")
        ));
    }

    /// Wiping the trust root is deliberate: `device reset` needs `--yes`.
    #[test]
    fn resetting_a_device_identity_needs_an_explicit_yes() {
        let cli = Cli::try_parse_from(["slipscan", "device", "reset"]).unwrap();
        match cli.command {
            Command::Device {
                action: DeviceAction::Reset { yes },
            } => assert!(!yes, "reset must not default to yes"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(Cli::try_parse_from(["slipscan", "device", "reset", "--yes"]).is_ok());
    }

    /// There are no accounts: every device subcommand addresses a device by
    /// its public key, and nothing takes an email, user or password.
    #[test]
    fn device_commands_have_no_account_concepts() {
        use clap::CommandFactory;
        let mut device = Cli::command();
        let device = device
            .get_subcommands_mut()
            .find(|sub| sub.get_name() == "device")
            .expect("a `device` subcommand exists");

        let mut seen = 0;
        for sub in device.get_subcommands() {
            for arg in sub.get_arguments() {
                seen += 1;
                let name = arg.get_id().as_str();
                for forbidden in ["email", "user", "username", "password", "account", "login"] {
                    assert!(
                        !name.contains(forbidden),
                        "`device {}` takes a {forbidden} argument ({name})",
                        sub.get_name()
                    );
                }
            }
        }
        // Assert the scan actually walked something.
        assert!(
            seen > 5,
            "the scan is broken, not the code: {seen} args seen"
        );
    }

    #[test]
    fn parses_sync_actions() {
        assert!(matches!(
            Cli::try_parse_from(["slipscan", "sync", "status"])
                .unwrap()
                .command,
            Command::Sync {
                action: SyncAction::Status
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["slipscan", "sync", "seal"])
                .unwrap()
                .command,
            Command::Sync {
                action: SyncAction::Seal
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["slipscan", "sync", "verify"])
                .unwrap()
                .command,
            Command::Sync {
                action: SyncAction::Verify
            }
        ));
        match Cli::try_parse_from(["slipscan", "sync", "log", "--book", "b-1", "--limit", "3"])
            .unwrap()
            .command
        {
            Command::Sync {
                action: SyncAction::Log { book, limit },
            } => {
                assert_eq!(book.as_deref(), Some("b-1"));
                assert_eq!(limit, 3);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// **The sovereignty rule, held at the surface.** Peer enrolment is
    /// manual over an operator-supplied address: there is no directory, no
    /// default endpoint and no LAN assumption.
    ///
    /// Today no `sync` command takes an address at all, because there is no
    /// transport. When one does, this test stays exactly as useful: what it
    /// forbids is not the argument, it is the *default* — a built-in host,
    /// URL or port that a fresh install would reach for without the user
    /// naming it.
    #[test]
    fn no_sync_command_has_a_built_in_endpoint() {
        use clap::CommandFactory;
        let mut cli = Cli::command();
        let sync = cli
            .get_subcommands_mut()
            .find(|sub| sub.get_name() == "sync")
            .expect("a `sync` subcommand exists");

        let mut seen = 0;
        for sub in sync.get_subcommands() {
            for arg in sub.get_arguments() {
                seen += 1;
                let defaults = arg
                    .get_default_values()
                    .iter()
                    .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    .collect::<Vec<_>>();
                for value in &defaults {
                    for forbidden in ["://", "http", "localhost", "127.0.0.1", ".local", ":7151"] {
                        assert!(
                            !value.contains(forbidden),
                            "`sync {}` defaults {} to {value:?} — a fresh install must reach \
                             for no address the user did not name",
                            sub.get_name(),
                            arg.get_id()
                        );
                    }
                }
            }
        }
        assert!(
            seen > 1,
            "the scan is broken, not the code: {seen} args seen"
        );
    }

    #[test]
    fn parses_pay_actions() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "pay",
            "watch",
            "INV-7031",
            "--amount",
            "50000",
            "--currency",
            "ZAR",
            "--label",
            "Rent",
        ])
        .unwrap();
        match cli.command {
            Command::Pay {
                action:
                    PayAction::Watch {
                        reference,
                        amount,
                        currency,
                        label,
                    },
            } => {
                assert_eq!(reference, "INV-7031");
                assert_eq!(amount, Some(50_000));
                assert_eq!(currency.as_deref(), Some("ZAR"));
                assert_eq!(label.as_deref(), Some("Rent"));
            }
            other => panic!("unexpected {other:?}"),
        }
        // Flags are optional; the reference is not.
        assert!(Cli::try_parse_from(["slipscan", "pay", "watch", "X"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "watch"]).is_err());
        assert!(Cli::try_parse_from(["slipscan", "pay", "watches"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "unwatch", "w-1"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "unwatch"]).is_err());

        // Endpoint add takes the URL positionally and requires --label.
        let cli = Cli::try_parse_from([
            "slipscan",
            "pay",
            "endpoint",
            "add",
            "https://hooks.example.org/pay",
            "--label",
            "Shop",
        ])
        .unwrap();
        match cli.command {
            Command::Pay {
                action:
                    PayAction::Endpoint {
                        action: PayEndpointAction::Add { url, label },
                    },
            } => {
                assert_eq!(url, "https://hooks.example.org/pay");
                assert_eq!(label, "Shop");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["slipscan", "pay", "endpoint", "add", "https://x.org/h"]).is_err(),
            "--label is mandatory"
        );
        assert!(Cli::try_parse_from(["slipscan", "pay", "endpoint", "rotate", "e-1"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "endpoint", "remove", "e-1"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "endpoints"]).is_ok());
        assert!(Cli::try_parse_from(["slipscan", "pay", "deliver"]).is_ok());
        let cli = Cli::try_parse_from(["slipscan", "pay", "deliveries", "--failed"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Pay {
                action: PayAction::Deliveries { failed: true }
            }
        ));
    }

    /// What the scratch receiver saw: (lowercased-name) headers and the body.
    type ReceivedWebhook = (Vec<(String, String)>, Vec<u8>);

    /// One HTTP exchange on a loopback scratch socket: accept a single
    /// connection, read one request (headers + Content-Length body), answer
    /// `status`, and hand back the (lowercased-name) headers and body.
    /// Hermetic — nothing leaves 127.0.0.1.
    fn scratch_receiver(
        listener: std::net::TcpListener,
        status: u16,
    ) -> std::thread::JoinHandle<ReceivedWebhook> {
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().expect("accept webhook POST");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
                let n = stream.read(&mut chunk).expect("read request");
                assert!(n > 0, "connection closed before headers completed");
                buf.extend_from_slice(&chunk[..n]);
            };
            let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let headers: Vec<(String, String)> = head
                .lines()
                .skip(1) // request line
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            let content_length: usize = headers
                .iter()
                .find(|(k, _)| k == "content-length")
                .expect("content-length header")
                .1
                .parse()
                .unwrap();
            let mut body = buf[header_end..].to_vec();
            while body.len() < content_length {
                let n = stream.read(&mut chunk).expect("read body");
                assert!(n > 0, "connection closed before body completed");
                body.extend_from_slice(&chunk[..n]);
            }
            let response =
                format!("HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            (headers, body)
        })
    }

    /// The whole payments flow, hermetically: watch a code (CLI) -> import a
    /// matching statement line (CLI) -> match + enqueue -> deliver over the
    /// real reqwest transport to a 127.0.0.1 scratch listener -> delivered,
    /// and the signature verifies with the secret displayed at add time.
    ///
    /// The endpoint add + deliver steps run through a `CoreService` with an
    /// in-memory secret store (they touch the vault; the CLI's own path uses
    /// the OS keychain, which tests must never do) — the same service code
    /// `run()` calls, one constructor apart.
    #[test]
    fn pay_end_to_end_import_matches_and_delivers_a_verifiable_webhook() {
        use slipscan_core::secrets::MemorySecretStore;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let hook_url = format!("http://{}/hook", listener.local_addr().unwrap());
        let receiver = scratch_receiver(listener, 200);

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("pay.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Shop", "--currency", "zar"]).unwrap();
        run_cli(&["account", "add", "Cheque"]).unwrap();
        // Watch narrowed to the exact expected amount.
        run_cli(&[
            "pay",
            "watch",
            "INV-7031",
            "--label",
            "Rent",
            "--amount",
            "234567",
            "--currency",
            "zar",
        ])
        .unwrap();

        // Register the endpoint BEFORE the money arrives (vault-backed, so
        // via the memory-store service) and keep the once-displayed secret
        // like a receiver operator would.
        let svc = CoreService::new(
            slipscan_core::Db::open(&db).unwrap(),
            Box::new(MemorySecretStore::new()),
        );
        let book_id = svc.book_list().unwrap().remove(0).id;
        let created = svc
            .pay_endpoint_add(slipscan_core::domain::NewPayEndpoint {
                book_id: book_id.clone(),
                label: "Shop backend".into(),
                url: hook_url.clone(),
            })
            .unwrap();
        let secret = created.secret;

        // The bank statement lands (the same import path email-fetched CSVs
        // go through): the detection hook inside transaction_create matches
        // and enqueues one delivery.
        let csv_path = dir.path().join("statement.csv");
        std::fs::write(
            &csv_path,
            "Date,Description,Amount\n06/15/2026,EFT CREDIT REF INV-7031 ACC 62001234567,\"2,345.67\"\n",
        )
        .unwrap();
        run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "generic-mdy",
            "--account",
            "Cheque",
        ])
        .unwrap();
        assert_eq!(svc.pay_match_list(&book_id).unwrap().len(), 1);
        let queued = svc.pay_delivery_list(&book_id).unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(
            queued[0].state,
            slipscan_core::domain::PayDeliveryState::Pending
        );

        // Flush the queue over the real reqwest transport — the exact code
        // `slipscan pay deliver` and `mail-sync` run.
        let transport = slipscan_ingest::pay::ReqwestWebhookTransport::new().unwrap();
        let updated = runtime()
            .unwrap()
            .block_on(svc.pay_deliver_due(&transport, &slipscan_core::util::now_iso()))
            .unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(
            updated[0].state,
            slipscan_core::domain::PayDeliveryState::Delivered
        );
        assert_eq!(updated[0].last_status, Some(200));

        // The receiver's view: signed headers + metadata-only JSON body.
        let (headers, body) = receiver.join().unwrap();
        let header = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
                .unwrap_or_else(|| panic!("missing header {name}: {headers:?}"))
        };
        let timestamp = header("x-slipscan-timestamp");
        let nonce = header("x-slipscan-nonce");
        let signature = header("x-slipscan-signature");
        assert_eq!(nonce, updated[0].id, "nonce is the stable delivery id");
        assert!(
            slipscan_core::pay::verify_webhook_signature(
                &secret, timestamp, nonce, &body, signature
            ),
            "the documented receiver-side verification must pass"
        );
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["event"], "payment.matched");
        assert_eq!(payload["reference"], "INV-7031");
        assert_eq!(payload["watch_label"], "Rent");
        assert_eq!(payload["amount_minor"], 234_567);
        assert_eq!(payload["currency"], "ZAR");
        assert_eq!(payload["posted_date"], "2026-06-15");
        let rendered = String::from_utf8_lossy(&body);
        assert!(
            !rendered.contains("62001234567") && !rendered.contains("EFT CREDIT"),
            "webhook bodies carry metadata only, never bank text: {rendered}"
        );

        // Nothing due afterwards — a second flush POSTs nowhere (the scratch
        // listener is gone; any attempt would error loudly).
        let again = runtime()
            .unwrap()
            .block_on(svc.pay_deliver_due(&transport, &slipscan_core::util::now_iso()))
            .unwrap();
        assert!(again.is_empty());

        // CLI listings see the same state.
        run_cli(&["pay", "watches"]).unwrap();
        run_cli(&["pay", "deliveries"]).unwrap();
        run_cli(&["pay", "deliveries", "--failed"]).unwrap();
    }

    /// Watch/unwatch and endpoint listing round-trip through the CLI; the
    /// vault-free surfaces run through `run()` itself.
    #[test]
    fn pay_watch_and_unwatch_round_trip_via_cli() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("w.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Shop"]).unwrap();
        run_cli(&["pay", "watch", "INV-1", "--label", "One"]).unwrap();
        run_cli(&["pay", "watches"]).unwrap();

        // An exact amount without a currency is rejected by core with
        // guidance, surfaced as a CLI error.
        let err = run_cli(&["pay", "watch", "INV-2", "--amount", "500"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("currency"), "{err}");

        let svc = CoreService::open(&db).unwrap();
        let book_id = svc.book_list().unwrap().remove(0).id;
        let watches = svc.pay_watch_list(&book_id).unwrap();
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0].code, "INV-1");
        let id = watches[0].id.clone();
        drop(svc);

        run_cli(&["pay", "unwatch", &id]).unwrap();
        let svc = CoreService::open(&db).unwrap();
        assert!(svc.pay_watch_list(&book_id).unwrap().is_empty());
        // Unknown ids surface as errors.
        assert!(run_cli(&["pay", "unwatch", "nope"]).is_err());
        // Endpoint listing works with none registered.
        run_cli(&["pay", "endpoints"]).unwrap();
    }

    #[test]
    fn parses_serve_flags() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "serve",
            "--listen",
            "0.0.0.0:9000",
            "--lan",
            "--reset-token",
        ])
        .unwrap();
        match cli.command {
            Command::Serve {
                listen,
                lan,
                no_auth,
                reset_token,
            } => {
                assert_eq!(listen, Some("0.0.0.0:9000".parse().unwrap()));
                assert!(lan);
                assert!(!no_auth);
                assert!(reset_token);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn serve_refuses_non_loopback_without_lan_flag() {
        let dir = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from([
            "slipscan",
            "--db",
            dir.path().join("x.sqlite").to_str().unwrap(),
            "serve",
            "--listen",
            "0.0.0.0:9000",
        ])
        .unwrap();
        let err = run(cli).unwrap_err().to_string();
        assert!(err.contains("--lan"), "{err}");

        // --no-auth on a LAN bind is refused even with --lan.
        let cli = Cli::try_parse_from([
            "slipscan",
            "--db",
            dir.path().join("x.sqlite").to_str().unwrap(),
            "serve",
            "--listen",
            "0.0.0.0:9000",
            "--lan",
            "--no-auth",
        ])
        .unwrap();
        let err = run(cli).unwrap_err().to_string();
        assert!(err.contains("--no-auth"), "{err}");
    }

    #[test]
    fn parses_list_books() {
        let cli = Cli::try_parse_from(["slipscan", "list", "books"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::List {
                what: ListTarget::Books
            }
        ));
    }

    #[test]
    fn resolve_book_by_id_name_and_solo_default() {
        let dir = tempfile::tempdir().unwrap();
        let svc = CoreService::open(dir.path().join("t.sqlite")).unwrap();
        assert!(resolve_book(&svc, None).is_err()); // no books yet

        let personal = svc
            .book_create(NewBook {
                name: "Personal".into(),
                kind: BookKind::Personal,
                currency: None,
                country: None,
                region: None,
            })
            .unwrap();
        assert_eq!(resolve_book(&svc, None).unwrap().id, personal.id);
        assert_eq!(
            resolve_book(&svc, Some("Personal")).unwrap().id,
            personal.id
        );
        assert_eq!(
            resolve_book(&svc, Some(&personal.id)).unwrap().id,
            personal.id
        );

        svc.book_create(NewBook {
            name: "Biz".into(),
            kind: BookKind::Business,
            currency: None,
            country: None,
            region: None,
        })
        .unwrap();
        assert!(resolve_book(&svc, None).is_err()); // ambiguous now
        assert!(resolve_book(&svc, Some("nope")).is_err());
        assert_eq!(resolve_book(&svc, Some("Biz")).unwrap().name, "Biz");
    }

    #[test]
    fn parses_data_actions() {
        let cli = Cli::try_parse_from(["slipscan", "data", "status"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Data {
                action: DataAction::Status
            }
        ));
        let cli = Cli::try_parse_from(["slipscan", "data", "move", "/mnt/nas/slipscan"]).unwrap();
        match cli.command {
            Command::Data {
                action: DataAction::Move { target },
            } => assert_eq!(target, PathBuf::from("/mnt/nas/slipscan")),
            other => panic!("unexpected {other:?}"),
        }
        // A target is mandatory.
        assert!(Cli::try_parse_from(["slipscan", "data", "move"]).is_err());
    }

    #[test]
    fn data_status_and_move_manage_the_pointer_folder_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let config_arg = config.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            // --config-dir keeps the pointer (and the default data folder,
            // <config>/data) inside the tempdir — never the real user dirs.
            let mut argv = vec!["slipscan", "--config-dir", &config_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };

        // Status works before anything exists.
        run_cli(&["data", "status"]).unwrap();

        // No --db: init lands in the managed data folder.
        run_cli(&["init", "--name", "Roaming"]).unwrap();
        let default_db = config.join("data").join("slipscan.db");
        assert!(default_db.is_file(), "db created in the managed folder");

        // Move it; the pointer swaps and the database follows.
        let target = dir.path().join("synced-cloud").join("slipscan");
        run_cli(&["data", "move", target.to_str().unwrap()]).unwrap();
        assert!(target.join("slipscan.db").is_file());
        assert!(target.join("documents").is_dir());
        assert!(!default_db.exists(), "old copy removed after the swap");

        // Every later invocation resolves the moved folder via the pointer.
        run_cli(&["list", "books"]).unwrap();
        run_cli(&["data", "status"]).unwrap();

        // Moving onto a folder that already has a SlipScan database is the
        // distinct offer-open refusal.
        let occupied = dir.path().join("occupied");
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(occupied.join("slipscan.db"), b"foreign books").unwrap();
        let err = run_cli(&["data", "move", occupied.to_str().unwrap()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("open"), "{err}");

        // `data move` refuses to mix with an explicit --db override.
        let err = run(Cli::try_parse_from([
            "slipscan",
            "--config-dir",
            &config_arg,
            "--db",
            "/tmp/elsewhere.sqlite",
            "data",
            "move",
            "/tmp/nope",
        ])
        .unwrap())
        .unwrap_err()
        .to_string();
        assert!(err.contains("--db"), "{err}");
    }

    #[test]
    fn fmt_bytes_humanizes() {
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(2048), "2.0 KiB");
        assert_eq!(fmt_bytes(5 * 1024 * 1024), "5.0 MiB");
    }

    #[test]
    fn fmt_minor_is_sign_safe() {
        assert_eq!(fmt_minor(123_456), "1234.56");
        assert_eq!(fmt_minor(-45), "-0.45");
        assert_eq!(fmt_minor(0), "0.00");
        assert_eq!(fmt_minor(-123_405), "-1234.05");
    }

    #[test]
    fn read_bytes_arg_accepts_hex_and_rejects_bad_lengths() {
        assert_eq!(read_bytes_arg("aabb", 2, "sig").unwrap(), vec![0xaa, 0xbb]);
        assert!(read_bytes_arg("aabb", 3, "sig").is_err());
        assert!(read_bytes_arg("zz", 1, "sig").is_err());

        // @file with raw bytes of the exact length.
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("sig.bin");
        std::fs::write(&raw, [1u8; 64]).unwrap();
        let arg = format!("@{}", raw.display());
        assert_eq!(read_bytes_arg(&arg, 64, "sig").unwrap(), vec![1u8; 64]);

        // @file with hex text.
        let hex = dir.path().join("sig.hex");
        std::fs::write(&hex, "0102\n").unwrap();
        let arg = format!("@{}", hex.display());
        assert_eq!(read_bytes_arg(&arg, 2, "sig").unwrap(), vec![1, 2]);
    }

    // -- net worth --------------------------------------------------------

    #[test]
    fn parses_networth_actions() {
        let cli = Cli::try_parse_from(["slipscan", "networth", "capture"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Networth {
                action: NetworthAction::Capture { date: None }
            }
        ));
        let cli =
            Cli::try_parse_from(["slipscan", "networth", "capture", "--date", "2026-01-01"])
                .unwrap();
        match cli.command {
            Command::Networth {
                action: NetworthAction::Capture { date },
            } => assert_eq!(date.as_deref(), Some("2026-01-01")),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            Cli::try_parse_from(["slipscan", "networth", "backfill"])
                .unwrap()
                .command,
            Command::Networth {
                action: NetworthAction::Backfill
            }
        ));
        let cli = Cli::try_parse_from([
            "slipscan",
            "networth",
            "series",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
        ])
        .unwrap();
        match cli.command {
            Command::Networth {
                action: NetworthAction::Series { from, to },
            } => {
                assert_eq!(from, "2026-01-01");
                assert_eq!(to, "2026-12-31");
            }
            other => panic!("unexpected {other:?}"),
        }
        // `series` requires both bounds.
        assert!(Cli::try_parse_from(["slipscan", "networth", "series", "--from", "2026-01-01"])
            .is_err());
    }

    #[test]
    fn networth_capture_backfill_series_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("nw.sqlite");
        let db_arg = db.to_str().unwrap().to_string();
        let run_cli = |args: &[&str]| {
            let mut argv = vec!["slipscan", "--db", &db_arg, "--json"];
            argv.extend_from_slice(args);
            run(Cli::try_parse_from(argv).unwrap())
        };
        run_cli(&["init", "--name", "Personal", "--currency", "zar"]).unwrap();
        run_cli(&["account", "add", "Cheque"]).unwrap();

        // Opens at 0; +500.00 on Jan 10, -200.00 on Jan 20 (MM/DD/YYYY).
        let csv_path = dir.path().join("cheque.csv");
        std::fs::write(
            &csv_path,
            "Date,Description,Amount\n\
             01/10/2026,DEPOSIT,500.00\n\
             01/20/2026,GROCERY,-200.00\n",
        )
        .unwrap();
        run_cli(&[
            "import",
            csv_path.to_str().unwrap(),
            "--preset",
            "generic-mdy",
            "--account",
            "Cheque",
        ])
        .unwrap();

        // Backfill reconstructs 2026-01-10 and 2026-01-20 from the ledger;
        // an explicit capture adds a third point after both transactions.
        run_cli(&["networth", "backfill"]).unwrap();
        run_cli(&["networth", "capture", "--date", "2026-01-25"]).unwrap();
        run_cli(&["networth", "series", "--from", "2026-01-01", "--to", "2026-01-31"]).unwrap();

        let svc = CoreService::open(&db).unwrap();
        let book = svc.book_list().unwrap().remove(0);
        let series = svc
            .networth_series(&book.id, "2026-01-01", "2026-01-31")
            .unwrap();
        assert_eq!(series.currency, "ZAR");
        assert_eq!(series.points.len(), 3, "{:#?}", series.points);
        let point = |d: &str| series.points.iter().find(|p| p.as_of_date == d).unwrap();
        assert_eq!(point("2026-01-10").total_minor, 50_000);
        assert_eq!(point("2026-01-20").total_minor, 30_000);
        assert_eq!(point("2026-01-25").total_minor, 30_000);

        // Re-running backfill after the explicit capture must not duplicate
        // or disturb anything already on record.
        run_cli(&["networth", "backfill"]).unwrap();
        let unchanged = svc
            .networth_series(&book.id, "2026-01-01", "2026-01-31")
            .unwrap();
        assert_eq!(unchanged, series);
    }
}
