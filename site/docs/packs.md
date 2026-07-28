# Classification Packs

Good transaction categorisation needs knowledge: that `PNP FAM KENILWORTH` is Pick n Pay and Pick n Pay is groceries — or that `TESCO STORES 2041` is groceries and `7-ELEVEN` is a convenience store. Cloud products learn this from everyone's data on their servers. SlipScan ships that knowledge as **packs** — signed, versioned files containing taxonomies and rules, **never data**.

This is [mantra #5](ARCHITECTURE.md#non-negotiables-the-mantra): community sharing moves rules, never data. Packs are also how SlipScan stays [global by default](ARCHITECTURE.md#global-by-default--regions-are-data-not-code): a country's merchant knowledge is region-profile *data* carried by packs, never code — a pack declares its region (or none, making it global), and packs for any country plug into the same machinery.

> **Status.** Installing a pack — `slipscan pack install`, the server's `pack_install` — now runs the real installer: signature checked, signer trusted on first use and **pinned** to the pack id, versions only moving forward, taxonomy mapped onto your categories, rules written to the `pack_rules` tables the classifier reads, the whole thing audited.
>
> **Installed pack rules are consulted during categorisation, on every surface.** Core owns no classification knowledge (slipscan-packs depends on core, never the reverse), so a binary registers the pack classifier once at startup — one line, `slipscan_packs::register_classifier()`. SlipScan ships two binaries and both call it before doing anything else: the CLI's `main()` and the desktop app's `run()`. The self-host server is not a third — `slipscan serve` *is* the CLI binary, so it is registered before it binds a socket. The install ops (`pack_install`, `pack_install_seeds`) register too, which is what covers a third-party process embedding `slipscan-server` as a library; it was never the server that needed the extra help. Before startup registration existed, a process that had not installed a pack *that run* silently skipped every `contains`, `regex` and `keyword` rule already in the database — only `merchant_exact` rules kept working, because installs seed those into core's own merchant mappings.
>
> **Packs can now be fetched, not only hand-carried.** A pack can arrive over a local file, a watched folder or USB stick, a git remote, or plain HTTPS — the same signed bytes over any of them, verified before anything touches the database (["Getting a pack"](#getting-a-pack)). There is no registry and no default source: the list starts empty, only you write to it, and a fresh install makes no outbound request about packs until you name one. Publishing into a folder source is wired on the CLI and the HTTP surface; the desktop reads sources and installs from them, and has no publish screen.
>
> A `pack sign` CLI helper and mapping export are still not wired; each is called out below.

## What's in a pack

A pack is a JSON payload plus a detached ed25519 signature over its exact bytes (implemented in `crates/slipscan-packs`):

```jsonc
{
  "meta": {
    "id": "za-groceries",          // stable pack id, lowercase [a-z0-9-]
    "name": "South African groceries",
    "version": "1.2.0",            // strict semver
    "region": "ZA",                // ISO 3166-1 alpha-2; omit for a global pack
    "description": "Common SA grocery merchants",
    "author": "community"
  },
  "categories": [
    { "key": "groceries",       "name": "Groceries", "kind": "expense" },
    { "key": "groceries.dairy", "name": "Dairy", "parent_key": "groceries", "kind": "expense" }
  ],
  "merchant_rules": [
    { "match": "contains", "pattern": "pick n pay",
      "category_key": "groceries", "confidence": 0.95 }
  ],
  "keyword_rules": [
    { "keywords": ["airtime", "data bundle"], "category_key": "groceries", "confidence": 0.6 }
  ]
}
```

Packs are also distributed as a directory of `pack.toml` (human-readable manifest carrying the signature) + `payload.json` (the signed bytes) — same content, described in the `format` module docs.

**The first pack format still installs.** Its flat shape — `id`/`name`/`version`/`categories`/`rules` at the top level, `match_type: "merchant_contains"` — is converted on the way in and installed through the same path, so files already on your disk keep working. Two accommodations are made for them, both deliberate: a pack id is lowercased into the payload charset, and categories declared child-first are re-ordered (the payload requires parents first). Legacy manifests predate `region`, so a converted pack is global.

- **Categories** form a hierarchy via `parent_key`; `key` is a stable slug that installation maps onto your local category ids, so packs compose without id collisions.
- **Rules** match merchants (`exact`, `contains`, `regex`) and suggest a category key with a confidence; keyword rules additionally search the transaction description and rank below every merchant rule.
- **`region`** is an optional ISO 3166-1 alpha-2 code declaring which country's merchants the pack targets; a pack with no region is **global** and applies anywhere. The region is recorded per install (existing installs are migrated: the original ZA seed payloads always declared `"ZA"`, so old databases come out labeled correctly).
- That's the complete vocabulary. There is nowhere in the format to put a transaction, an amount, or a person.

**Three kinds, derived from content.** A pack's kind is not declared — it follows from which section it carries, so it cannot disagree with the payload: `taxonomy` (categories and rules, the shape above), `benchmark` (aggregate cohort stats), and `mailrules` (bank-alert email formats). The latter two are *pure*: validation refuses a benchmark or mailrules pack that also carries categories or rules. All three go through one installer, so signing, TOFU pinning, semver ordering and the audit trail are identical for each. (Books created before `mailrules` existed are migrated in place on open — the `kind` column's constraint listed only the two older kinds, and `CREATE TABLE IF NOT EXISTS` cannot widen it.)

## Signing and trust

Every pack is signed: an ed25519 signature over the exact document bytes, verified on install (`verify_detached` in `slipscan-packs`). Unsigned or tampered packs are rejected — not warned about, rejected.

Trust is per-publisher and there is no central authority deciding who may publish. You still pass the publisher's `--public-key` on every install, and that act *is* the trust decision — so the first time a key is used it is **recorded in the trust store** (trust-on-first-use, with a fingerprint you can check out-of-band like an SSH host key), and the pack id is **pinned** to it. From then on:

- a later version of that pack signed by a **different** key is rejected outright, even if that other key is itself trusted — the pin is what a bare `--public-key` argument could never give you;
- the well-known key the builtin seed packs are signed with can never be trusted for external packs, so nothing outside the binary can dress itself up as builtin.

**A fetched pack is stricter.** Passing `--public-key` on the command line is a decision you made about a key you were holding; a pack that arrives over a transport was hand-carried by nobody. So on the fetch path an unknown signer is **refused** until you pass the exact fingerprint you were shown (`--accept-signer`, or the tick on the desktop's Sources panel) — see ["Getting a pack"](#getting-a-pack). The pin is unaffected either way: a changed publisher key is refused on every path, with no override anywhere.

The fingerprint is put in front of you where the decision is made: the desktop's verify step shows it, and says whether that key is already trusted, before the install button does anything; every installed pack lists its signer fingerprint afterwards. What no surface exposes is the store itself — there is no screen or command that lists trusted signers or revokes one, though `slipscan_packs::TrustStore` implements both.

## Installing a pack

- CLI: `slipscan pack install <pack.json> --signature <hex|@file> --public-key <hex|@file>` — verification failure rejects the pack before anything is applied. `slipscan pack verify` checks a pack without installing; `slipscan pack list` shows what's installed.
- Server: the `pack_install` operation ([API.md](API.md)) with the same three inputs.
- Desktop: a top-level **Packs** screen (it moved out of Settings). Pick the pack file, paste or pick its signature and public key, and it verifies first: you see the signer's fingerprint, whether that key is already trusted, and what the install would do (new install, or an upgrade from which version), and only then commit. The same screen upgrades and uninstalls.
- Installation is per-book, and **versions only move forward**: re-installing the version you already have is refused (`already installed`) and downgrades are rejected. Installing a *higher* version upgrades in place — categories keep their ids, your renames survive, and rules are replaced wholesale.
- Your data is untouched either way, and rules are never applied retroactively: a pack classifies what you import from then on, not what is already in the book.

**Upgrading from a pre-installer database.** Packs installed by the old path lived in one `packs.installed` settings blob and were never consulted by anything. They are adopted into the pack tables the first time you install or list packs: the categories that install created are matched by name and parent (never duplicated), and its rules become live rules. Nothing is fabricated on the way in — that blob stored no signature and no public key, so the adopted row records no signer and pins nothing, which leaves a properly signed release of the same pack free to take it over later. The settings key itself is kept verbatim, and an entry that cannot be adopted is still listed, so an install that happened never disappears from the record.

## Getting a pack

Installing a pack was only ever half the story: for a long time every pack had to arrive as a local file, by hand. It can now arrive over a **transport** — and the design of that is one sentence:

> **The same signed bytes over any transport, because the signature is what is trusted, not the channel.**

A pack that came off a USB stick, out of a git remote, over HTTPS, or from a file a friend emailed you is the *identical byte sequence*, and it is checked the *identical way*. No transport grants any authority: every one of them ends at raw bytes whose only exit is `verify_detached`, and the installer still accepts nothing but a `VerifiedPack`. Fetching cannot reach installed state without passing every gate below, in this order.

(The model is borrowed. FlowStock's folder sync — "files as transport, never as truth", each writer owning its own append-only file so a file-sync service never has a conflict to resolve — is where the layout comes from; the credit is in `crates/slipscan-packs/src/transport/mod.rs`.)

### The four transports, and the seam

| Source URI | What it is | Notes |
|---|---|---|
| `file:<path>` | One pack document with its sidecars | Exactly the file you named — a second pack sitting beside it is *not* offered |
| `folder:<path>` | A directory in the pack layout | **The sneakernet case**: a Dropbox/Syncthing share, a NAS mount, a USB stick. Local, and it says so |
| `git:<url>[#ref]` | A git remote | Shallow-cloned into a cache beside your data folder, then read as a folder |
| `https://<url>` | A base URL serving the same layout | Cannot be listed, so it needs an `index.json` |

Plain `http://` is **refused**. The signature would still protect the bytes — but a plaintext fetch tells the network which packs you run, and that is data about you.

A URL that **embeds a password** (`user:pass@host`) is refused too, and the refusal does not echo the URL back: a source URI is stored as ordinary metadata and printed by `pack source list`, so a secret in one would be a secret in a listing. Front a private host with network-level auth, or use `git:` over SSH — a bare `git@host` username carries no secret and is accepted. (Same rule core applies to the FX endpoint.)

Adding a fifth (p2p, DMTAP, anything) means implementing one trait with two methods — "read this relative name", "list the names you have". Discovery, index parsing, sidecar resolution, size limits, verification, trust and installation are written once, above that seam, and none of them know which transport they are standing on. That is the whole extension point; it does not need reopening.

### The layout, and why it never conflicts

Each publisher owns a directory named for their key's fingerprint, and writes only inside it:

```text
<source root>/
  index.json                          # optional; may be nothing but `includes`
  ab12-cd34-ef56-7890/                # one publisher, named by key fingerprint
    signer.pub                        # their ed25519 public key (hex)
    index.json                        # their own catalogue, append-only
    za-personal-1.2.0.pack.json       # the exact signed bytes
    za-personal-1.2.0.pack.json.sig   # detached signature
```

Two publishers sharing one synced folder never write the same path, so a file-sync service never has a conflict to resolve — that is the FlowStock rule, applied. A given `<id>-<version>.pack.json` is write-once (a version's bytes never change), so even re-publishing is not an edit: it is a no-op, reported as one. And because the directory name is derived from the key it holds, a key filed in the wrong place is caught for free.

Dropping three loose files (`x.pack.json`, `x.pack.json.sig`, `x.pack.json.pub`) into the root also works, with no index at all. That is the "someone handed me a stick" case, and it should not require ceremony.

**Indexes are hints, never authority.** An `index.json` only says *what to fetch*. Every fact you are shown — id, version, kind, region, signer — is re-derived from the verified payload afterwards, and an index that misdescribes what it points at is a refusal, not a cosmetic disagreement. `includes` lets a shared root aggregate per-publisher catalogues by reference, so adding a publisher appends one line instead of rewriting anyone else's file. (This is Kerf's distributed-Workshop rule — "category and search indexes are derived, never authoritative" — and it is the part of that design that transfers; see [Why not the full Workshop model](#why-not-the-full-workshop-model).)

### No registry, and no default endpoint

**There is no built-in source, at any layer.** The source list starts empty, nothing but a user ever writes to it, and `slipscan-packs` contains no URL and no HTTP client — the one network verb is a trait a surface injects. A fresh install therefore makes **zero network calls about packs**, forever, until somebody types a source. That is not a promise in a comment: with no HTTP transport supplied, an `https:` source cannot be opened at all, and the refusal is the mechanism.

Nothing about your book is ever sent to a source. Fetching is a GET; there is no request body, no telemetry, no "which packs do you have installed" round-trip.

### The gates, in order

1. **The signature**, on the bytes, before the database is opened. Bytes that do not verify never become a `VerifiedPack`, so nothing below is reachable for them. The catalogue's claims are cross-checked against the signed payload here too: a source cannot list one pack and deliver another.
2. **The pin.** A pack id belongs to the key that first signed it. A different key offering "a newer version" is refused *before* the trust decision, so a signer change cannot leave a newly-trusted key behind as a souvenir of a failed install. **There is no flag, on any surface, that overrides this.**
3. **The signer.** Trust-on-first-use — where "first use" means *you saw the fingerprint and said yes*, not "it showed up". A pack that arrives over a transport was not hand-carried with its key the way `pack install <file> --public-key <hex>` is, so an unknown signer is refused until you pass the very fingerprint you are being asked about. **Naming a source is not consent to everything that source will ever serve.**
4. **Versions**, forward only, exactly as for a local file.

A read (`pack fetch`) runs gates 1 and 2–4 as a *preflight* and writes nothing at all, so the fingerprint is in front of you before any decision is possible.

### On all three surfaces

- **CLI** — `slipscan pack source add <name> <uri>` / `remove` / `list`; `slipscan pack fetch <source>` lists what is offered with each signer's fingerprint and what installing would do; `slipscan pack pull <source> <pack-id> [--accept-signer <fingerprint>] [--document <name>]` verifies and installs. `slipscan pack publish <source> <pack.json> --signature --public-key` writes into a `folder:` source (a git checkout is a folder too — publish into it and commit).
- **Server** — `pack_source_add` / `pack_source_remove` / `pack_source_list` / `pack_source_fetch` / `pack_source_install` / `pack_source_publish` ([API.md](API.md)). `file:` and `folder:` sources work on a server given no network capability at all; `git:` and `https:` need a transport factory, and refuse loudly without one rather than falling back to anything.
- **Desktop** — a **Sources** panel on the Packs screen: add and forget sources (each labelled *local only* or *reaches the network*), read one, and see every offer with its signer fingerprint and its verdict. A signer this machine has never seen renders an explicit "I have compared this fingerprint against the publisher's own channel" tick that arms the install button; without it the button is inert. A changed publisher key renders as the refusal it is, with nothing to click past.

### Publishing

`pack publish` takes the same three inputs an install does — document, signature, key — and **verifies them first**, so nothing unverified is ever written into a shared folder under a publisher's name. It writes the layout above and appends to your own index, never anyone else's. Distribution after that is somebody else's problem: sync the folder, commit the repo, serve the directory, mail the stick.

### Why not the full Workshop model

Kerf's [distributed Workshop](https://github.com/vul-os/kerf) runs on DMTAP-PUB: signed, content-addressed objects on per-identity append-only feeds, chunked and swarmed, with derived indexes any node can rebuild. It was considered here, and **two of its three ideas were adopted outright**:

- **per-publisher append-only feeds** — that *is* the publisher-fingerprint directory with its own index, and it is where the conflict-free property comes from;
- **derived, never authoritative indexes** — adopted verbatim, including the refusal when an index disagrees with what it points at.

The third — **content addressing, chunking and swarming** — was **not** adopted, and the reason is the shape of the payload. A pack is a single small JSON document, tens to hundreds of kilobytes, that changes a handful of times a year. Chunking exists to dedup megabytes of CAD geometry shared between assemblies and to let many holders serve pieces of one large object; a taxonomy has neither problem. Adopting it would buy nothing measurable and cost a manifest/chunk store, a DAG walker with cycle detection, an availability model with four states, and a pinning UI — machinery whose failure modes a user of an accounting app would have to learn. A pack's content address already exists in a simpler form: the version's bytes are write-once and the signature covers them exactly, so `<id>-<version>` names bytes as durably here as a hash would.

**If packs ever grow the properties that motivate DMTAP-PUB** — large binary payloads, or publishers who need someone else to host their bytes — the seam is the place to add it: a DMTAP transport is a `BlobStore` like any other, and nothing above it changes.

## Seed packs

Three starter packs ship **compiled into the binary** as fixtures in `crates/slipscan-packs` (marked builtin provenance, signed with a deliberately-public development key — the module docs state the trust model plainly):

| Pack | Region | Contents |
|---|---|---|
| `za-personal` | `ZA` | Personal-finance taxonomy + rules for major South African merchants |
| `za-business-vat` | `ZA` | Small-business taxonomy with advisory VAT hints |
| `intl-starter` | *(none — global)* | Region-agnostic taxonomy + rules for worldwide merchants (Amazon, Tesco, Carrefour, Aldi, IKEA, Uber, Netflix, …) |

**Seeds are opt-in — no book installs them automatically**, and that is a decision rather than an omission. Which taxonomy a book should start from is the user's (or their region profile's) call: installing all three into every new book would pre-empt that choice and put a South African chart in front of someone in Portugal. It is also not something core *can* do on its own — slipscan-packs depends on core, never the reverse, so seeding is a surface's call. Ask for it explicitly with `slipscan pack seed`, or `POST /api/v1/pack_install_seeds` with `{"book_id": …}`; the desktop offers it on the Packs screen as an explicit action, over the same `pack_install_seeds` IPC command. It is idempotent, and it adopts categories you already have by (parent, name) instead of duplicating them, so calling it on an existing book clobbers nothing.

`intl-starter` is part of the [generic region profile](ARCHITECTURE.md#global-by-default--regions-are-data-not-code) story: usable in any country on day one, alongside any regional pack — its category names deliberately match `za-personal` where concepts coincide, so installing both composes onto one tree instead of duplicating it. Regional packs like the ZA pair are what a country's dedicated profile adds on top.

## Writing a regional pack

The most useful packs are regional: the merchants of one country, named the way they actually appear on statements.

1. Start from your own corrected data. (A helper that exports your local merchant→category mappings *as rules* — patterns and category keys only, no transactions — is planned but does not exist yet; today you write the manifest by hand.)
2. Generalise the patterns. `PNP FAM KENILWORTH` should become a `merchant_contains` on `pnp` / `pick n pay`, not an exact match on one branch.
3. Prune anything identifying. No merchant that only you visit, no pattern containing an account or reference number. A pack should read like a phone book, not a diary.
4. Keep taxonomy shallow (two levels is plenty) and reuse common top-level keys (`groceries`, `transport`, `eating-out` — the `intl-starter` taxonomy is the reference vocabulary) so packs from different authors compose.
5. Declare the `region` (ISO 3166-1 alpha-2). Omit it only if the pack is genuinely global — a region-less pack applies everywhere.
6. Sign it. There is no `slipscan pack sign` CLI yet — sign the exact payload bytes with an ed25519 key (the `slipscan_packs::sign_pack` library function, or any ed25519 tool producing a detached 64-byte signature over the file's bytes).

7. Publish the files anywhere, with your public key alongside — or `slipscan pack publish <source> <pack.json> --signature --public-key` into a `folder:` source and let a synced folder, a USB stick or a git repo carry it (["Getting a pack"](#getting-a-pack)).

## Corrections stay local

When you re-categorise a transaction, SlipScan records a local correction. Corrections:

- **Win over pack rules.** Your judgement beats the community's, always, silently. This is the actual order categorisation runs in: a stored merchant mapping — your correction, something learned from one, an LLM verdict you accepted, or a pack's own exact rule — is applied first, and pack rules are only consulted for a merchant your book has no opinion about. When a pack rule does decide one, its verdict is recorded as a `pack`-sourced mapping, so the answer is the same on every surface and disappears again when you uninstall the pack; correcting it overwrites that row as yours.
- **Feed the local learning loop.** Similar future transactions follow your correction — this part works today.
- **Never leave your machine.** There is no automatic "improve the pack for everyone" upload. Contributing back means writing a pack by hand today — you see every rule in the file before you share it.

**Which ingestion paths this reaches.** All of them. A slip's extracted merchant, a manually entered transaction, and bank/CSV statement imports — whose lines carry a narrative and no merchant field, so the key is derived from the description ([BANK-ADAPTERS.md](BANK-ADAPTERS.md#imported-lines-are-categorised)). That derivation is conservative on purpose and **declines** on lines that name no merchant (`MONTHLY ACCOUNT FEE`, `ATM CASH WITHDRAWAL`, a bare reference number): those import uncategorised rather than under a guessed key that would become a durable mapping the moment you corrected the row. Statement lines already stored keep whatever category they have — nothing is re-derived or rewritten behind you on upgrade.

Uninstall (remove a pack's rules and its `pack`-sourced mappings, keep in-use categories as local so history never breaks, keep the signer pin) is reachable from all three surfaces: `slipscan pack uninstall <pack-id>`, the desktop Packs screen, and `POST /api/v1/pack_uninstall`.

## Benchmark packs

The same signed-pack mechanism also carries **aggregate statistics** for anonymous peer comparison — a different payload with a much stricter privacy story. Install one like any other pack, then compare a month with `slipscan pack benchmark --period YYYY-MM` (or `POST /api/v1/pack_benchmark`). Reading is entirely local and transmits nothing; *contributing* to a benchmark pack is not implemented at all.

## Mailrules packs

The third pack kind carries **bank-alert email formats**: how to recognise "your card was used for R 184.50 at PNP KENILWORTH" and pull an amount, a date, a merchant and a direction out of it. See [EMAIL.md](EMAIL.md#bank-alert-emails--transactions) for what happens to the result.

This is a pack kind for the same reason regional taxonomies are: alert formats differ per bank *and* per country — currency position, decimal comma vs point, day-first vs month-first dates, month names in the local language. Hardcoding them would put jurisdiction literals in the product. **SlipScan ships no `mailrules` pack and no bank patterns**; the format is data, published by whoever maintains a bank's rules.

A mailrules pack carries **only** mail rules — no categories, no merchant rules, no VAT hints (validation enforces this, as it does for benchmark packs). Install a taxonomy pack alongside; transactions a mail rule produces go through the ordinary categorisation cascade.

```jsonc
{
  "meta": { "id": "example-bank-alerts", "name": "Example Bank alerts", "version": "1.0.0" },
  "mailrules": {
    "rules": [
      {
        "id": "card-purchase",                        // stable, appears in decline reports
        "from_patterns": ["alerts.example-bank.test"], // address or domain (subdomains match)
        "subject_patterns": ["(?i)card purchase"],     // optional gates; ALL must match
        "amount": {
          "part": "body",                              // "subject" | "body" | "any"
          "pattern": "(?i)purchase of ZAR ([\\d., ]+) at",
          "group": 1,                                  // 1-based; group 0 is refused
          "style": "point"                             // "point" | "comma" | "auto"
        },
        "currency": { "kind": "fixed", "code": "ZAR" },
        "date": { "kind": "received" },                // or "extract", see below
        "merchant": { "part": "body", "pattern": "(?i) at (.+?) on your card", "group": 1 },
        "direction": { "kind": "fixed", "direction": "debit" },
        "reference": { "part": "body", "pattern": "Ref: (\\S+)", "group": 1, "unique": false },
        "account_hint": { "part": "body", "pattern": "card ending (\\d{4})", "group": 1 },
        "max_date_drift_days": 30
      }
    ]
  }
}
```

Patterns are regexes over plain text (a `text/plain` part when the sender ships one, otherwise the HTML body with tags stripped and entities decoded). Use inline flags — `(?i)` for case-insensitive, `(?s)` to let `.` cross newlines.

**The format is shaped to make declining easy and guessing hard.** Every choice below exists because a wrongly-parsed transaction is worse than an unparsed one:

- **Explicit capture groups.** Nothing is inferred from position, and group 0 (the whole match) is refused — naming the group is what stops a rule from quietly capturing the surrounding sentence.
- **Declared decimal style.** `1.234` is a different amount in different countries. `point` and `comma` are strict: if the text's decimal separator is not the declared one, the rule declines rather than mis-scaling money by 100. `auto` keeps the shared statement-import heuristic.
- **Named date groups.** `"date": { "kind": "extract", "part": "body", "pattern": "(?P<d>\\d{2})/(?P<m>\\d{2})/(?P<y>\\d{4})" }` — `y`, `m` and `d` are mandatory names, so `03/04` can never be read as April 3rd by a rule that meant March 4th. Add `"months": ["janvier", …]` (exactly twelve, January first, any language) when the month is a name rather than digits; there is no built-in month vocabulary, because month names are data too. `{ "kind": "received" }` — the default — uses the message's own `Date` header and cannot be misread.
- **`max_date_drift_days`.** An alert is sent when the card is used, so an extracted date far from the message's own date means the pattern found something else (a card expiry, a statement period). Default 30; `0` disables the check.
- **Direction is the rule's, never the text's.** Either `{ "kind": "fixed", "direction": "debit" | "credit" }`, or `{ "kind": "match", "debit_pattern": …, "credit_pattern": … }` where matching both — or neither — declines. Amounts parse as positive magnitudes; the direction sets the sign.
- **`reference.unique` defaults to false.** Set it only when the reference identifies one transaction *at the bank*; then it becomes the transaction's `provider_txn_id` and dedupe is exact. Left false, the reference is reported but never used as a dedupe key, because a merchant-side reference that repeats would silently swallow real transactions.
- **`currency`** is either `{ "kind": "fixed", "code": "ZAR" }` or `{ "kind": "extract", … , "map": { "R": "ZAR" } }`. A symbol the pack does not map is a decline — `$` is not one currency.
- **`account_hint`** is checked against the target account's masked number and compared on trailing digits only. It can only ever *reject a contradiction*: unknown on either side is never a mismatch.

Write a mailrules pack the way you write any pack — hand-authored JSON, signed over the exact bytes, installed with `slipscan pack install`. Test it against real mail from your own bank before publishing, and include the noisy cases: bank alerts are full of other numbers (balances, phone numbers, card expiries, reference codes) that a loose pattern will happily mistake for the amount.

---

**Next:** [BENCHMARKS.md](BENCHMARKS.md) — nudges and anonymous peer comparison, with the privacy model spelled out.
