# Roles, people, and encryption at rest

> **Nothing in this chapter is built.** It is a design, written down before
> any code, because the decisions it records are the kind that are expensive
> to reverse once devices hold keys and books hold rows. Every "is" below
> should be read as "will be". The one factual claim about today's tree is in
> [What exists today](#what-exists-today), and it is that authority does not
> exist.

## What exists today

Authority in SlipScan is binary and global. There is no concept anywhere in
the tree of a person who may do *some* things:

- **`set_read_only`** flips SQLite's `query_only` pragma on the whole
  connection. It is per-process, not per-person, and any code path can turn it
  back off.
- **The HTTP server has one bearer token** (`server.auth_token_sha256`),
  generated on first run. One token, all 188 routes. There is no second token
  and no notion of a token that can do less.
- **`members`** carries `label`, `initial`, `colour` and
  `default_account_id`. It answers *whose spend is this*. It holds no
  credential and confers no authority.
- **`device_peers`** pins peer devices trust-on-first-use, with `revoked_at`
  as a tombstone so a revoked key cannot silently re-pair. It was built for
  *your own devices* — a laptop and a phone belonging to one person.

That last point is the gap. A household has members; a branch has staff, and
staff leave. Revocation cannot stay "delete the peer row" once the peer is a
person who was paid to be there.

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

### Two things `members` gets wrong for staff, and must change first

Both are cheap now and expensive later. Nothing has shipped, so the baseline
schema can still move.

**`UNIQUE (book_id, label)` cannot survive turnover.** Revocation retains the
row, because audit history points at it. So a departed *Sam Patel* occupies
the label *Sam Patel* permanently, and the next Sam Patel cannot be added at
all. A household never meets this — nobody cycles through household members.
A branch meets it the first time someone is replaced, which is the case this
phase exists for. The constraint has to become a partial unique index over
active rows only, so a revoked person keeps their name in the history and
releases it for the living:

```sql
CREATE UNIQUE INDEX members_active_label_idx
    ON members (book_id, label) WHERE status = 'active';
```

**`member_remove` guards the wrong axis for a principal.** It refuses to
remove a member with attributed transactions or splits — money history. It
knows nothing about authority history. A till operator plausibly has *zero*
attributed transactions, because they operate the till rather than incurring
household spend, so they pass the check and can be deleted outright, orphaning
whatever the oplog signed under their id. `member_remove` must also refuse any
member that is or ever was a `principal`. For those, revocation is the only
exit, exactly as it already is for a peer key.

## Open questions

These are genuinely undecided. They are listed rather than guessed.

**`members` is per-book.** The table is `UNIQUE (book_id, label)` with
`book_id NOT NULL`, so one human working across two books is two rows — and
once `device_peers.member_id` exists, a device is bound to one book's member.
For a household that is irrelevant. For a business running separate books it
means pairing a device per book. Deciding this after devices reference
`member_id` is a migration with live keys in it, so it should be decided
first.

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

- It does not make a SlipScan book safe from someone who holds an owner's
  key. Nothing here attempts that.
- It does not survive a compromised host. A key in use is a key in memory.
- It does not add accounts, a login server, or any identity SlipScan resolves
  on your behalf. People are rows in your book; capabilities are enforced by
  your box.
