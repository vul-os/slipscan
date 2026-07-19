//! slipscan — command-line interface.
//!
//! Subcommands: `init`, `import`, `extract`, `mail-sync`, `recon`, `report`,
//! `fx`, `pack`, `vault`, `serve`, `list`. Every command has human-readable
//! output by default and `--json` for machines. Binaries may use anyhow.
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
use slipscan_core::domain::{
    Account, Book, BookKind, DocumentSource, NewBook, TransactionFilter, TransactionSource,
};
use slipscan_core::secrets::SecretString;
use slipscan_core::CoreService;
use slipscan_ingest::bank::import_statement_lines;
use slipscan_ingest::email::imap::{connect_tls, ImapConfig, ImapConnector};
use slipscan_ingest::email::import_message_documents;
use slipscan_ingest::import::{import_document_file, FileImport};
use slipscan_ingest::{IngestError, MailboxConnector, SettingsCursorStore};
use slipscan_server::vault::VaultHandle;
use slipscan_server::{ops, AuthToken, ServerConfig};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

/// Settings key holding the IMAP mailbox config JSON ([`ImapConfig`] —
/// contains no secret material, only the vault credential name).
const MAIL_CONFIG_SETTING: &str = "mail.imap.config";

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
    /// Run extraction on pending slips via the configured provider.
    Extract {
        /// Maximum documents to process this run.
        #[arg(long, default_value_t = 25)]
        limit: usize,
    },
    /// Poll the configured IMAP mailbox and import receipt documents.
    MailSync {
        /// Where to store fetched attachments (default: the data folder's
        /// `documents/` store, or `<db dir>/slipscan-documents` with --db).
        #[arg(long)]
        storage_dir: Option<PathBuf>,
    },
    /// Reconciliation: suggest and confirm matches.
    Recon {
        #[command(subcommand)]
        action: ReconAction,
    },
    /// Reports: trial balance, profit & loss, balance sheet, tax summary.
    Report {
        #[arg(value_enum)]
        kind: ReportKind,
        /// CSV output (trial balance only).
        #[arg(long)]
        csv: bool,
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
    /// Credential vault: set/replace/revoke/list. Secrets are read from a
    /// no-echo prompt (or stdin when piped) and are never displayed.
    Vault {
        #[command(subcommand)]
        action: VaultAction,
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
    /// Verify a pack's signature without installing it.
    Verify {
        manifest: PathBuf,
        #[arg(long)]
        signature: String,
        #[arg(long)]
        public_key: String,
    },
    /// List installed packs.
    List,
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

fn main() -> anyhow::Result<()> {
    run(Cli::parse())
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

        Command::MailSync { ref storage_dir } => {
            let svc = open_service(&env.db)?;
            let book = resolve_book(&svc, cli.book.as_deref())?;
            let raw = svc.settings_get(MAIL_CONFIG_SETTING)?.ok_or_else(|| {
                anyhow!(
                    "no mailbox configured; store an IMAP config JSON under settings key \
                     {MAIL_CONFIG_SETTING:?} with fields host, port, folder, username, \
                     password_secret_ref (the name of a vault credential)"
                )
            })?;
            let config: ImapConfig =
                serde_json::from_str(&raw).context("parsing the stored IMAP config")?;
            let vault = VaultHandle::open(&env.db)?;
            let password = vault
                .use_with(&config.password_secret_ref, |secret| {
                    Ok(SecretString::new(secret.expose_secret()))
                })
                .with_context(|| {
                    format!(
                        "loading vault credential {0:?} (store it with `slipscan vault set {0}`)",
                        config.password_secret_ref
                    )
                })?;
            drop(vault);
            // Default is the unified documents store: the managed folder's
            // `documents/`, or `<db dir>/slipscan-documents` with `--db`.
            let dir = storage_dir.clone().unwrap_or_else(|| env.docs_dir.clone());

            let rt = runtime()?;
            let (fetched, imported, duplicates) = rt.block_on(async {
                let transport = connect_tls(&config, &password).await?;
                let cursors = SettingsCursorStore::new(&svc);
                let mut connector = ImapConnector::new(config.clone(), transport, cursors);
                let messages = connector.fetch_unseen().await?;
                let mut imported = 0usize;
                let mut duplicates = 0usize;
                for message in &messages {
                    let outcome = import_message_documents(&svc, &book.id, &dir, message)?;
                    imported += outcome.documents.len();
                    duplicates += outcome.duplicates;
                    connector.mark_processed(&message.id).await?;
                }
                anyhow::Ok((messages.len(), imported, duplicates))
            })?;
            drop(password);

            let out = serde_json::json!({
                "messages": fetched,
                "documents_imported": imported,
                "duplicates": duplicates,
                "storage_dir": dir.display().to_string(),
            });
            emit(cli.json, &out, || {
                println!(
                    "Fetched {fetched} message(s): {imported} document(s) imported, \
                     {duplicates} duplicate(s)."
                );
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

        Command::Report { kind, csv } => {
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
                    let bytes = std::fs::read(manifest)
                        .with_context(|| format!("reading {}", manifest.display()))?;
                    let sig = read_bytes_arg(signature, 64, "signature")?;
                    let key = read_bytes_arg(public_key, 32, "public key")?;
                    let verified = slipscan_packs::verify_pack(&bytes, &sig, &key)
                        .context("pack verification failed")?;
                    let out = serde_json::json!({
                        "valid": true,
                        "id": verified.id,
                        "name": verified.name,
                        "version": verified.version,
                        "author": verified.author,
                        "categories": verified.categories.len(),
                        "rules": verified.rules.len(),
                    });
                    emit(cli.json, &out, || {
                        println!(
                            "OK: {} {} ({} categories, {} rules) — signature valid",
                            verified.name,
                            verified.version,
                            verified.categories.len(),
                            verified.rules.len()
                        );
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
            // The data_status route only makes sense when the served
            // database *is* the managed folder's; with an explicit --db the
            // route answers 503 instead of describing the wrong folder.
            let data_dir = env.managed.then(|| env.resolver.clone());
            runtime()?.block_on(slipscan_server::serve(
                svc,
                Some(vault),
                Some(fx_transport),
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
                    emit(cli.json, &txns, || {
                        for t in &txns {
                            println!(
                                "{}\t{}\t{}\t{}\t{}",
                                t.id,
                                t.posted_date,
                                fmt_minor(t.amount_minor),
                                t.currency,
                                t.merchant.as_deref().unwrap_or("-")
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
            Command::MailSync { storage_dir } => {
                assert_eq!(storage_dir, Some(PathBuf::from("/tmp/docs")));
            }
            other => panic!("unexpected {other:?}"),
        }
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
                Command::Report { kind, csv } => {
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
        // Signature and key are mandatory for verify.
        assert!(Cli::try_parse_from(["slipscan", "pack", "verify", "pack.json"]).is_err());
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
}
