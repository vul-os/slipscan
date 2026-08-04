# Roles, people, and encryption at rest

> **Most of this chapter is still a design, not a build.** It was written
> down before any code, because the decisions it records are the kind that
> are expensive to reverse once devices hold keys and books hold rows. Every
> "is" below should be read as "will be" — **except** the data model and
> lifecycle described in [What is built now](#what-is-built-now), which
> landed first because everything else here is cheaper to get right once it
> exists and expensive to retrofit once staff rows are live. That section is
> the one part of this chapter that is a factual claim about today's tree
> rather than a plan. Nothing past it is built: no enforcement, no
> encryption at rest, no thin mobile client.

## What exists today

Authority in SlipScan is binary and global. There is no concept anywhere in
the tree of a person who may do *some* things:

- **`set_read_only`** flips SQLite's `query_only` pragma on the whole
  connection. It is per-process, not per-person, and any code path can turn it
  back off.
- **The HTTP server has one bearer token** (`server.auth_token_sha256`),
  generated on first run. One token, all 188 routes. There is no second token
  and no notion of a token that can do less.
- **`members`** now carries `status`/`revoked_at`/`attributable`/`principal`
  and a capability set (see [What is built now](#what-is-built-now)) — but
  nothing anywhere reads any of it to allow or refuse an operation. It still
  answers *whose spend is this* exactly as before, and now also records *who
  may act*, without yet being consulted for it.
- **`device_peers`** pins peer devices trust-on-first-use, with `revoked_at`
  as a tombstone so a revoked key cannot silently re-pair. It was built for
  *your own devices* — a laptop and a phone belonging to one person —  and
  now carries a nullable `member_id` for the staff case, though nothing pairs
  a device to a named principal yet.

The gap this chapter exists to close is enforcement, not data: a household
has members; a branch has staff, and staff leave; revocation cannot stay
"delete the peer row" once the peer is a person who was paid to be there —
and now the schema can say who a principal is and what they were granted, but
no code path anywhere checks it before letting an operation through.

## What is built now

`crates/slipscan-core` and `crates/slipscan-cli` — the data model and
lifecycle only, none of the enforcement:

- **Schema** (migration `0006_members`): `members.status` (`'active'` /
  `'revoked'`, tombstoned via `revoked_at`, never un-revoked),
  `members.attributable` and `members.principal` (see the flag table
  below — `principal` is monotonic, set once and never cleared), the
  `members_active_label_idx` partial unique index replacing
  `UNIQUE (book_id, label)`, and a new `member_capabilities` table (one row
  per granted named operation, `UNIQUE (member_id, operation)`). Migration
  `0007_devices` adds a nullable `device_peers.member_id`, never replicated
  (a device pairing is still local-only, same as every other row in that
  table).
- **Service layer** (`crates/slipscan-core/src/service.rs`):
  `member_revoke` (tombstones the member and cascades to revoke every
  device peer still linked to them, atomically), `member_capability_grant` /
  `member_capability_revoke` / `member_capabilities_list`, and
  `member_is_permitted` — a **read-only query** ("is this member currently
  active, a principal, and holding this operation"), consulted by nothing.
  `member_remove` now additionally refuses any member that is or ever was a
  `principal`, unconditionally — no reassignment target lifts it; revocation
  is the only exit, exactly as the section below describes.
- **CLI**: `member revoke`, `member capability-grant`,
  `member capability-revoke`, `member capabilities`, `member is-permitted`.
- **Sync**: `member_capabilities` replicates LWW, on the same list `members`
  is already on (`slipscan-sync`'s `LWW_TABLES`) — grants/revokes made from
  one of an owner's own devices need to reach their other devices, the same
  as a label edit does. `device_peers` stays off both sync lists entirely,
  unchanged: a device pin, and now a device-to-member link, is exactly the
  kind of local opinion migration `0008`'s header says must not replicate.

**What this is not.** No capability check gates anything in `CoreService`,
the CLI, the HTTP server, or the desktop app — every operation still runs
for anyone who can reach it, exactly as before this landed. There is no
pairing flow that sets `device_peers.member_id`; the column exists so
`member_revoke` has somewhere to look, and the tests that exercise the
cascade seed it directly. HTTP/IPC enforcement, encryption at rest, and the
thin mobile client below are all still design, not code.

## The decisions

### People are members, not a parallel table

`members` gains `status` and a capability set, and `device_peers` gains a
`member_id`. There is one table of humans, not two.

The strongest argument for this is a property `members` already has and
`device_peers` does not. `member_remove` refuses to remove a member with
attributed transactions or splits unless the caller names an explicit
reassignment target, and `transaction_splits.member_id` is
`ON DELETE RESTRICT` for the same reason. A member is already a durable
entity with history that cannot be quietly dropped — which is exactly the
property this phase exists to give a principal. A fresh `people` table would
have started with none of it and had to re-earn it.

The cost is real and worth stating: attribution and authority can now never
diverge. A till operator appears in the same table as the household member
whose groceries are being categorised. Two flags keep that from becoming a
mess in the interface:

| flag | meaning |
| --- | --- |
| `attributable` | appears in "whose spend is this" |
| `principal` | may act — holds capabilities and devices |

A household member is attributable and not a principal. A till operator is a
principal and not attributable. An owner is both. Neither list has to show the
other's rows.

### Authority is a set of operations, not table permissions

The unit is the named operation, because this codebase already has a registry
of them — 177 IPC commands and 188 HTTP routes, with `npm run parity:check`
already proving the two agree. A capability set over operation names is
enforceable in one place and can be gated in CI the same way everything else
here is.

Per-table CRUD permissions were rejected: they describe storage rather than
intent, and "may issue an invoice" is not expressible as write access to
`invoices` — issuing one posts to `journals`, allocates a number, and touches
stock.

### The book is encrypted at rest, with the key wrapped per person

This is the decision that makes the other two work, and it needs its
limitation stated before its benefit.

**Encryption at rest does not, by itself, enforce anything.** If a person
holds a key that decrypts the book, they can open the file with any SQLite
tool and write whatever they like, and no capability check in the service
layer will see it. Encryption stops people *without* a key.

That is precisely the lever. One book key, wrapped per person in the existing
vault — and low-privilege people are never given a wrapped copy:

```
owner          has a wrapped book key  →  local book, full access
                                          (bypassing capability checks is
                                           meaningless; they hold everything
                                           already)

till operator  has no key              →  cannot open the file at all
                                       →  only path in is HTTP or IPC
                                       →  capabilities enforced at that
                                          boundary, with no way around it
```

The bypass only ever mattered for the untrusted principal, and the untrusted
principal is exactly the one with no key. **The key is the boundary.**

This is why the mobile client is a thin client (see below) rather than an
offline one: holding a local book requires holding a key, and holding a key
means holding everything.

## Mobile follows from this

The first mobile release is a **thin client** — every operation over HTTP
against your own box, no book on the device.

That is not primarily a mobile decision. It is what falls out of the model
above: a phone belonging to a staff member must not hold a key, so it must
not hold a book, so it must reach the server for everything. The phone is the
canonical low-privilege surface, and the same enforcement that protects it
protects every other keyless client.

It also sidesteps a problem that has no answer yet. Multi-device invoice
numbering is unsolved, and gapless numbering is a statutory requirement, not a
preference. A thin client never allocates a number offline, so the question
stays deferred rather than answered wrongly.

What it costs: every screen has to be rebuilt for touch, and roles must land
first, because today the only credential is a token that can do everything.

### Two things `members` got wrong for staff, and changed first

Both landed in migration `0006_members`/`service.rs` (see
[What is built now](#what-is-built-now)) precisely because they were cheap
before anything else in this chapter and would only get more expensive the
longer real member rows existed.

**`UNIQUE (book_id, label)` could not survive turnover.** Revocation retains
the row, because audit history points at it. So a departed *Sam Patel* would
occupy the label *Sam Patel* permanently, and the next Sam Patel could not be
added at all. A household never meets this — nobody cycles through household
members. A branch meets it the first time someone is replaced, which is the
case this phase exists for. The constraint is now a partial unique index over
active rows only, so a revoked person keeps their name in the history and
releases it for the living:

```sql
CREATE UNIQUE INDEX members_active_label_idx
    ON members (book_id, label) WHERE status = 'active';
```

**`member_remove` guarded the wrong axis for a principal.** It refused to
remove a member with attributed transactions or splits — money history. It
knew nothing about authority history. A till operator plausibly has *zero*
attributed transactions, because they operate the till rather than incurring
household spend, so they would pass the check and be deleted outright,
orphaning whatever the oplog signed under their id. `member_remove` now also
refuses, unconditionally, any member that is or ever was a `principal` — no
`reassign_to` lifts it, because there is nothing to reassign an *identity*
onto. For those, revocation (`member_revoke`) is the only exit, exactly as it
already is for a peer key.

## Open questions

These are genuinely undecided. They are listed rather than guessed.

**`members` is per-book.** The table has `book_id NOT NULL` and a unique
label per book (now `members_active_label_idx`, scoped to active rows — see
[What is built now](#what-is-built-now)), so one human working across two
books is two rows — and now that `device_peers.member_id` exists, a device
is bound to one book's member. For a household that is irrelevant. For a
business running separate books it means pairing a device per book. Deciding
this now that devices reference `member_id` is a migration with live keys in
it, so it should be decided first.

**Recovery.** Encrypt the book and a lost key means the book is gone — not
degraded, gone. The groundwork exists (the vault, the key-name words, the
rotation chain), but "I reinstalled and lost my books" becomes an
unrecoverable support case unless recovery is designed before encryption
ships. It cannot be added afterwards to books already encrypted without one.

**SQLCipher or application-level encryption.** `rusqlite` is on bundled
SQLite 3.46. Page-level encryption means either SQLCipher — a different build
with licensing consequences — or encrypting values above the storage layer,
which gives up transparent querying and every index that depends on it. This
choice constrains everything downstream and belongs at the start.

**Revocation needs the transport.** A revoked device only learns it was
revoked by talking to something. With [no sync transport](NODES.md) built,
revocation is effective where the server is reachable and nowhere else. A
keyless thin client fails closed, which is the right default — it simply
stops working — but a device that once held a key does not.

## What this does not claim

- **It does not enforce anything yet.** `member_capabilities` and
  `member_is_permitted` exist; nothing in `CoreService`, the CLI, the HTTP
  server, or the desktop app consults them before letting an operation
  through. The enforcement boundary is HTTP/IPC, and that layer is not
  built — see [What is built now](#what-is-built-now).
- It does not make a SlipScan book safe from someone who holds an owner's
  key. Nothing here attempts that.
- It does not survive a compromised host. A key in use is a key in memory.
- It does not add accounts, a login server, or any identity SlipScan resolves
  on your behalf. People are rows in your book; capabilities will be
  enforced by your box, once that boundary exists.
