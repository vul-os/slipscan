# Classification Packs

Good transaction categorisation needs knowledge: that `PNP FAM KENILWORTH` is Pick n Pay and Pick n Pay is groceries — or that `TESCO STORES 2041` is groceries and `7-ELEVEN` is a convenience store. Cloud products learn this from everyone's data on their servers. SlipScan ships that knowledge as **packs** — signed, versioned files containing taxonomies and rules, **never data**.

This is [mantra #5](ARCHITECTURE.md#non-negotiables-the-mantra): community sharing moves rules, never data. Packs are also how SlipScan stays [global by default](ARCHITECTURE.md#global-by-default--regions-are-data-not-code): a country's merchant knowledge is region-profile *data* carried by packs, never code — a pack declares its region (or none, making it global), and packs for any country plug into the same machinery.

> **Status.** Installing a pack — `slipscan pack install`, the server's `pack_install` — now runs the real installer: signature checked, signer trusted on first use and **pinned** to the pack id, versions only moving forward, taxonomy mapped onto your categories, rules written to the `pack_rules` tables the classifier reads, the whole thing audited.
>
> **Installed pack rules are consulted during categorisation, on every surface.** Core owns no classification knowledge (slipscan-packs depends on core, never the reverse), so a binary registers the pack classifier once at startup — one line, `slipscan_packs::register_classifier()`. SlipScan ships two binaries and both call it before doing anything else: the CLI's `main()` and the desktop app's `run()`. The self-host server is not a third — `slipscan serve` *is* the CLI binary, so it is registered before it binds a socket. The install ops (`pack_install`, `pack_install_seeds`) register too, which is what covers a third-party process embedding `slipscan-server` as a library; it was never the server that needed the extra help. Before startup registration existed, a process that had not installed a pack *that run* silently skipped every `contains`, `regex` and `keyword` rule already in the database — only `merchant_exact` rules kept working, because installs seed those into core's own merchant mappings.
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

## Signing and trust

Every pack is signed: an ed25519 signature over the exact document bytes, verified on install (`verify_detached` in `slipscan-packs`). Unsigned or tampered packs are rejected — not warned about, rejected.

Trust is per-publisher and there is no central authority deciding who may publish. You still pass the publisher's `--public-key` on every install, and that act *is* the trust decision — so the first time a key is used it is **recorded in the trust store** (trust-on-first-use, with a fingerprint you can check out-of-band like an SSH host key), and the pack id is **pinned** to it. From then on:

- a later version of that pack signed by a **different** key is rejected outright, even if that other key is itself trusted — the pin is what a bare `--public-key` argument could never give you;
- the well-known key the builtin seed packs are signed with can never be trusted for external packs, so nothing outside the binary can dress itself up as builtin.

The fingerprint is put in front of you where the decision is made: the desktop's verify step shows it, and says whether that key is already trusted, before the install button does anything; every installed pack lists its signer fingerprint afterwards. What no surface exposes is the store itself — there is no screen or command that lists trusted signers or revokes one, though `slipscan_packs::TrustStore` implements both.

## Installing a pack

Distribution is deliberately boring: packs are files. Fetch them from a git repo, a URL, a friend — no central registry to go down or be captured.

- CLI: `slipscan pack install <pack.json> --signature <hex|@file> --public-key <hex|@file>` — verification failure rejects the pack before anything is applied. `slipscan pack verify` checks a pack without installing; `slipscan pack list` shows what's installed.
- Server: the `pack_install` operation ([API.md](API.md)) with the same three inputs.
- Desktop: a top-level **Packs** screen (it moved out of Settings). Pick the pack file, paste or pick its signature and public key, and it verifies first: you see the signer's fingerprint, whether that key is already trusted, and what the install would do (new install, or an upgrade from which version), and only then commit. The same screen upgrades and uninstalls. It never fetches anything — the files are ones you already hold.
- Installation is per-book, and **versions only move forward**: re-installing the version you already have is refused (`already installed`) and downgrades are rejected. Installing a *higher* version upgrades in place — categories keep their ids, your renames survive, and rules are replaced wholesale.
- Your data is untouched either way, and rules are never applied retroactively: a pack classifies what you import from then on, not what is already in the book.

**Upgrading from a pre-installer database.** Packs installed by the old path lived in one `packs.installed` settings blob and were never consulted by anything. They are adopted into the pack tables the first time you install or list packs: the categories that install created are matched by name and parent (never duplicated), and its rules become live rules. Nothing is fabricated on the way in — that blob stored no signature and no public key, so the adopted row records no signer and pins nothing, which leaves a properly signed release of the same pack free to take it over later. The settings key itself is kept verbatim, and an entry that cannot be adopted is still listed, so an install that happened never disappears from the record.

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

7. Publish the files anywhere, with your public key alongside.

## Corrections stay local

When you re-categorise a transaction, SlipScan records a local correction. Corrections:

- **Win over pack rules.** Your judgement beats the community's, always, silently. This is the actual order categorisation runs in: a stored merchant mapping — your correction, something learned from one, an LLM verdict you accepted, or a pack's own exact rule — is applied first, and pack rules are only consulted for a merchant your book has no opinion about. When a pack rule does decide one, its verdict is recorded as a `pack`-sourced mapping, so the answer is the same on every surface and disappears again when you uninstall the pack; correcting it overwrites that row as yours.
- **Feed the local learning loop.** Similar future transactions follow your correction — this part works today.
- **Never leave your machine.** There is no automatic "improve the pack for everyone" upload. Contributing back means writing a pack by hand today — you see every rule in the file before you share it.

**Which ingestion paths this reaches.** All of them. A slip's extracted merchant, a manually entered transaction, and bank/CSV statement imports — whose lines carry a narrative and no merchant field, so the key is derived from the description ([BANK-ADAPTERS.md](BANK-ADAPTERS.md#imported-lines-are-categorised)). That derivation is conservative on purpose and **declines** on lines that name no merchant (`MONTHLY ACCOUNT FEE`, `ATM CASH WITHDRAWAL`, a bare reference number): those import uncategorised rather than under a guessed key that would become a durable mapping the moment you corrected the row. Statement lines already stored keep whatever category they have — nothing is re-derived or rewritten behind you on upgrade.

Uninstall (remove a pack's rules and its `pack`-sourced mappings, keep in-use categories as local so history never breaks, keep the signer pin) is reachable from all three surfaces: `slipscan pack uninstall <pack-id>`, the desktop Packs screen, and `POST /api/v1/pack_uninstall`.

## Benchmark packs

The same signed-pack mechanism also carries **aggregate statistics** for anonymous peer comparison — a different payload with a much stricter privacy story. Install one like any other pack, then compare a month with `slipscan pack benchmark --period YYYY-MM` (or `POST /api/v1/pack_benchmark`). Reading is entirely local and transmits nothing; *contributing* to a benchmark pack is not implemented at all.

---

**Next:** [BENCHMARKS.md](BENCHMARKS.md) — nudges and anonymous peer comparison, with the privacy model spelled out.
