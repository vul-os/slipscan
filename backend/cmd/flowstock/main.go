// Command flowstock is a single self-hosted binary that runs one branch of a
// FlowStock deployment: an inventory app served in the browser, backed by a
// local SQLite database, that syncs peer-to-peer with the business's other
// branches. Run it on a laptop, a shop counter PC, a server, a NAS or a Pi.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"flowstock/backend/internal/api"
	"flowstock/backend/internal/auth"
	"flowstock/backend/internal/config"
	"flowstock/backend/internal/store"
	"flowstock/backend/internal/substrate"
	syncpkg "flowstock/backend/internal/sync"
)

// Version is injected at build time via -ldflags "-X main.Version=vX.Y.Z".
var Version = "dev"

// securityHeaders sets baseline headers. Frame embedding follows
// cfg.FrameAncestors so the Vulos OS shell can host FlowStock in an iframe;
// empty (default) blocks all cross-origin framing.
func securityHeaders(cfg *config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.FrameAncestors != "" {
			w.Header().Set("Content-Security-Policy", "frame-ancestors "+cfg.FrameAncestors)
		} else {
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", "frame-ancestors 'self'")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

func main() {
	portFlag := flag.String("port", "", "override listen port")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println("flowstock", Version)
		return
	}

	cfg := config.Load()
	if *portFlag != "" {
		cfg.Port = *portFlag
	}

	st, err := store.Open(cfg.DBPath())
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer st.Close()

	// The shared DMTAP sync engine, on unless an operator pins this node to the
	// built-in CRDT. It is the merge authority: FlowStock still owns storage,
	// transport and identity, and the substrate's six-kind algebra decides which
	// write wins.
	//
	// Compiling the engine is the expensive step (~200-400ms) and is paid once
	// here, then amortized over the process lifetime — which is why a daemon
	// syncing on a timer never pays it again. The compiled code is cached in the
	// data dir so a restart pays roughly a tenth of it.
	//
	// A failure here is fatal on purpose. Starting anyway would silently run the
	// built-in engine on a node an operator has configured for the substrate,
	// and a mesh where different nodes merge by different algebras converges
	// only by luck.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var substrateEngine *substrate.Engine
	if cfg.UseSubstrate() {
		started := time.Now()
		substrateEngine, err = substrate.OpenForStore(ctx, st, filepath.Join(cfg.DataDir, "wasm-cache"))
		if err != nil {
			log.Fatalf("substrate sync engine: %v", err)
		}
		defer substrateEngine.Close(context.Background())
		st.SetMerger(substrateEngine)
		log.Printf("substrate sync engine active (compiled in %s) — merges follow SYNC.md, not the built-in CRDT",
			time.Since(started).Round(time.Millisecond))
	}

	syncEngine := syncpkg.New(st, func() string { return st.GetSetting("sync_secret") })
	syncEngine.FolderFn = func() string { return st.GetSetting("sync_folder") }
	syncEngine.AllowSecretFallback = cfg.SyncSecretFallback
	// Advertise the algebra this node merges by, so a peer running the other one
	// is refused rather than silently diverged from.
	if cfg.UseSubstrate() {
		syncEngine.MergeEngine = syncpkg.MergeSubstrate
	} else {
		syncEngine.MergeEngine = syncpkg.MergeBuiltin
	}
	apiServer := api.New(st, syncEngine, Version)
	apiServer.SnapshotDir = cfg.DataDir
	apiServer.Substrate = substrateEngine
	authHandler := auth.New(cfg.Password)

	mux := http.NewServeMux()

	// Public in the sense that the app's password gate does not cover them: the
	// sync mesh authenticates itself, and more strictly. Every request is signed
	// with the caller's node Ed25519 key and verified against the key that node
	// enrolled when it paired (sync.transportAuth); the shared secret only
	// bootstraps that enrollment. Wrapping these in authHandler.Middleware would
	// mean a peer had to know the operator's password, which is not a credential
	// another branch has.
	//
	// This comment used to read "carries its own bearer-secret auth", which
	// stopped being true when the transport moved to mutual key auth.
	mux.HandleFunc("POST /api/auth/login", authHandler.Login)
	mux.HandleFunc("GET /api/auth/check", authHandler.Check)
	mux.Handle("DELETE /api/auth/logout", authHandler.Middleware(http.HandlerFunc(authHandler.Logout)))
	mux.Handle("/api/sync/vector", syncEngine.Handler())
	mux.Handle("/api/sync/ops", syncEngine.Handler())
	mux.Handle("/api/sync/pull", syncEngine.Handler())
	mux.Handle("/api/sync/ping", syncEngine.Handler())

	// Protected application API.
	appMux := http.NewServeMux()
	apiServer.Routes(appMux)
	// Pairing a fresh device into an existing workspace (pre-setup).
	appMux.HandleFunc("POST /api/workspace/join", apiServer.HandleJoin)
	mux.Handle("/api/", authHandler.Middleware(appMux))

	// Frontend (embedded in release builds; dev-proxied otherwise).
	mux.Handle("/", newFrontendHandler())

	// Background peer sync once a minute.
	go syncEngine.RunBackground(ctx, time.Minute)

	srv := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           securityHeaders(cfg, mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("FlowStock %s — branch %q — http://%s", Version, st.GetSetting("branch_name"), cfg.Addr())
		if st.GetSetting("sync_secret") != "" {
			log.Printf("sync mesh live on the same port (mutual Ed25519 key auth; shared secret bootstraps pairing)")
		}
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down…")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}
