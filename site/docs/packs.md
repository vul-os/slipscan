# Classification Packs

Good transaction categorisation needs knowledge: that `PNP FAM KENILWORTH` is Pick n Pay and Pick n Pay is groceries. Cloud products learn this from everyone's data on their servers. SlipScan ships that knowledge as **packs** — signed, versioned files containing taxonomies and rules, **never data**. Installing a pack teaches your instance; your transactions teach only your instance.

This is [mantra #5](ARCHITECTURE.md#non-negotiables-the-mantra): community sharing moves rules, never data.

## What's in a pack

A pack is a JSON manifest plus a detached ed25519 signature (implemented in `crates/slipscan-packs`):

```jsonc
{
  "id": "za-groceries",            // stable pack id
  "name": "South African groceries",
  "version": "1.2.0",              // semver
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
- That's the complete vocabulary. There is nowhere in the format to put a transaction, an amount, or a person.

## Signing

Every pack is signed: an ed25519 signature over the exact manifest bytes, verified on install (`verify_pack` in `slipscan-packs`). Unsigned or tampered packs are rejected — not warned about, rejected.

Trust is per-publisher: you add a publisher's public key once (from their repo, their site, wherever you choose to trust), and their packs verify against it. There is no central authority deciding who may publish. A key fingerprint is shown on first trust — check it out-of-band like you would an SSH host key.

## Installing a pack

Distribution is deliberately boring: packs are files. Fetch them from a git repo, a URL, a friend — no central registry to go down or be captured.

- Desktop: **Settings → Packs → Install**, pick the `.json` + `.sig` (or a `.slippack` bundle of both).
- The app shows the manifest — publisher, version, category count, rule count — before anything is applied.
- Installation is per-book. Upgrading to a newer version of the same pack id re-maps cleanly; your data is untouched.
- API/CLI surface: the `pack_install` operation ([API.md](API.md)).

## Writing a regional pack

The most useful packs are regional: the merchants of one country, named the way they actually appear on statements.

1. Start from your own corrected data — SlipScan can export your local merchant→category mappings *as rules* (patterns and category keys only, no transactions) as a pack draft.
2. Generalise the patterns. `PNP FAM KENILWORTH` should become a `merchant_contains` on `pnp` / `pick n pay`, not an exact match on one branch.
3. Prune anything identifying. No merchant that only you visit, no pattern containing an account or reference number. A pack should read like a phone book, not a diary.
4. Keep taxonomy shallow (two levels is plenty) and reuse common top-level keys (`groceries`, `transport`, `eating-out`) so packs from different authors compose.
5. Sign it:

```sh
slipscan pack sign --key ~/.slipscan/pack-signing.key za-groceries.json
# → za-groceries.json + za-groceries.sig
```

6. Publish the files anywhere, with your public key alongside.

## Corrections stay local

When you re-categorise a transaction, SlipScan records a local correction. Corrections:

- **Win over pack rules.** Your judgement beats the community's, always, silently.
- **Feed the local learning loop.** Similar future transactions follow your correction.
- **Never leave your machine.** There is no automatic "improve the pack for everyone" upload. Contributing back is the deliberate, exported-draft flow above — you see every rule in the file before you share it.

Uninstalling a pack removes its rules; categories in use are kept (now local) so your history never breaks.

## Benchmark packs

The same signed-pack mechanism also carries **aggregate statistics** for anonymous peer comparison — a different payload with a much stricter privacy story.

---

**Next:** [BENCHMARKS.md](BENCHMARKS.md) — nudges and anonymous peer comparison, with the privacy model spelled out.
