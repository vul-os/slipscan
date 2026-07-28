//go:build dmtap

package substrate

import (
	"math"
	"testing"

	kotvasync "github.com/vul-os/kotva/bindings/go"
)

// flowstockHLC must never hand back a string whose lexical order can diverge
// from its numeric order (store.FormatHLC's contract). h.Wall and h.Counter
// come from the substrate engine's own domain (uint64, uint32) and never pass
// through this node's own HLC clock's bump()/spill logic, so a resolved cell
// can legitimately carry a value wider than FlowStock's fixed-width string
// format allows — the same network-reachable hazard 0c6beba fixed for the
// local clock's Observe path, reopened here at a second, independent
// construction site the earlier fix never touched (it only edited hlc.go).
//
// This is a package-internal test (not substrate_test) specifically to reach
// the unexported flowstockHLC and Engine.nodeOf without paying for a compiled
// wasm engine: neither is touched by this method.
func TestFlowstockHLCRejectsOutOfWidthValues(t *testing.T) {
	e := &Engine{nodeOf: map[string]string{"aa": "node1"}}

	if got := e.flowstockHLC(kotvasync.HLC{Wall: 1700000000000, Counter: 5, Author: "aa"}); got == "" {
		t.Fatal("an in-bounds HLC should render a string, got \"\"")
	}

	cases := map[string]kotvasync.HLC{
		"counter one past the 4-hex-digit width": {Wall: 1700000000000, Counter: 0x10000, Author: "aa"},
		"wall one digit past the 13-digit width": {Wall: 10000000000000, Counter: 0, Author: "aa"},
		"wall past int64 entirely":               {Wall: math.MaxUint64, Counter: 0, Author: "aa"},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			if got := e.flowstockHLC(h); got != "" {
				t.Fatalf("expected \"\" for an out-of-width verdict, got %q — "+
					"this is exactly the string whose lexical order can diverge from its numeric order", got)
			}
		})
	}

	// An unmapped author must still report "" (the pre-existing behaviour),
	// so the new bounds check does not mask or change that case.
	if got := e.flowstockHLC(kotvasync.HLC{Wall: 1700000000000, Counter: 5, Author: "unknown"}); got != "" {
		t.Fatalf("an unmapped author should render \"\", got %q", got)
	}
}
