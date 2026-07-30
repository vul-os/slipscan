// Package store is FlowStock's decentralized data engine: a local SQLite
// database plus an append-only oplog. Every mutation is journalled with a
// hybrid-logical-clock timestamp; branches converge by exchanging oplog
// entries. Catalog rows merge last-writer-wins; stock movements are
// insert-only and merge by union. There is no central authority — any node
// can relay any other node's ops.
package store

import (
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// Op is one journalled mutation. It is the unit of replication.
//
// OrgID names the workspace that produced the op. It travels with every op so
// data is self-describing: a node rejects ops from a different workspace even
// if a shared sync secret happens to match (see ApplyOps).
// Cose, when non-empty, is the op re-expressed as a DMTAP substrate SyncOp in a
// COSE_Sign1 envelope (hex), minted and signed by the authoring node. It is
// carried but ignored unless the substrate merge engine is enabled, so a node
// running without it relays a neighbour's envelopes unchanged.
type Op struct {
	HLC     string          `json:"hlc"`
	NodeID  string          `json:"node_id"`
	OrgID   string          `json:"org_id"`
	Tbl     string          `json:"tbl"`
	RowID   string          `json:"row_id"`
	Deleted bool            `json:"deleted"`
	Payload json.RawMessage `json:"payload"`
	Cose    string          `json:"cose,omitempty"`
}

// Merger is an optional external merge authority: the DMTAP substrate sync
// engine (substrate/SYNC.md §4). When one is installed the store stops deciding
// conflicts itself — it journals and projects, and the engine's algebra decides
// which write wins.
//
// It is a seam rather than a replacement so the hand-rolled engine below stays
// the default and stays reachable: with no Merger installed, not one line of the
// merge path changes.
type Merger interface {
	// Mint expresses a locally authored op as a signed SyncOp envelope (hex).
	Mint(op Op) (string, error)
	// Ingest records an op authored elsewhere, from its envelope. A refusal is
	// an error: the engine fails closed rather than merging unverified state.
	Ingest(op Op) error
	// Resolve returns the winning payload for a row, the winner's HLC in
	// FlowStock's string spelling, and whether the winner is a deletion. ok is
	// false when the engine holds no opinion about that row.
	Resolve(tbl, rowID string) (payload json.RawMessage, hlc string, deleted bool, ok bool)
	// NoteLegacy records that an op arrived with no envelope, so a mixed-mode
	// fleet is visible rather than silently half-merged by two algebras.
	NoteLegacy()
}

// Store owns the database and the local clock. All methods are safe for
// concurrent use.
type Store struct {
	mu     sync.Mutex
	db     *sql.DB
	clock  *HLC
	nodeID string
	orgID  string
	priv   ed25519.PrivateKey
	pub    ed25519.PublicKey
	// onChange fires after any committed local or remote mutation so the UI
	// can refresh (wired to an SSE broadcaster in the api layer).
	onChange func()
	// merger, when set, is the substrate engine that decides conflicts. nil
	// (the default) keeps the hand-rolled LWW/union path below.
	merger Merger
	// acceptUnsignedRemoteOps relaxes ApplyOps's fail-closed rule that, with a
	// merger installed, every remote op must carry its own signed envelope.
	// False (the default) is the R-SOV-3.2 posture: an op is authentic because
	// it is signed, never because of the connection it arrived on. It exists
	// only for a fleet mid-migration off the built-in engine, whose peers still
	// hold pre-switch ops with no envelope.
	acceptUnsignedRemoteOps bool
}

// SetAcceptUnsignedRemoteOps opts a node out of the fail-closed rule that a
// remote op must carry its own envelope when a Merger is installed. Call it
// before serving traffic; see the field comment for why the default is off.
func (s *Store) SetAcceptUnsignedRemoteOps(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.acceptUnsignedRemoteOps = v
}

// SetMerger installs an external merge authority. Passing nil restores the
// built-in engine. Call it before serving traffic.
func (s *Store) SetMerger(m Merger) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.merger = m
}

// Open opens (or creates) the database at path and prepares the schema, node
// id and clock. A brand-new database is assigned a fresh node id.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; WAL handles concurrent readers within the process
	if err := initSchema(db); err != nil {
		return nil, err
	}

	s := &Store{db: db}

	// Per-node Ed25519 identity (generated once), used to sign op batches and
	// snapshots. Transport auth is unchanged (shared Bearer secret).
	if err := s.ensureIdentity(); err != nil {
		return nil, fmt.Errorf("node identity: %w", err)
	}

	// Identity first: on a brand-new database the node id is derived from the
	// public key, so ensureIdentity has to run before node_id is settled.

	node, err := s.getSetting("node_id")
	if err != nil {
		return nil, err
	}
	if node == "" {
		// A fresh node's id IS its public key.
		//
		// FlowStock breaks an exact HLC tie on node id; the DMTAP substrate
		// engine breaks the same tie on the author's public key. Both converge,
		// but given identical history they can pick different winners — which is
		// why adopting the substrate has to be a deployment-wide switch rather
		// than a gradual rollout. Making the two values the same removes the
		// divergence at its source, so a future cutover is a change of engine
		// rather than a change of outcome.
		//
		// Only new databases. An existing node's peers enrolled its ULID at
		// pairing and every oplog row is keyed by it, so rewriting it would
		// invalidate the mesh and the history at once. Those nodes keep their
		// ULID and simply keep the tie-break they already had.
		node = s.PublicKeyHex()
		if node == "" {
			node = NewID() // identity unavailable: fall back rather than fail to open
		}
		if err := s.SetSetting("node_id", node); err != nil {
			return nil, err
		}
	}
	s.nodeID = node

	// Every workspace has a stable org id, generated once on a brand-new
	// database. A node adopts a peer's org id when it pairs into an existing
	// workspace (see AdoptOrg); until then it owns its own.
	org, err := s.getSetting("org_id")
	if err != nil {
		return nil, err
	}
	if org == "" {
		org = NewID()
		if err := s.SetSetting("org_id", org); err != nil {
			return nil, err
		}
	}
	s.orgID = org

	// Seed the clock past everything already journalled.
	var maxHLC sql.NullString
	_ = db.QueryRow("SELECT MAX(hlc) FROM oplog").Scan(&maxHLC)
	s.clock = NewHLC(node, maxHLC.String)
	return s, nil
}

func (s *Store) Close() error   { return s.db.Close() }
func (s *Store) NodeID() string { return s.nodeID }

// OrgID returns this node's workspace id.
func (s *Store) OrgID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.orgID
}

// LocalOpCount returns how many ops this node has authored itself. A node that
// has authored none is "unadopted" and may still join another workspace.
func (s *Store) LocalOpCount() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM oplog WHERE node_id = ?", s.nodeID).Scan(&n)
	return n, err
}

// AdoptOrg makes this node part of the workspace identified by org. It is only
// permitted while the node has authored no ops of its own (a fresh install that
// is pairing into an existing workspace); a node that already has local history
// keeps its own workspace, so two established workspaces can never silently
// merge. Returns true if the org was adopted.
func (s *Store) AdoptOrg(org string) (bool, error) {
	if org == "" {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if org == s.orgID {
		return false, nil
	}
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM oplog WHERE node_id = ?", s.nodeID).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil // established node: never re-home
	}
	if err := s.SetSetting("org_id", org); err != nil {
		return false, err
	}
	s.orgID = org
	return true, nil
}

// SetOnChange registers a callback fired after every committed mutation.
func (s *Store) SetOnChange(fn func()) { s.onChange = fn }

func (s *Store) fireChange() {
	if s.onChange != nil {
		s.onChange()
	}
}

// ── settings ────────────────────────────────────────────────────────────────

func (s *Store) getSetting(key string) (string, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

// GetSetting returns a setting value, or "" if unset.
func (s *Store) GetSetting(key string) string {
	v, _ := s.getSetting(key)
	return v
}

// SetSetting upserts a setting.
func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// ── row writes ──────────────────────────────────────────────────────────────

func coerce(k colKind, v any) any {
	if v == nil {
		return nil
	}
	switch k {
	case kindText:
		switch x := v.(type) {
		case string:
			return x
		default:
			b, _ := json.Marshal(x)
			return string(b)
		}
	case kindReal:
		switch x := v.(type) {
		case float64:
			return x
		case string:
			var f float64
			if _, err := fmt.Sscan(x, &f); err == nil {
				return f
			}
			return nil
		case bool:
			if x {
				return 1.0
			}
			return 0.0
		}
	case kindInt:
		switch x := v.(type) {
		case float64:
			return int64(x)
		case bool:
			if x {
				return int64(1)
			}
			return int64(0)
		case string:
			var i int64
			if _, err := fmt.Sscan(x, &i); err == nil {
				return i
			}
			return nil
		}
	}
	return nil
}

// writeRow upserts a row from an op payload inside tx. Mutable tables resolve
// last-writer-wins on the hlc column; insert-only tables ignore conflicts.
//
// resolved reports that op already carries the merge authority's verdict for
// this row rather than one candidate write, so the row is written
// unconditionally: re-applying the SQL "greater hlc wins" guard on top would let
// SQLite overrule the engine, which is precisely the second algebra installing
// one is meant to remove.
func writeRow(tx *sql.Tx, td tableDef, op Op, resolved bool) error {
	var payload map[string]any
	if len(op.Payload) > 0 {
		_ = json.Unmarshal(op.Payload, &payload)
	}

	names := make([]string, len(td.cols))
	placeholders := make([]string, len(td.cols))
	args := []any{op.RowID, op.HLC, boolToInt(op.Deleted), op.OrgID}
	for i, c := range td.cols {
		names[i] = c.name
		placeholders[i] = "?"
		args = append(args, coerce(c.kind, payload[c.name]))
	}

	colList := ""
	valList := ""
	for i, n := range names {
		colList += ", " + n
		valList += ", " + placeholders[i]
	}

	var stmt string
	if td.insertOnly {
		stmt = fmt.Sprintf("INSERT OR IGNORE INTO %s (id, hlc, deleted, org_id%s) VALUES (?, ?, ?, ?%s)",
			td.name, colList, valList)
	} else {
		updates := "hlc = excluded.hlc, deleted = excluded.deleted, org_id = excluded.org_id"
		for _, n := range names {
			updates += fmt.Sprintf(", %s = excluded.%s", n, n)
		}
		guard := fmt.Sprintf(" WHERE excluded.hlc > %s.hlc", td.name)
		if resolved {
			guard = ""
		}
		stmt = fmt.Sprintf(`INSERT INTO %s (id, hlc, deleted, org_id%s) VALUES (?, ?, ?, ?%s)
			ON CONFLICT(id) DO UPDATE SET %s%s`,
			td.name, colList, valList, updates, guard)
	}
	_, err := tx.Exec(stmt, args...)
	return err
}

// resolveWrite asks the merge authority what the row should now contain, given
// that op has just been admitted. It returns the op to project and whether that
// projection is authoritative.
//
// Insert-only ledgers are returned unresolved on purpose: their merge is set
// union, and "INSERT OR IGNORE" already computes exactly that, so there is
// nothing for the engine to overrule. The engine still holds every movement as
// an OR-Set element — that is what makes its state root a check on the ledger
// rather than a restatement of it.
func (s *Store) resolveWrite(td tableDef, op Op) (Op, bool) {
	if td.insertOnly {
		return op, false
	}
	payload, hlc, deleted, ok := s.merger.Resolve(op.Tbl, op.RowID)
	if !ok {
		return op, false
	}
	win := op
	win.Payload = payload
	win.Deleted = deleted
	if hlc != "" {
		win.HLC = hlc
	}
	return win, true
}

func appendOplog(tx *sql.Tx, op Op) (bool, error) {
	res, err := tx.Exec(
		`INSERT OR IGNORE INTO oplog (hlc, node_id, org_id, tbl, row_id, deleted, payload, cose)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		op.HLC, op.NodeID, op.OrgID, op.Tbl, op.RowID, boolToInt(op.Deleted), string(op.Payload), op.Cose)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// LocalPut stamps a fresh HLC and writes row + oplog atomically. It is the
// only entry point for local mutations.
func (s *Store) LocalPut(tbl, rowID string, payload map[string]any, deleted bool) (Op, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	td, ok := tableByName(tbl)
	if !ok {
		return Op{}, fmt.Errorf("unknown table: %s", tbl)
	}
	if td.insertOnly && deleted {
		return Op{}, fmt.Errorf("table %s is insert-only", tbl)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return Op{}, err
	}
	op := Op{HLC: s.clock.Tick(), NodeID: s.nodeID, OrgID: s.orgID, Tbl: tbl, RowID: rowID, Deleted: deleted, Payload: raw}

	// With a merge authority installed, the op is expressed as a signed SyncOp
	// and admitted to the engine before it reaches SQLite, so what lands in the
	// row is the engine's verdict rather than this write taken on trust. A
	// signing or admission failure aborts the mutation: journalling a write the
	// engine would not accept is how the two states drift apart.
	write := op
	resolved := false
	if s.merger != nil {
		cose, err := s.merger.Mint(op)
		if err != nil {
			return Op{}, fmt.Errorf("substrate mint: %w", err)
		}
		op.Cose = cose
		write, resolved = s.resolveWrite(td, op)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return Op{}, err
	}
	if err := writeRow(tx, td, write, resolved); err != nil {
		tx.Rollback()
		return Op{}, err
	}
	if _, err := appendOplog(tx, op); err != nil {
		tx.Rollback()
		return Op{}, err
	}
	if err := tx.Commit(); err != nil {
		return Op{}, err
	}
	s.fireChange()
	return op, nil
}

// ApplyOps applies remote ops idempotently and returns how many were new.
func (s *Store) ApplyOps(ops []Op) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Admission runs to completion before the transaction opens, for two
	// reasons. The engine may need to read this database (to check which key a
	// node enrolled), and the connection pool is one connection wide — asking it
	// inside a transaction deadlocks. And admitting the whole batch first means
	// the verdict each row is written from is the batch's final winner rather
	// than an intermediate one.
	admitted := make([]bool, len(ops))
	if s.merger != nil {
		for i, op := range ops {
			// op.HLC arrives as a caller-chosen JSON string, from a peer this node
			// otherwise trusts to authenticate but not to hand-format a timestamp
			// correctly. Skip rather than admit or persist one outside ParseHLC's
			// fixed width: it is exactly the string this package's own width bounds
			// exist to keep out of the ordered domain the oplog's MAX(hlc) and the
			// row guard below both compare lexically.
			if _, _, _, ok := ParseHLC(op.HLC); !ok {
				continue
			}
			if _, ok := tableByName(op.Tbl); !ok {
				continue
			}
			if op.OrgID != "" && op.OrgID != s.orgID {
				continue
			}
			if op.Cose == "" {
				// An op with no envelope cannot be verified on its own — the only
				// thing vouching for it is the connection it arrived over, which is
				// exactly what substrate/SOVEREIGNTY.md R-SOV-3.2 forbids relying
				// on. On a node whose merge authority is the substrate it is also a
				// second algebra's op, so accepting it diverges the merge as well.
				// Both reasons say refuse, and refusing aborts the batch rather
				// than dropping one row, because a partially-applied push is a
				// silent hole.
				if !s.acceptUnsignedRemoteOps {
					s.merger.NoteLegacy() // still counted: an operator must see it happening
					return 0, fmt.Errorf("substrate: op %s (%s/%s) carries no signed envelope; "+
						"refusing to merge a change that cannot be verified on its own "+
						"(set substrate_accept_unsigned_ops only while migrating a fleet off the built-in engine)",
						op.HLC, op.Tbl, op.RowID)
				}
				// Migration escape hatch, off by default: merged by the built-in
				// algebra and counted, because a fleet running two algebras at once
				// is a condition an operator must be able to see.
				s.merger.NoteLegacy()
				continue
			}
			if err := s.merger.Ingest(op); err != nil {
				return 0, fmt.Errorf("substrate ingest %s: %w", op.HLC, err)
			}
			admitted[i] = true
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	fresh := 0
	for i, op := range ops {
		// Same rejection as the admission loop above, applied again here because
		// this loop runs unconditionally (there may be no merger at all) and is
		// the actual write path: appendOplog and writeRow's own LWW guard both
		// compare op.HLC lexically, so an out-of-width string reaching either one
		// is the network-reachable order-inversion 0c6beba fixed for the local
		// clock, reopened at a second entry point.
		if _, _, _, ok := ParseHLC(op.HLC); !ok {
			continue
		}
		td, ok := tableByName(op.Tbl)
		if !ok {
			continue
		}
		// Isolation boundary: never merge another workspace's ops, even if a
		// shared sync secret let them through the transport. Ops with no org id
		// (legacy/pre-org data) are accepted and inherit ours implicitly.
		if op.OrgID != "" && op.OrgID != s.orgID {
			continue
		}
		write := op
		resolved := false
		if admitted[i] {
			write, resolved = s.resolveWrite(td, op)
		}
		isNew, err := appendOplog(tx, op)
		if err != nil {
			tx.Rollback()
			return 0, err
		}
		if isNew {
			if err := writeRow(tx, td, write, resolved); err != nil {
				tx.Rollback()
				return 0, err
			}
			s.clock.Observe(op.HLC)
			fresh++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if fresh > 0 {
		s.fireChange()
	}
	return fresh, nil
}

// ── version vector + op selection ─────────────────────────────────────────────

// Vector is this node's knowledge: newest hlc seen per origin node. It merges
// the live oplog with the snapshot floor (what a compaction already folded into
// a snapshot and pruned), so pruning ops never makes the node forget what it
// has already seen — the version vector can only move forward.
func (s *Store) Vector() (map[string]string, error) {
	rows, err := s.db.Query("SELECT node_id, MAX(hlc) FROM oplog GROUP BY node_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var node, hlc string
		if err := rows.Scan(&node, &hlc); err != nil {
			return nil, err
		}
		out[node] = hlc
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	floor, _ := s.snapshotFloor()
	for node, hlc := range floor {
		if hlc > out[node] {
			out[node] = hlc
		}
	}
	return out, nil
}

// snapshotFloor is the version vector already captured by a snapshot and pruned
// from the oplog. Persisted as JSON in settings.
func (s *Store) snapshotFloor() (map[string]string, error) {
	v := s.GetSetting("snapshot_floor")
	out := map[string]string{}
	if v == "" {
		return out, nil
	}
	err := json.Unmarshal([]byte(v), &out)
	return out, err
}

func (s *Store) mergeSnapshotFloor(add map[string]string) error {
	cur, err := s.snapshotFloor()
	if err != nil {
		return err
	}
	for node, hlc := range add {
		if hlc > cur[node] {
			cur[node] = hlc
		}
	}
	b, _ := json.Marshal(cur)
	return s.SetSetting("snapshot_floor", string(b))
}

// OpsAfter returns ops the holder of remoteVector has not seen, oldest first,
// up to limit.
func (s *Store) OpsAfter(remoteVector map[string]string, limit int) ([]Op, error) {
	rows, err := s.db.Query(
		"SELECT hlc, node_id, org_id, tbl, row_id, deleted, payload, cose FROM oplog ORDER BY hlc ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Op
	for rows.Next() {
		var op Op
		var del int
		var payload string
		if err := rows.Scan(&op.HLC, &op.NodeID, &op.OrgID, &op.Tbl, &op.RowID, &del, &payload, &op.Cose); err != nil {
			return nil, err
		}
		op.Deleted = del != 0
		op.Payload = json.RawMessage(payload)
		if seen, ok := remoteVector[op.NodeID]; ok && op.HLC <= seen {
			continue
		}
		out = append(out, op)
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

// OwnOpsAfter returns this node's own ops with an HLC strictly greater than
// afterHLC, oldest first. It is the basis of the folder-sync exporter: a node
// only ever exports the ops it authored, so its export file has a single writer
// and file-sync tools (Dropbox/Syncthing/NAS) never see a conflict.
func (s *Store) OwnOpsAfter(afterHLC string) ([]Op, error) {
	rows, err := s.db.Query(
		`SELECT hlc, node_id, org_id, tbl, row_id, deleted, payload, cose FROM oplog
		 WHERE node_id = ? AND hlc > ? ORDER BY hlc ASC`, s.nodeID, afterHLC)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Op
	for rows.Next() {
		var op Op
		var del int
		var payload string
		if err := rows.Scan(&op.HLC, &op.NodeID, &op.OrgID, &op.Tbl, &op.RowID, &del, &payload, &op.Cose); err != nil {
			return nil, err
		}
		op.Deleted = del != 0
		op.Payload = json.RawMessage(payload)
		out = append(out, op)
	}
	return out, rows.Err()
}

// ── reads ─────────────────────────────────────────────────────────────────────

// ListRows returns all live (or all, if includeDeleted) rows of a table as
// JSON objects keyed by column name.
func (s *Store) ListRows(tbl string, includeDeleted bool) ([]map[string]any, error) {
	if _, ok := tableByName(tbl); !ok {
		return nil, fmt.Errorf("unknown table: %s", tbl)
	}
	where := "WHERE deleted = 0"
	if includeDeleted {
		where = ""
	}
	rows, err := s.db.Query(fmt.Sprintf("SELECT * FROM %s %s ORDER BY id ASC", tbl, where))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		obj := map[string]any{}
		for i, c := range cols {
			obj[c] = normalize(vals[i])
		}
		out = append(out, obj)
	}
	return out, rows.Err()
}

// GetRow returns one row (including soft-deleted) or nil.
func (s *Store) GetRow(tbl, id string) (map[string]any, error) {
	rows, err := s.ListRows(tbl, true)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if r["id"] == id {
			return r, nil
		}
	}
	return nil, nil
}

// StockLevel is on-hand quantity for a (variant, branch) pair.
type StockLevel struct {
	VariantID string  `json:"variant_id"`
	BranchID  string  `json:"branch_id"`
	Qty       float64 `json:"qty"`
}

// StockLevels sums the movement ledger per (variant, branch).
func (s *Store) StockLevels() ([]StockLevel, error) {
	rows, err := s.db.Query(
		`SELECT variant_id, branch_id, SUM(qty_delta) FROM stock_movements
		 GROUP BY variant_id, branch_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StockLevel
	for rows.Next() {
		var l StockLevel
		if err := rows.Scan(&l.VariantID, &l.BranchID, &l.Qty); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ReceivedByItem returns the received quantity per purchase-order line item,
// derived as SUM(qty) over the insert-only po_receipts ledger. This is the
// source of truth for "how much of this line has arrived": because it is a
// union of immutable receipt facts, concurrent partial receipts on different
// branches add up instead of overwriting one another.
func (s *Store) ReceivedByItem() (map[string]float64, error) {
	rows, err := s.db.Query("SELECT po_item_id, SUM(qty) FROM po_receipts GROUP BY po_item_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var item string
		var qty float64
		if err := rows.Scan(&item, &qty); err != nil {
			return nil, err
		}
		out[item] = qty
	}
	return out, rows.Err()
}

// MovementsForRef returns movements written against a document (order/PO) of a
// given kind — used to make status transitions idempotent.
func (s *Store) MovementsForRef(refKind, refID, kind string) ([]map[string]any, error) {
	rows, err := s.db.Query(
		`SELECT id, variant_id, branch_id, qty_delta FROM stock_movements
		 WHERE ref_kind = ? AND ref_id = ? AND kind = ?`, refKind, refID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var id, variant, branch string
		var delta float64
		if err := rows.Scan(&id, &variant, &branch, &delta); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "variant_id": variant, "branch_id": branch, "qty_delta": delta})
	}
	return out, rows.Err()
}

// ── peers ─────────────────────────────────────────────────────────────────────

// Peer is another branch node. NodeID is the remote node's identity once known
// (learned when we dial it, or recorded when it enrolls a key inbound); an
// inbound-only enrollment has a NodeID and a pubkey but no dial URL.
type Peer struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled"`
	LastSyncAt string `json:"last_sync_at"`
	LastStatus string `json:"last_status"`
	NodeID     string `json:"node_id"`
	HasKey     bool   `json:"has_key"`
}

func (s *Store) ListPeers() ([]Peer, error) {
	rows, err := s.db.Query(
		"SELECT id, name, url, enabled, last_sync_at, last_status, node_id, pubkey FROM peers ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Peer
	for rows.Next() {
		var p Peer
		var en int
		var pubkey string
		if err := rows.Scan(&p.ID, &p.Name, &p.URL, &en, &p.LastSyncAt, &p.LastStatus, &p.NodeID, &pubkey); err != nil {
			return nil, err
		}
		p.Enabled = en != 0
		p.HasKey = pubkey != ""
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) SavePeer(p Peer) error {
	if p.ID == "" {
		p.ID = NewID()
	}
	_, err := s.db.Exec(
		`INSERT INTO peers (id, name, url, enabled) VALUES (?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, enabled = excluded.enabled`,
		p.ID, p.Name, p.URL, boolToInt(p.Enabled))
	return err
}

func (s *Store) DeletePeer(id string) error {
	_, err := s.db.Exec("DELETE FROM peers WHERE id = ?", id)
	return err
}

func (s *Store) UpdatePeerStatus(id, at, status string) {
	_, _ = s.db.Exec("UPDATE peers SET last_sync_at = ?, last_status = ? WHERE id = ?", at, status, id)
}

// SavePeerVector records a peer's most recently observed version vector. It is
// the input to conservative oplog pruning: an op may be dropped only once every
// registered peer has acknowledged it.
func (s *Store) SavePeerVector(id string, vec map[string]string) {
	b, _ := json.Marshal(vec)
	_, _ = s.db.Exec("UPDATE peers SET vector = ? WHERE id = ?", string(b), id)
}

// SavePeerPubkey records a peer's Ed25519 public key (hex), learned on pairing.
func (s *Store) SavePeerPubkey(id, pubkeyHex string) {
	_, _ = s.db.Exec("UPDATE peers SET pubkey = ? WHERE id = ?", pubkeyHex, id)
}

// SavePeerIdentity records both the remote node's id and its Ed25519 public key
// (hex) against a peer row we dial. Storing the node id lets inbound requests
// from that same node be authenticated by key (see PubkeyForNode).
func (s *Store) SavePeerIdentity(id, nodeID, pubkeyHex string) {
	_, _ = s.db.Exec("UPDATE peers SET node_id = ?, pubkey = ? WHERE id = ?", nodeID, pubkeyHex, id)
}

// PeerPubkey returns a peer's recorded public key (hex), or "".
func (s *Store) PeerPubkey(id string) string {
	var v string
	_ = s.db.QueryRow("SELECT pubkey FROM peers WHERE id = ?", id).Scan(&v)
	return v
}

// PubkeyForNode returns the recorded Ed25519 public key (hex) for a remote node
// id, or "" if that node has never enrolled a key. It is the authority for
// mutual key authentication: an inbound signed request is verified against the
// key returned here, so an attacker cannot present its own key for another
// node's id.
func (s *Store) PubkeyForNode(nodeID string) string {
	if nodeID == "" {
		return ""
	}
	var v string
	_ = s.db.QueryRow(
		"SELECT pubkey FROM peers WHERE node_id = ? AND pubkey <> '' LIMIT 1", nodeID).Scan(&v)
	return v
}

// RecordPeerIdentity enrolls a remote node's public key for inbound key auth.
// If a peer row already references this node id, its key is updated in place;
// otherwise an inbound-only row (no dial URL) is inserted so the operator can
// see — and, by deleting the row, revoke — every node that has paired inbound.
// Enrolling the same key again is a no-op.
func (s *Store) RecordPeerIdentity(nodeID, pubkeyHex string) {
	if nodeID == "" || pubkeyHex == "" {
		return
	}
	if s.PubkeyForNode(nodeID) == pubkeyHex {
		return // already enrolled with this exact key
	}
	res, err := s.db.Exec("UPDATE peers SET pubkey = ? WHERE node_id = ?", pubkeyHex, nodeID)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			return
		}
	}
	name := "inbound " + nodeID
	if len(nodeID) > 8 {
		name = "inbound " + nodeID[:8]
	}
	_, _ = s.db.Exec(
		`INSERT INTO peers (id, name, url, enabled, node_id, pubkey) VALUES (?, ?, '', 1, ?, ?)`,
		NewID(), name, nodeID, pubkeyHex)
}

// EnabledPeerVectors returns the saved version vector of every enabled peer.
// A peer with no recorded vector yet contributes an empty map, which blocks all
// pruning (we cannot prove it has anything) — the safe default.
func (s *Store) EnabledPeerVectors() ([]map[string]string, error) {
	rows, err := s.db.Query("SELECT vector FROM peers WHERE enabled = 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		m := map[string]string{}
		if v != "" {
			_ = json.Unmarshal([]byte(v), &m)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// PruneAckedOps removes oplog entries that every enabled peer has already
// acknowledged, keeping at least the newest op per origin node so the version
// vector never regresses. It is deliberately conservative: with no peers, or
// any peer whose acknowledgement of an origin node is unknown, nothing for that
// node is pruned. The pruned range is folded into the snapshot floor first, so
// Vector() is unaffected.
//
// Tradeoff (documented): after pruning, a brand-new peer can no longer catch up
// from the oplog alone for the pruned range; it must import a snapshot. Already
// registered peers are unaffected because they have, by definition, acknowledged
// everything pruned.
func (s *Store) PruneAckedOps() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	peerVecs, err := s.EnabledPeerVectors()
	if err != nil {
		return 0, err
	}
	if len(peerVecs) == 0 {
		return 0, nil // never prune without at least one acknowledging peer
	}

	// Per origin node, the floor = min acknowledged hlc across all peers.
	origins := map[string]bool{}
	rows, err := s.db.Query("SELECT DISTINCT node_id FROM oplog")
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return 0, err
		}
		origins[n] = true
	}
	rows.Close()

	floor := map[string]string{}
	for origin := range origins {
		min := ""
		known := true
		for i, pv := range peerVecs {
			h := pv[origin]
			if h == "" {
				known = false // this peer hasn't acknowledged anything from origin
				break
			}
			if i == 0 || h < min {
				min = h
			}
		}
		if known && min != "" {
			floor[origin] = min
		}
	}
	if len(floor) == 0 {
		return 0, nil
	}

	// Record the floor before deleting, so the vector cannot regress even for a
	// moment.
	if err := s.mergeSnapshotFloor(floor); err != nil {
		return 0, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	total := 0
	for origin, upto := range floor {
		// Keep the single newest op per origin so Vector()'s oplog term is stable.
		res, err := tx.Exec(
			`DELETE FROM oplog WHERE node_id = ? AND hlc <= ?
			 AND hlc <> (SELECT MAX(hlc) FROM oplog WHERE node_id = ?)`,
			origin, upto, origin)
		if err != nil {
			tx.Rollback()
			return 0, err
		}
		n, _ := res.RowsAffected()
		total += int(n)
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return total, nil
}

// ── helpers ────────────────────────────────────────────────────────────────

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// normalize turns a SQLite driver value into a clean JSON-friendly Go value.
func normalize(v any) any {
	switch x := v.(type) {
	case []byte:
		return string(x)
	case int64:
		return x
	case float64:
		return x
	case string:
		return x
	case nil:
		return nil
	default:
		return fmt.Sprintf("%v", x)
	}
}

// SplitList splits a comma/space/newline separated string, trimming blanks.
func SplitList(s string) []string {
	fields := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == '\r'
	})
	return fields
}
