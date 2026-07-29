module flowstock

go 1.25.0

// The DMTAP Sync engine is a published module now, fetched like any other
// dependency and pinned by go.sum. It used to be a vendored copy under
// third_party/, because the binding's old home was never a tagged, fetchable
// module and its embedded .wasm was gitignored upstream, so a proxy fetch
// arrived with the //go:embed target missing. Both reasons are gone: the engine
// moved to the vul-os/kotva substrate repo, the artifact is committed and tied
// to its Rust sources by wasm_provenance.json, and v0.2.0 is tagged. The Go
// package renamed with the repo, and is imported only from files behind
// `//go:build dmtap`. See CHANGELOG.md for the migration, and
// backend/internal/substrate/engine_pin_test.go for what keeps it this way.
require (
	github.com/vul-os/kotva/bindings/go v0.2.1
	modernc.org/sqlite v1.34.5
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/tetratelabs/wazero v1.12.0 // indirect
	golang.org/x/sys v0.44.0 // indirect
	modernc.org/libc v1.55.3 // indirect
	modernc.org/mathutil v1.6.0 // indirect
	modernc.org/memory v1.8.0 // indirect
)
