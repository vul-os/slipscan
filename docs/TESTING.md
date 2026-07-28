# Testing

FlowStock has two test suites. They overlap on purpose: the Go tests prove the
merge rules hold at the store and protocol level, and the browser tests prove
the person standing at the counter actually sees the result.

```bash
npm run test:go     # Go: store invariants, sync protocol, two-node convergence
npm run test:e2e    # Browser: the real binary, driven by Playwright
npm test            # both
```

## Go tests

`go test ./backend/...` — see `backend/internal/store/` (merge and ledger
invariants, HLC ordering, snapshots) and `backend/internal/sync/` (the sync
protocol, signed batches, folder transport, workspace isolation and pairing).
These are fast and need no browser.

The shared DMTAP sync engine is an opt-in build, so its tests only compile under
its own tag:

```bash
go test -tags dmtap ./backend/...   # adds backend/internal/substrate/
```

Two guards in `backend/internal/substrate/vendor_drift_test.go` run in **both**
builds, because they are about the vendored engine's bytes rather than the
engine: `TestVendoredTreeMatchesManifest` checks every file in
`third_party/dmtapsync/` against the digests in its `SHA256SUMS.txt` and fails
if the manifest is missing, and `TestVendoredMatchesPinnedUpstream` compares
against the upstream commit `VENDOR.md` pins when a sibling `envoir` checkout is
present (`FLOWSTOCK_ENVOIR_DIR`).

## Browser tests

`npm run test:e2e` runs Playwright against **the real binary**, not the demo
data. This distinction matters: served from the Vite dev server on port 5173,
the UI swaps in a browser-only demo driver with seeded rows (see
`src/services/api.js`). Served by the Go binary on any other port it uses the
HTTP driver, so every assertion goes through SQLite, the oplog and the sync
mesh.

One-time setup:

```bash
npx playwright install chromium
```

### How a test gets a server

`e2e/helpers/node.js` boots one `flowstock` process per test against a fresh
temp data dir (`FLOWSTOCK_DATA_DIR`) on a free port (`FLOWSTOCK_PORT`), waits
for `/api/bootstrap` to answer, and deletes the data dir afterwards. Nothing is
shared between tests, so they run in parallel and a two-node test is simply two
of them.

`e2e/helpers/fixtures.js` provides the `node` and `app` fixtures (a booted node,
and a page pointed at it with console errors collected). `e2e/helpers/seed.js`
creates prerequisites — a workspace, a catalog, a customer — over the API, so
each spec spends its time on the flow it is actually testing. **The flow under
test is always driven through the browser.**

Two binaries are built by `e2e/global-setup.js` before the suite runs, and the
build is skipped when both are already newer than every source file:

| Binary            | Built by              | Driven by                       |
| ----------------- | --------------------- | ------------------------------- |
| `flowstock`       | `npm run build:all`   | every spec except the one below |
| `flowstock-dmtap` | `npm run build:dmtap` | `substrate-sync.spec.js` only   |

The second exists because the DMTAP engine is an opt-in build: the default
binary carries no engine and **exits at startup** if `FLOWSTOCK_SUBSTRATE_SYNC=1`
forces one on, so the substrate spec has nothing to run against without it.

Set `FLOWSTOCK_SKIP_BUILD=1` to skip both builds, or point `FLOWSTOCK_BIN` /
`FLOWSTOCK_DMTAP_BIN` at prebuilt binaries (CI builds them as its own steps).

### What is covered

| Spec                     | What it proves                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.spec.js`        | Creating a product and a variant through the UI, persisted to SQLite and surviving reload                                                                                                                                                                                           |
| `stock.spec.js`          | A recorded movement updates stock on hand and appears in the ledger; a transfer writes paired out/in movements sharing one `ref_id`                                                                                                                                                 |
| `orders.spec.js`         | Confirming a sales order deducts stock via a `sale` movement; receiving a purchase order twice appends two `po_receipts` rows summing to the total, with `received_quantity` derived at read time and over-receipt refused                                                          |
| `setup-pairing.spec.js`  | First run creates a workspace; a second device joins using the secret shown in the first device's Settings — entirely through the browser, no API calls                                                                                                                             |
| `sync-two-node.spec.js`  | **The core claim.** Two processes, two databases, divergent offline edits, then convergence asserted in both UIs. Includes concurrent movements at the _same_ branch, which must union-merge rather than clobber, and an unreachable-peer round that delivers once the peer returns |
| `folder-sync.spec.js`    | The zero-infrastructure path: with all network peers deleted, two nodes converge purely through `ops-<node>.jsonl` files in a shared folder, idempotently                                                                                                                           |
| `ui-guards.spec.js`      | Every route renders in **both** themes with readable headings (computed WCAG contrast against the real backdrop), a clean console, and working navigation                                                                                                                           |
| `substrate-sync.spec.js` | The same convergence claim on the `-tags dmtap` build, asserted on the engine's 33-byte `state_root` rather than on rendered rows, plus that a deleted product survives an ordinary re-create                                                                                       |

### Conventions

- **No arbitrary sleeps.** Use Playwright's auto-retrying assertions, or the
  `until()` helper for non-DOM conditions.
- **Drive sync explicitly.** The product syncs on a 60s background timer;
  tests call `POST /api/sync/now` (`node.syncNow()`) instead of waiting for it,
  which is what keeps the whole suite under half a minute.
- **Desktop viewport.** The top bar hides its "Sync now" label below the `sm`
  breakpoint, and the mobile drawer mounts a second sidebar that makes nav
  links ambiguous. The config pins 1440×900.
- **Scope table assertions.** `/stock` renders two tables (stock on hand, then
  the movement ledger) and both mention the SKU.
- **Status text is lowercase in the DOM** (`draft`, `confirmed`, `partially
received`) — the capitalisation is CSS only.
- Selects are Radix, not native: click the trigger, then the option (there is a
  `chooseOption` helper). Options are portalled to `body`, so scope option
  clicks to the page, not the dialog.

### Debugging a failure

```bash
npx playwright test e2e/sync-two-node.spec.js   # one spec
npx playwright test -g "converge"               # one test by name
npm run test:e2e:ui                             # interactive UI mode
npm run test:e2e:report                         # open the last HTML report
```

Failures keep a trace and a screenshot under `test-results/`; open a trace with
`npx playwright show-trace <path>`. To inspect a node's database after a
failure, set `FLOWSTOCK_KEEP_DATA=1` and the temp data dirs are left in place.

## CI

`.github/workflows/ci.yml` runs lint, the Go tests in both builds
(plain and `-tags dmtap`), both embedded builds, and the browser suite on every
push to `main` and every pull request. The Playwright HTML report is uploaded as
an artifact when the suite fails.
