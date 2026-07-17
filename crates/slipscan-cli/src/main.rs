//! slipscan — command-line interface.
//!
//! Skeleton: `init`, `import`, `serve`, `list`. Binaries may use anyhow.

use anyhow::Context;
use clap::{Parser, Subcommand, ValueEnum};
use slipscan_core::domain::{BookKind, NewBook};
use slipscan_core::CoreService;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "slipscan",
    version,
    about = "Self-hosted personal finance + accounting"
)]
struct Cli {
    /// Path to the SlipScan SQLite database file.
    #[arg(long, global = true, default_value = "slipscan.sqlite")]
    db: PathBuf,

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
    },
    /// Import a document or statement file (placeholder).
    Import {
        /// File to import.
        path: PathBuf,
    },
    /// Run the headless server (binds 127.0.0.1 unless overridden).
    Serve {
        /// Listen address, e.g. 127.0.0.1:7151.
        #[arg(long)]
        listen: Option<SocketAddr>,
    },
    /// List entities.
    List {
        #[arg(value_enum)]
        what: ListTarget,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Init { name, kind } => {
            let service = CoreService::open(&cli.db)
                .with_context(|| format!("opening database at {}", cli.db.display()))?;
            if let Some(name) = name {
                let book = service.book_create(NewBook {
                    name,
                    kind: kind.into(),
                    currency: None,
                    country: None,
                })?;
                println!("Created book {} ({})", book.name, book.id);
            }
            println!("Database ready at {}", cli.db.display());
        }
        Command::Import { path } => {
            println!(
                "Import of {} is not implemented yet (lands with slipscan-ingest).",
                path.display()
            );
        }
        Command::Serve { listen } => {
            let runtime = tokio::runtime::Runtime::new().context("starting async runtime")?;
            let addr = listen.unwrap_or(slipscan_server::DEFAULT_ADDR);
            println!("Serving on http://{addr}");
            runtime.block_on(slipscan_server::serve(Some(addr)))?;
        }
        Command::List { what } => {
            let service = CoreService::open(&cli.db)
                .with_context(|| format!("opening database at {}", cli.db.display()))?;
            match what {
                ListTarget::Books => {
                    for book in service.book_list()? {
                        println!("{}\t{}\t{}", book.id, book.kind, book.name);
                    }
                }
                ListTarget::Accounts | ListTarget::Transactions | ListTarget::Documents => {
                    println!("Listing requires a --book flag; coming with the full CLI.");
                }
            }
        }
    }
    Ok(())
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
    fn parses_init_and_serve() {
        let cli = Cli::try_parse_from([
            "slipscan",
            "--db",
            "/tmp/x.sqlite",
            "init",
            "--name",
            "Personal",
        ])
        .unwrap();
        assert_eq!(cli.db, PathBuf::from("/tmp/x.sqlite"));
        match cli.command {
            Command::Init { name, .. } => assert_eq!(name.as_deref(), Some("Personal")),
            other => panic!("unexpected {other:?}"),
        }

        let cli = Cli::try_parse_from(["slipscan", "serve", "--listen", "127.0.0.1:9000"]).unwrap();
        match cli.command {
            Command::Serve { listen } => {
                assert_eq!(listen, Some("127.0.0.1:9000".parse().unwrap()));
            }
            other => panic!("unexpected {other:?}"),
        }
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
}
