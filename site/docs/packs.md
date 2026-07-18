# Classification Packs

Good transaction categorisation needs knowledge: that `PNP FAM KENILWORTH` is Pick n Pay and Pick n Pay is groceries — or that `TESCO STORES 2041` is groceries and `7-ELEVEN` is a convenience store. Cloud products learn this from everyone's data on their servers. SlipScan ships that knowledge as **packs** — signed, versioned files containing taxonomies and rules, **never data**.

This is [mantra #5](ARCHITECTURE.md#non-negotiables-the-mantra): community sharing moves rules, never data. Packs are also how SlipScan stays [global by default](ARCHITECTURE.md#global-by-default--regions-are-data-not-code): a country's merchant knowledge is region-profile *data* carried by packs, never code — a pack declares its region (or none, making it global), and packs for any country plug into the same machinery.

> **Status.** Signature verification and installation (categories + stored rules) work today via `slipscan pack install` and the server's `pack_install`. However, **installed pack rules are not yet consulted during categorisation** — the classification engine that matches pack rules against transactions exists in `crates/slipscan-packs` but is not wired into the import pipeline, so today only your local corrections and merchant mappings drive auto-categorisation. Desktop install UI, a `pack sign` CLI helper, mapping export, per-publisher trust pinning, and uninstall are also not wired yet; each is called out below.

## What's in a pack

A pack is a JSON manifest plus a detached ed25519 signature (implemented in `crates/slipscan-packs`):

```jsonc
{
  "id": "za-groceries",            // stable pack id
  "name": "South African groceries",
  "version": "1.2.0",              // semver
  "region": "ZA",                  // ISO 3166-1 alpha-2; omit for a global pack
  "description": "Common SA grocery merchants",
  "author": "community",
  "created_at": "2026-07-01T00:00:00Z",
  "categories": [
    { "key": "groceries",       "name": "Groceries", "kind": "expense" },
    { "key": "groceries.dairy", "name": "Dairy", "parent_key": "groceries", "kind": "expense" }
  ],
  "rules": [
    { "match_type": "merchant_contains", "pattern": "pick n pay",
      "category_key": "groceries", "confidence": 0.95 }
  ]
}
```

- **Categories** form a hierarchy via `parent_key`; `key` is a stable slug that installation maps onto your local category ids, so packs compose without id collisions.
- **Rules** match merchants (`merchant_exact`, `merchant_contains`, `merchant_regex`) and suggest a category key with a confidence.
- **`region`** is an optional ISO 3166-1 alpha-2 code declaring which country's merchants the pack targets; a pack with no region is **global** and applies anywhere. The region is recorded per install (existing installs are migrated: the original ZA seed payloads always declared `"ZA"`, so old databases come out labeled correctly).
- That's the complete vocabulary. There is nowhere in the format to put a transaction, an amount, or a person.

## Signing

Every pack is signed: an ed25519 signature over the exact manifest bytes, verified on install (`verify_pack` in `slipscan-packs`). Unsigned or tampered packs are rejected — not warned about, rejected.

Trust is per-publisher and there is no central authority deciding who may publish. The designed flow — add a publisher's public key once (trust-on-first-use with a fingerprint you check out-of-band, like an SSH host key) and have their packs verify against it automatically — is implemented in the `slipscan-packs` trust store but **not yet wired to any surface**: today `slipscan pack install`/`pack verify` require you to pass the publisher's `--public-key` on every call, which is the same trust decision made explicitly each time.

## Installing a pack

Distribution is deliberately boring: packs are files. Fetch them from a git repo, a URL, a friend — no central registry to go down or be captured.

- CLI: `slipscan pack install <manifest.json> --signature <hex|@file> --public-key <hex|@file>` — verification failure rejects the pack before anything is applied. `slipscan pack verify` checks a pack without installing; `slipscan pack list` shows what's installed.
- Server: the `pack_install` operation ([API.md](API.md)) with the same three inputs.
- Installation is per-book. Re-installing the same pack id is idempotent for categories; your data is untouched.
- Desktop install UI is not built yet — the Settings → Packs section lists installed packs only.

## Seed packs

Three starter packs ship **compiled into the binary** as fixtures in `crates/slipscan-packs` (marked builtin provenance, signed with a deliberately-public development key — the module docs state the trust model plainly):

| Pack | Region | Contents |
|---|---|---|
| `za-personal` | `ZA` | Personal-finance taxonomy + rules for major South African merchants |
| `za-business-vat` | `ZA` | Small-business taxonomy with advisory VAT hints |
| `intl-starter` | *(none — global)* | Region-agnostic taxonomy + rules for worldwide merchants (Amazon, Tesco, Carrefour, Aldi, IKEA, Uber, Netflix, …) |

`intl-starter` is part of the [generic region profile](ARCHITECTURE.md#global-by-default--regions-are-data-not-code) story: usable in any country on day one, alongside any regional pack — its category names deliberately match `za-personal` where concepts coincide, so installing both composes onto one tree instead of duplicating it. Regional packs like the ZA pair are what a country's dedicated profile adds on top.

## Writing a regional pack

The most useful packs are regional: the merchants of one country, named the way they actually appear on statements.

1. Start from your own corrected data. (A helper that exports your local merchant→category mappings *as rules* — patterns and category keys only, no transactions — is planned but does not exist yet; today you write the manifest by hand.)
2. Generalise the patterns. `PNP FAM KENILWORTH` should become a `merchant_contains` on `pnp` / `pick n pay`, not an exact match on one branch.
3. Prune anything identifying. No merchant that only you visit, no pattern containing an account or reference number. A pack should read like a phone book, not a diary.
4. Keep taxonomy shallow (two levels is plenty) and reuse common top-level keys (`groceries`, `transport`, `eating-out` — the `intl-starter` taxonomy is the reference vocabulary) so packs from different authors compose.
5. Declare the `region` (ISO 3166-1 alpha-2). Omit it only if the pack is genuinely global — a region-less pack applies everywhere.
6. Sign it. There is no `slipscan pack sign` CLI yet — sign the exact manifest bytes with an ed25519 key (the `slipscan_packs::sign_pack` library function, or any ed25519 tool producing a detached 64-byte signature over the file's bytes).

7. Publish the files anywhere, with your public key alongside.

## Corrections stay local

When you re-categorise a transaction, SlipScan records a local correction. Corrections:

- **Win over pack rules.** Your judgement beats the community's, always, silently. (Designed precedence — academic until pack rules are wired into categorisation at all; see the status note at the top.)
- **Feed the local learning loop.** Similar future transactions follow your correction — this part works today.
- **Never leave your machine.** There is no automatic "improve the pack for everyone" upload. Contributing back means writing a pack by hand today — you see every rule in the file before you share it.

Uninstall semantics (remove a pack's rules, keep in-use categories as local so history never breaks) are implemented in the packs crate's installer but not yet exposed by any CLI/desktop/server command.

## Benchmark packs

The same signed-pack mechanism also carries **aggregate statistics** for anonymous peer comparison — a different payload with a much stricter privacy story.

---

**Next:** [BENCHMARKS.md](BENCHMARKS.md) — nudges and anonymous peer comparison, with the privacy model spelled out.
