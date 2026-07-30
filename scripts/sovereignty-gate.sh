#!/bin/sh
# The R-SOV-1 gate, configured for FlowStock, plus the gate's own self-control.
#
# tools/gates/no-broker-dep.sh is LIFTED VERBATIM from the substrate
# (kotva/tools/gates/no-broker-dep.sh) — do not edit that copy, re-copy it. The
# configuration that is FlowStock's business lives here, in one place, so the
# Makefile and .github/workflows/ci.yml cannot drift into gating different things.
#
# WHY BOTH. A copied gate drifts, and the copy that no longer fails on a planted
# violation is worse than no gate: it reports a pass nobody earned. So --selftest
# runs in the same step, and the whole script exits non-zero if either half does.
#
# EXIT STATUS is the gate's own: 0 checked and clean, 1 a violation, 2 could not
# check. There is no path here that turns a 2 into a 0.
set -u

ROOT=${1:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}
GATE="$ROOT/tools/gates/no-broker-dep.sh"

[ -f "$GATE" ] || {
	echo "CANNOT CHECK  the gate is missing at $GATE — re-copy it from kotva/tools/gates/" >&2
	exit 2
}

# DOC_PATHS is prose, where naming a broker is the point: "you MAY plug one in
# here". FlowStock's docs live in two places that must stay byte-identical —
# docs/ and the published site/docs/ mirror (scripts/docs-mirror.mjs) — so both
# are listed. site/ also holds the hand-authored landing shells, which are
# marketing prose for the same reason. The gate's default DOC_PATHS covers only
# docs/, README.md, CHANGELOG.md and LICENSE.md, and FlowStock is dual-licensed
# with no plain LICENSE file, hence the explicit list.
#
# tools/gates/ is exempt for one reason only: it holds the gate, whose single
# mention of a broker is the pattern it searches FOR. C-START is deliberately
# blunt (it fails on any mention, comments included), and the alternative to this
# one-directory exemption is a gate that trips on itself. Nothing else under
# tools/ or scripts/ is exempt, so a broker name added to a build or deploy
# script is still caught.
#
# SEAM_PATHS is deliberately EMPTY: FlowStock has no broker integration at all,
# which is the strictest posture the gate has and the correct one here. If a
# reachability provider is ever added it goes behind a `//go:build` tag and BOTH
# SEAM_PATHS and SEAM_FLAG get set — see kotva substrate/SOVEREIGNTY.md §5.3.
#
# BROKER_RE is left at the gate's own default rather than restated here, so this
# file names no broker and needs no exemption of its own. The default is in
# tools/gates/no-broker-dep.sh's CONFIGURATION block; read it there.
DOC_PATHS='docs/ site/ tools/gates/ README.md CHANGELOG.md SECURITY.md LICENSE-MIT LICENSE-APACHE'
export DOC_PATHS

rc=0
echo "== R-SOV-1 gate =="
sh "$GATE" "$ROOT" || rc=$?

echo
echo "== the gate's own self-control =="
# The selftest builds hermetic fixtures in a temp dir and runs the gate against
# them; it does not read $ROOT, and it must not inherit FlowStock's exemptions.
DOC_PATHS='docs/ README.md CHANGELOG.md LICENSE.md' sh "$GATE" --selftest
self=$?

# A violation (1) outranks a cannot-check (2), and a broken self-control outranks
# a clean gate run — a gate whose teeth are unproven has not verified anything.
if [ "$rc" -eq 1 ] || [ "$self" -eq 1 ]; then exit 1; fi
if [ "$rc" -ne 0 ] || [ "$self" -ne 0 ]; then exit 2; fi
echo
echo "PASS  R-SOV-1: no broker in the default build or startup path, and the gate still has teeth."
