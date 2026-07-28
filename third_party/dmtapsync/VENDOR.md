# Vendored: `dmtapsync` — the DMTAP Sync engine, Go binding

This directory is a **byte-for-byte copy** of the Go binding to the shared DMTAP Sync engine
(`substrate/SYNC.md` capability ③). It is not FlowStock code and is not edited here.

|                               |                                                                    |
| ----------------------------- | ------------------------------------------------------------------ |
| Upstream                      | `github.com/vul-os/envoir`, path `bindings/go`                     |
| Commit                        | `278007e13b4273bf1a0328083ed0d755ca9ec5b1` (2026-07-20)            |
| Engine artifact               | `dmtap_sync_abi.wasm`, 426,890 bytes                               |
| `sha256(dmtap_sync_abi.wasm)` | `dd7787106934346138b3569522224ddae24034e424d957cbf7726f4903ea6bb7` |
| Licence                       | MIT (`LICENSE`, upstream's root `LICENSE-MIT`)                     |
| Every file's digest           | `SHA256SUMS.txt`, beside this file                                 |

The commit above was previously recorded as `5e07cdb…`, which was wrong: `embed.go` here is the
`278007e` version, and at `5e07cdb` the `.wasm` was not in git at all. Verified by comparing every
vendored file against `git show 278007e:bindings/go/<file>` — all ten match.

## What it costs to carry

Building with `-tags dmtap` grows the shipped binary by **2.6 MiB**: on linux/amd64, built as
`.github/workflows/release.yml` builds it (`-tags embed_frontend -trimpath -ldflags "-s -w"`),
12,005,560 → 14,766,264 bytes. A plain unstripped `go build` pays 3.57 MiB. Almost all of it is the
wazero compiler, not the 426 KB engine itself: embedding a WebAssembly module means embedding
something that can run one.

That is worth paying when you need **byte-identical merge semantics with a peer running the same
engine**. It is not worth paying when you merely need a CRDT — FlowStock's own is carried,
tested, and the default. See [`docs/SYNC.md`](../../docs/SYNC.md#choosing-an-engine).

## Why vendored rather than a module dependency

The original reason was that **`dmtap_sync_abi.wasm` was gitignored upstream** — build output of
`crates/dmtap-sync-wasm/build-abi.sh`, needing a Rust toolchain and the `wasm32-unknown-unknown`
target — so a proxy-fetched module arrived with the `//go:embed` target missing and did not
compile. **Upstream fixed that** at the pinned commit: the artifact is now checked in and tied to
its source by `wasm_provenance.json` + `provenance_test.go`, and its `embed.go` says adopters no
longer need to vendor.

What is left is narrower, and it is the only thing still holding this directory here:

> **`github.com/vul-os/envoir/bindings/go` is not a published, fetchable module.** There is no
> tagged version to `go get`, so there is nothing for `go.mod` to require. A `replace` pointing at
> a sibling `envoir` checkout would build on a developer laptop and fail everywhere else, which is
> the worst of the available failure modes; vendoring builds everywhere.

### The switch, precisely

When upstream publishes the module, this is the whole change — no code edits:

```sh
# 1. depend on it for real
go get github.com/vul-os/envoir/bindings/go@<tag>

# 2. drop the replace directive from go.mod (the one pointing at ./third_party/dmtapsync)

# 3. delete the vendored copy and its guards
rm -rf third_party/dmtapsync
rm backend/internal/substrate/vendor_drift_test.go

# 4. confirm nothing else moved
go build -tags dmtap ./... && go test -tags dmtap ./backend/...
```

The import path in `backend/internal/substrate/substrate.go` is already
`github.com/vul-os/envoir/bindings/go` — the `replace` is the only thing that redirects it — so the
Go code compiles unchanged either way. Preconditions to check before doing it: the published
module's `dmtap_sync_abi.wasm` must have digest `dd77871069…` (or the FlowStock conformance tests
must be re-run against whatever replaces it), and `go.mod` must still resolve with `CGO_ENABLED=0`,
since the release cross-compiles for four platforms without a C toolchain.

## The drift risk, and what guards it

Upstream's `embed.go` documents that committing this artifact **has already cost a real bug**: a
checked-in module went stale against a fix in `src/abi.rs`, and nothing in git ties a binary blob to
the source that produced it. Vendoring re-accepts that risk, so FlowStock pays for two guards, both
in `backend/internal/substrate/vendor_drift_test.go`:

- **`TestVendoredTreeMatchesManifest`** runs everywhere, including CI, and needs nothing but this
  repo. Every file in `SHA256SUMS.txt` must be present and hash to its recorded digest, and no
  unrecorded file may sit beside them. A missing manifest **fails** rather than skips.
- **`TestVendoredMatchesPinnedUpstream`** compares against `git show <pinned commit>:…` in a sibling
  `envoir` checkout (`FLOWSTOCK_ENVOIR_DIR`, or the conventional `../envoir`). It reads the commit
  out of the table above, so the pin is written down once. It skips only when there is no sibling
  checkout to read — never on a mismatch.

Neither defends against editing a vendored file and the manifest in one commit; that is a
code-review problem. They rule out the silent kind: bytes that stopped being the bytes this repo
says they are, with nobody having decided that.

## Refreshing

```sh
crates/dmtap-sync-wasm/build-abi.sh          # in the envoir checkout, if the Rust moved
cp envoir/bindings/go/{*.go,go.mod,go.sum,dmtap_sync_abi.wasm} \
   flowstock/third_party/dmtapsync/          # excluding _test.go
cp envoir/LICENSE-MIT flowstock/third_party/dmtapsync/LICENSE

cd flowstock/third_party/dmtapsync
shasum -a 256 api.go dmtap_sync_abi.wasm embed.go errors.go go.mod go.sum \
              LICENSE runtime.go signer.go types.go > SHA256SUMS.txt
```

Then update the table above (commit, size, digest) and run
`go test ./backend/internal/substrate/`. Tests are deliberately not vendored: they require the
sibling `dmtap` spec repo for the frozen conformance vectors, and their home is upstream, where a
failure means what it says.
