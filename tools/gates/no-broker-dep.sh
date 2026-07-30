#!/bin/sh
# no-broker-dep.sh — the R-SOV-1 gate: a product's DEFAULT build and startup path
# MUST NOT acquire a hard dependency on a reachability broker (substrate/SOVEREIGNTY.md).
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH
# The suite has learned twice that a copied template propagates where a specification
# does not: substrate/ADOPTION.md records the same ordered-domain decode defect found
# four times in four languages, each invisible to that repo's own tests. "Do not depend
# on the broker" is exactly that shape of rule — everyone agrees with it, and a single
# `use ephor_client::...` in a startup path violates it silently. So the rule ships as
# something a product can LIFT: copy this file into <product>/tools/gates/, set the two
# environment variables at the top of its CI step, and the rule is enforced on every push
# instead of asserted in a README.
#
# WHAT IT CHECKS (three checks; see substrate/SOVEREIGNTY.md §5 for the shape)
#   C-DEP    structural — the DEFAULT-feature dependency closure must not contain the
#            broker. This is the check that cannot be argued with: it reads the resolved
#            graph the toolchain itself produces, not the source text.
#   C-START  textual — the broker MUST NOT be named anywhere outside a declared seam
#            directory. A default endpoint, a hostname constant, or an import in a startup
#            path is a violation even when the dependency is technically optional, because
#            what R-SOV-1 forbids is the DEFAULT PATH reaching for a broker.
#   C-SEAM   fail-closed bookkeeping — if a seam is declared, it must exist and it must be
#            off by default (an undeclared or default-on seam is not a seam, it is the
#            dependency wearing a hat).
#
# LANGUAGE HONESTY
# C-DEP's mechanics are per-ecosystem and there is no universal spelling. Rust and Go are
# implemented here and are the worked examples; node/python are implemented for the common
# case. An ecosystem this script does not recognise EXITS 2 (fail closed) rather than
# reporting a pass it did not earn — see substrate/SOVEREIGNTY.md §5.2 for the table of
# mechanics to add.
#
# CONFIGURATION (environment)
#   BROKER_RE     POSIX ERE, case-insensitive, naming the broker. Default: ephor|vulos-relayd
#   SEAM_PATHS    Space-separated repo-relative path prefixes where naming the broker is
#                 permitted — the optional provider implementation and its tests. Empty by
#                 default, which is the strictest and correct setting for a product that has
#                 no broker integration at all. A product that DOES have a seam also lists
#                 its manifest/lockfile here (Cargo.toml, Cargo.lock, go.sum, package.json):
#                 an `optional = true` dependency legitimately names the broker there, and
#                 C-DEP already covers those files structurally, which is the stronger check.
#   SEAM_FLAG     REQUIRED when SEAM_PATHS is non-empty: the cargo feature / go build tag /
#                 npm optional-dependency name that gates the seam. Must not be on by default.
#   DOC_PATHS     Space-separated path prefixes that are prose, not a build or startup path
#                 (docs/, README.md, CHANGELOG.md). Naming the broker there is allowed:
#                 documenting "you may plug a broker in here" is the point.
#
# EXIT STATUS — and it never exits 0 by doing nothing
#   0  every check ran and passed
#   1  a violation was found (the default path depends on, or names, the broker)
#   2  the gate COULD NOT CHECK: unknown ecosystem, toolchain missing or failing, nothing
#      scanned, a declared seam that does not exist, or an inert self-control. A gate that
#      cannot check must not be indistinguishable from a gate that passed. `go test` throws
#      a passing package's stderr away without -v, so a "loud skip" is invisible in exactly
#      the run that matters; the only skip this script has is a non-zero exit.
#
# ALL THREE CHECKS ALWAYS RUN, and a violation outranks an unverifiable check (exit 1 beats
# exit 2). An earlier revision of this script exited 2 the moment any check could not run,
# which HID a real C-DEP violation behind an unrelated stale seam path — found by running the
# gate against a Go fixture while writing it. "Cannot check" must never suppress "did check,
# and it is broken".
#
# USAGE
#   tools/gates/no-broker-dep.sh [PRODUCT_ROOT]      # gate a product (default: .)
#   tools/gates/no-broker-dep.sh --selftest          # prove the gate still has teeth

set -u

BROKER_RE=${BROKER_RE:-'ephor|vulos-relayd'}
SEAM_PATHS=${SEAM_PATHS:-}
SEAM_FLAG=${SEAM_FLAG:-}
# `site/` is in the default set because every product in this suite mirrors `docs/` into
# `site/docs/` for its published mini-site. Omitting it made the gate flag a heading like
# "## Exposing via your own Ephor (optional)" — prose describing the PERMITTED optional path —
# as an R-SOV-1 violation. A doc that marks the broker optional is the contract being followed,
# not broken; what R-SOV-1a forbids is prominence in getting-started, which a grep cannot judge
# and a human must.
DOC_PATHS=${DOC_PATHS:-'docs/ site/ README.md CHANGELOG.md LICENSE.md'}

# Split so this script's own source does not contain the literal marker it searches for —
# otherwise the gate would exempt itself by accident rather than by the explicit rule above.
_ALLOW_SUFFIX=':allow-file'

# Build directories and vendored trees are excluded from the TEXT scan only. They are not
# excluded from C-DEP, which reads the resolved graph and is where a vendored broker would
# show up anyway.
# Matched by NAME, at any depth — not by top-level path. A `-path ./node_modules` test only
# ever matches a prune dir sitting in the root, which is not where they mostly live: gitstate
# has web/node_modules, apps/desktop/src-tauri/target and crates/gitstate-sync/target, and a
# path-matched prune walked all three. That cost 28,731 scanned files and ~16 minutes for one
# invocation, and it was a correctness bug before it was a performance one — a vendored package
# or a build fingerprint containing the broker's name would have produced a spurious FAIL
# against a product that does not depend on it.
PRUNE_NAMES='.git target node_modules vendor dist build .venv __pycache__'

# Emits the `find` prune expression, name-matched so it applies at ANY depth.
prune_expr() {
	_e=''
	for _n in $PRUNE_NAMES; do _e="$_e -name $_n -prune -o"; done
	printf '%s' "$_e"
}

say() { printf '%s\n' "$*"; }
fail() { printf 'VIOLATION  %s\n' "$*"; violations=$((violations + 1)); }
# `cannot` records an unverifiable check and RETURNS — the remaining checks still run, and the
# final exit code is decided in one place (run_gate) so a violation is never masked.
cannot() { printf 'CANNOT CHECK  %s\n' "$*"; unverifiable=$((unverifiable + 1)); }
# `die` is reserved for a failure that makes the whole run meaningless (a root that does not
# exist, a broken selftest harness).
die() { printf 'CANNOT CHECK  %s\n' "$*" >&2; exit 2; }

# ── path classification ───────────────────────────────────────────────────────────────
# A file is exempt from the TEXT scan if it sits under a declared seam or a declared doc
# path. Prefix match on the repo-relative path, so "src/reach/ephor/" covers the directory.
is_exempt() {
	_p=${1#./}
	# This gate quotes the broker in its own explanatory comments, so it matches itself once
	# copied into a product. A gate that fails every adopter on its own documentation is worse
	# than no gate: the first fix anyone reaches for is deleting the gate.
	case $1 in */no-broker-dep.sh | no-broker-dep.sh) return 0 ;; esac
	for _pre in $SEAM_PATHS $DOC_PATHS; do
		case $_p in "${_pre%/}"/* | "$_pre") return 0 ;; esac
	done
	# A file may name the broker in order to ASSERT ITS ABSENCE. gitstate's CI carries a step
	# called "Assert no Ephor dependency anywhere" whose grep pattern necessarily spells the
	# broker's name — and this gate flagged it, which is the gate failing a repo for enforcing
	# the very rule the gate exists to enforce. The available workarounds were both bad:
	# exempting all of .github/ would blind the gate to a workflow that genuinely deploys a
	# broker, and deleting the assertion would remove a real check to satisfy a false one.
	#
	# So a file may opt out explicitly, and the cost of doing so is that it must say why in the
	# same breath. Every exemption is PRINTED with its reason on every run (see scan_file), so
	# the escape hatch cannot be used quietly — an unexplained one is visible in the output and
	# in review. Grep-hostile spelling of the marker keeps this very comment from matching it.
	if grep -Iq -e "no-broker-dep""$_ALLOW_SUFFIX" "$1" 2>/dev/null; then
		_reason=$(grep -Ihm1 -e "no-broker-dep""$_ALLOW_SUFFIX" "$1" 2>/dev/null |
			sed "s/.*no-broker-dep$_ALLOW_SUFFIX[: ]*//" | cut -c1-100)
		[ -n "$_reason" ] || _reason='(NO REASON GIVEN — this exemption is not accountable)'
		printf '  EXEMPT-FILE  %s — %s\n' "$_p" "$_reason"
		_file_exemptions=$((_file_exemptions + 1))
		return 0
	fi
	return 1
}

# ── C-DEP: the default-feature dependency closure ─────────────────────────────────────
# Each ecosystem answers ONE question: "with default features/tags, what does the build
# actually pull in?" The command must be the toolchain's own resolver — a manifest grep
# cannot see a transitive dependency, which is precisely how a broker arrives.
#
# C-DEP runs once PER MANIFEST, not once per repo. The earlier if/elif chain checked whichever
# ecosystem happened to own the root manifest and silently ignored every other one — and said
# nothing, so the output read as a clean pass. pango is the case that exposed it: package.json
# at the root, go.mod in backend/, and the entire Go closure — the actual product — was never
# read. A gate that quietly declines to look is worse than one that fails, because the operator
# has no way to tell the difference.
check_dep_closure() {
	_root=$(pwd)
	# shellcheck disable=SC2086 # word splitting of the prune list is intended
	_manifests=$(find . $(prune_expr) -type f \
		\( -name Cargo.toml -o -name go.mod -o -name package.json \
		-o -name pyproject.toml -o -name requirements.txt \) -print 2>/dev/null |
		sed 's|/[^/]*$||' | sort -u)

	if [ -z "$_manifests" ]; then
		cannot "C-DEP  no recognised manifest (Cargo.toml / go.mod / package.json / pyproject.toml) anywhere under $_root — add this ecosystem's mechanics per substrate/SOVEREIGNTY.md §5.2 instead of skipping"
		return 0
	fi

	# A Cargo workspace member resolves through its workspace root, so checking it separately
	# re-reads the same graph. Skip members; the root already covers them.
	_rust_ws=no
	if [ -f Cargo.toml ] && grep -q '^\[workspace\]' Cargo.toml 2>/dev/null; then _rust_ws=yes; fi

	_oldifs=$IFS
	IFS='
'
	for _d in $_manifests; do
		IFS=$_oldifs
		if [ "$_rust_ws" = yes ] && [ "$_d" != "." ] && [ -f "$_d/Cargo.toml" ] &&
			! grep -q '^\[workspace\]' "$_d/Cargo.toml" 2>/dev/null; then
			IFS='
'
			continue
		fi
		# NOT a subshell: the violation counter must survive back into run_gate.
		cd "$_d" || {
			cannot "C-DEP  cannot enter $_d — its dependency closure was NOT read"
			IFS='
'
			continue
		}
		check_dep_closure_one "$_d"
		cd "$_root" || die "lost the repo root while walking manifests"
		IFS='
'
	done
	IFS=$_oldifs
}

# Reads ONE manifest directory's default-feature closure. Runs in a subshell, so it reports
# through the shared counters by printing — see run_gate, which re-counts from output.
check_dep_closure_one() {
	_where=$1
	ecosystem=none
	closure=''

	if [ -f Cargo.toml ]; then
		ecosystem=rust
		if ! command -v cargo >/dev/null 2>&1; then
			cannot "C-DEP  Cargo.toml present but no cargo on PATH — the dependency graph was NOT read"
			return 0
		fi
		# `cargo tree` resolves with DEFAULT features, which is exactly R-SOV-1's subject.
		# -e normal drops build/dev edges: a dev-dependency on a broker client is a test
		# fixture, not a default runtime path.
		closure=$(cargo tree -e normal --prefix none --offline 2>/dev/null) ||
			closure=$(cargo tree -e normal --prefix none 2>/dev/null) || {
			cannot "C-DEP  cargo tree failed — the dependency graph was NOT read (do not read this as a pass)"
			return 0
		}
	elif [ -f go.mod ]; then
		ecosystem=go
		if ! command -v go >/dev/null 2>&1; then
			cannot "C-DEP  go.mod present but no go on PATH — the import closure was NOT read"
			return 0
		fi
		# `go list -deps ./...` is the import closure for the DEFAULT build tags. A seam
		# behind `//go:build broker` is absent here unless it is on by default, which is
		# the property R-SOV-1 wants and the reason this is the right command.
		closure=$(go list -deps ./... 2>/dev/null) || {
			cannot "C-DEP  go list -deps failed — the import closure was NOT read"
			return 0
		}
	elif [ -f package.json ]; then
		ecosystem=node
		if ! command -v npm >/dev/null 2>&1; then
			cannot "C-DEP  package.json present but no npm on PATH — the dependency graph was NOT read"
			return 0
		fi
		closure=$(npm ls --omit=dev --all --parseable 2>/dev/null) || {
			cannot "C-DEP  npm ls failed — the dependency graph was NOT read"
			return 0
		}
	elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
		ecosystem=python
		# No resolver is assumed present, so this is the declared set, not the closure —
		# stated as reduced assurance rather than quietly passed off as equivalent.
		closure=$(cat pyproject.toml requirements.txt 2>/dev/null)
		say "  note: python C-DEP reads DECLARED dependencies, not a resolved closure —"
		say "        a transitive broker dependency is NOT visible to this check."
	else
		cannot "C-DEP  no recognised manifest (Cargo.toml / go.mod / package.json / pyproject.toml) in $(pwd) — add this ecosystem's mechanics per substrate/SOVEREIGNTY.md §5.2 instead of skipping"
		return 0
	fi

	if [ -z "$closure" ]; then
		cannot "C-DEP  $ecosystem dependency closure came back EMPTY — the command ran but produced nothing to check"
		return 0
	fi

	hits=$(printf '%s\n' "$closure" | grep -Ei -- "$BROKER_RE" || true)
	n=$(printf '%s' "$closure" | grep -c '' || true)
	if [ -n "$hits" ]; then
		printf '%s\n' "$hits" | while IFS= read -r h; do
			[ -n "$h" ] && fail "C-DEP  default-feature dependency closure contains the broker: $h"
		done
		# The subshell above cannot increment the parent's counter; record the fact here.
		violations=$((violations + 1))
	fi
	say "  C-DEP    $ecosystem ($_where): examined $n entries of the default-feature dependency closure"
}

# ── C-START: the broker may not be named outside a declared seam ───────────────────────
check_startup_text() {
	# shellcheck disable=SC2086 # word splitting of the prune list is intended
	files=$(find . $(prune_expr) -type f -print 2>/dev/null)
	if [ -z "$files" ]; then
		cannot "C-START  scanned NOTHING — the file walk found no files under $(pwd)"
		return 0
	fi

	scanned=0
	exempted=0
	# Split on NEWLINE only, so a path containing a space is one path and not two — a
	# gate that silently stops scanning "src/my app/" is a gate with a hole in it.
	_oldifs=$IFS
	IFS='
'
	for f in $files; do
		IFS=$_oldifs
		if is_exempt "$f"; then
			exempted=$((exempted + 1))
			IFS='
'
			continue
		fi
		scanned=$((scanned + 1))
		# -I skips binaries; a match in a source file, a default config, a Dockerfile or a
		# systemd unit is a violation, because all four are the startup path.
		hit=$(grep -Iin -Ee "$BROKER_RE" "$f" 2>/dev/null | head -3 || true)
		if [ -n "$hit" ]; then
			printf '%s\n' "$hit" | while IFS= read -r line; do
				[ -n "$line" ] && fail "C-START  ${f#./}:$line"
			done
			violations=$((violations + 1))
		fi
		IFS='
'
	done
	IFS=$_oldifs
	if [ "$scanned" -eq 0 ]; then
		cannot "C-START  scanned 0 non-exempt files — every path is exempt, so this check verified nothing"
		return 0
	fi
	say "  C-START  scanned $scanned files ($exempted exempt under SEAM_PATHS/DOC_PATHS)"
}

# ── C-SEAM: a declared seam must exist and must be off by default ─────────────────────
check_seam() {
	if [ -z "$SEAM_PATHS" ]; then
		say "  C-SEAM   no seam declared — the strictest posture: the broker is named nowhere"
		return 0
	fi
	if [ -z "$SEAM_FLAG" ]; then
		cannot "C-SEAM   SEAM_PATHS is set but SEAM_FLAG is not: an ungated seam is not a seam. Name the cargo feature / build tag / optional dependency that turns it on."
		return 0
	fi
	_stale=0
	for p in $SEAM_PATHS; do
		if [ ! -e "$p" ]; then
			cannot "C-SEAM   declared seam path '$p' does not exist — a stale allowlist silently widens the exemption"
			_stale=1
		fi
	done
	[ "$_stale" = 0 ] || return 0
	# The seam must not be in the default feature set. Checked against the manifest the
	# ecosystem uses; anything else is unverifiable here and says so.
	if [ -f Cargo.toml ]; then
		defaults=$(awk '/^\[features\]/{f=1} f&&/^default *=/{print;exit}' Cargo.toml)
		case $defaults in
		*"$SEAM_FLAG"*) fail "C-SEAM   feature '$SEAM_FLAG' gates the broker seam but is ON by default: $defaults" ;;
		*) say "  C-SEAM   seam '$SEAM_FLAG' is not in Cargo.toml's default feature set" ;;
		esac
	elif [ -f go.mod ]; then
		# A Go seam is a build tag; absence from the default `go list -deps` closure was
		# already proven by C-DEP, so the remaining check is that the tag is real.
		# shellcheck disable=SC2086 # SEAM_PATHS is a space-separated LIST of paths by design
		if grep -rIlE "^//go:build( .*)?\\b$SEAM_FLAG\\b" $SEAM_PATHS >/dev/null 2>&1; then
			say "  C-SEAM   seam files carry the '//go:build $SEAM_FLAG' constraint"
		else
			fail "C-SEAM   no file under '$SEAM_PATHS' carries a '//go:build $SEAM_FLAG' constraint — the seam is compiled unconditionally"
		fi
	else
		cannot "C-SEAM   cannot verify that '$SEAM_FLAG' is off by default in this ecosystem — implement it rather than assume it"
	fi
}

run_gate() {
	root=${1:-.}
	cd "$root" 2>/dev/null || die "cannot enter '$root'"
	violations=0
	unverifiable=0
	_file_exemptions=0
	say "R-SOV-1 gate (no-broker-dep) — $(pwd)"
	say "  broker pattern: $BROKER_RE"
	# All three always run: a check that cannot run must not suppress a check that found
	# something. The exit code is decided once, here.
	check_dep_closure
	check_startup_text
	check_seam
	say ""
	if [ "$violations" -gt 0 ]; then
		say "FAIL  $violations violation(s) found: the default build or startup path depends"
		say "      on, or names, the broker. R-SOV-1 (substrate/SOVEREIGNTY.md §3.1) requires the"
		say "      default path to work with no broker present; a broker may only sit behind a"
		say "      declared, default-off seam whose removal costs reachability from behind NAT and"
		say "      nothing else."
		[ "$unverifiable" -gt 0 ] &&
			say "      ($unverifiable further check(s) could not run — fix those too; they verified nothing.)"
		return 1
	fi
	if [ "$unverifiable" -gt 0 ]; then
		say "NOT VERIFIED  $unverifiable of 3 checks could not run, so this is NOT a pass. Exit 2 is"
		say "      deliberately distinct from exit 0: the checks that did run found nothing, and the"
		say "      ones above found out nothing at all."
		return 2
	fi
	say "PASS  all 3 checks ran: default build and startup path carry no hard broker dependency."
	return 0
}

# ── selftest: positive and negative controls, hermetic ────────────────────────────────
# A check that cannot fail reports success it did not earn (the lesson tools/lint.py's C12
# and C15 were written for, three inert revisions each). So the gate proves, on demand, that
# it still trips on PLANTED violations, still passes a clean tree, and still refuses to call
# an unverifiable configuration a pass.
#
# Controls are per-ecosystem and run for every toolchain PRESENT. At least one must run — a
# selftest with nothing to run exits 2 — and any ecosystem NOT exercised is named out loud as
# NOT VERIFIED, because "the Rust half is fine" is not evidence about the Go mechanics.
selftest() {
	tmp=$(mktemp -d) || die "mktemp failed"
	trap 'rm -rf "$tmp"' EXIT
	self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
	rc=0
	ran=0
	controls=0
	unexercised=''

	expect() { # $1 = fixture dir, $2 = expected exit, $3 = what it proves, $4.. = env
		f=$1 want=$2 what=$3
		shift 3
		controls=$((controls + 1))
		out=$(env "$@" sh "$self" "$tmp/$f" 2>&1)
		got=$?
		if [ "$got" != "$want" ]; then
			say "SELFTEST FAIL  '$f': expected exit $want, got $got — $what"
			printf '%s\n' "$out" | sed 's/^/    | /'
			rc=1
		else
			say "SELFTEST ok    '$f' -> exit $got ($what)"
		fi
	}

	# ---- Rust controls -----------------------------------------------------------------
	if command -v cargo >/dev/null 2>&1; then
		ran=$((ran + 1))
		# a vendored "broker client" the fixtures can depend on with no network
		mkdir -p "$tmp/ephor-client/src"
		cat >"$tmp/ephor-client/Cargo.toml" <<-'EOF'
			[package]
			name = "ephor-client"
			version = "0.0.0"
			edition = "2021"
		EOF
		echo 'pub fn dial() {}' >"$tmp/ephor-client/src/lib.rs"

		mkrust() { # $1 = fixture name
			mkdir -p "$tmp/$1/src"
			cat >"$tmp/$1/Cargo.toml" <<-EOF
				[package]
				name = "$1"
				version = "0.0.0"
				edition = "2021"

				[dependencies]
			EOF
			echo 'fn main() {}' >"$tmp/$1/src/main.rs"
		}

		# NEGATIVE control — a clean product.
		mkrust rs_clean
		printf 'const DEFAULT_PEER: Option<&str> = None;\nfn main() {}\n' >"$tmp/rs_clean/src/main.rs"

		# POSITIVE A — a hard dependency in the default feature set.
		mkrust rs_dep
		printf '\nephor-client = { path = "../ephor-client" }\n' >>"$tmp/rs_dep/Cargo.toml"
		printf 'fn main() { ephor_client::dial(); }\n' >"$tmp/rs_dep/src/main.rs"

		# POSITIVE B — no dependency at all, but a default broker endpoint in the startup
		# path. This is the variant a dependency-graph check alone cannot see.
		mkrust rs_default
		printf 'const BROKER: &str = "https://rendezvous.ephor.example";\nfn main() { let _ = BROKER; }\n' \
			>"$tmp/rs_default/src/main.rs"

		# POSITIVE C — a seam that exists but is ON by default. With the manifest declared
		# as part of the seam, C-DEP and C-START are both clean, so this control isolates
		# C-SEAM.
		mkrust rs_seam_on
		mkdir -p "$tmp/rs_seam_on/src/reach"
		printf 'pub fn dial_ephor() {}\n' >"$tmp/rs_seam_on/src/reach/broker.rs"
		printf '\n[features]\ndefault = ["ephor-reach"]\nephor-reach = []\n' >>"$tmp/rs_seam_on/Cargo.toml"

		# NEGATIVE control — the same seam, off by default. Must PASS: an optional provider
		# behind a default-off flag is exactly what R-SOV-1 permits.
		mkrust rs_seam_off
		mkdir -p "$tmp/rs_seam_off/src/reach"
		printf 'pub fn dial_ephor() {}\n' >"$tmp/rs_seam_off/src/reach/broker.rs"
		printf '\n[features]\ndefault = []\nephor-reach = []\n' >>"$tmp/rs_seam_off/Cargo.toml"

		E='BROKER_RE=ephor|vulos-relayd'
		expect rs_clean 0 "a clean tree passes with all 3 checks run" "$E" SEAM_PATHS= SEAM_FLAG=
		expect rs_dep 1 "C-DEP catches a default-feature dependency" "$E" SEAM_PATHS= SEAM_FLAG=
		expect rs_default 1 "C-START catches a default broker endpoint with no dependency" "$E" SEAM_PATHS= SEAM_FLAG=
		expect rs_seam_on 1 "C-SEAM catches a seam that is ON by default" "$E" \
			SEAM_PATHS="src/reach Cargo.toml" SEAM_FLAG="ephor-reach"
		expect rs_seam_off 0 "a declared, default-off seam is permitted" "$E" \
			SEAM_PATHS="src/reach Cargo.toml" SEAM_FLAG="ephor-reach"
		# A seam declared without naming the flag that gates it verifies nothing: exit 2.
		expect rs_seam_off 2 "an ungated seam is UNVERIFIABLE, never a pass" "$E" \
			SEAM_PATHS="src/reach Cargo.toml" SEAM_FLAG=
		# A stale seam path is an exemption nobody is reading: exit 2.
		expect rs_clean 2 "a stale seam path is UNVERIFIABLE, never a pass" "$E" \
			SEAM_PATHS="src/gone" SEAM_FLAG="ephor-reach"
		# REGRESSION control. An earlier revision exited 2 the moment any check could not
		# run, masking a real C-DEP violation behind an unrelated stale seam path. A
		# violation must outrank an unverifiable check.
		expect rs_dep 1 "a violation outranks an unverifiable check (regression)" "$E" \
			SEAM_PATHS="src/gone" SEAM_FLAG="ephor-reach"
	else
		unexercised="$unexercised rust(no-cargo)"
	fi

	# ---- Go controls -------------------------------------------------------------------
	# Go's mechanics are genuinely different: the seam is a BUILD TAG, not a feature, and
	# `go list -deps ./...` is what proves a tagged file is outside the default build. The
	# claim that this works is worth a control of its own.
	if command -v go >/dev/null 2>&1; then
		ran=$((ran + 1))
		mkdir -p "$tmp/ephorclient"
		cat >"$tmp/ephorclient/go.mod" <<-'EOF'
			module example.test/ephorclient

			go 1.21
		EOF
		printf 'package ephorclient\n\nfunc Dial() string { return "broker" }\n' \
			>"$tmp/ephorclient/dial.go"

		mkgo() { # $1 = fixture name; creates a module whose reach/ package has two builds
			mkdir -p "$tmp/$1/reach"
			cat >"$tmp/$1/go.mod" <<-EOF
				module example.test/$1

				go 1.21

				require example.test/ephorclient v0.0.0

				replace example.test/ephorclient => ../ephorclient
			EOF
			printf 'package main\n\nimport "example.test/%s/reach"\n\nfunc main() { println(reach.Provider()) }\n' \
				"$1" >"$tmp/$1/main.go"
			printf '//go:build broker\n\npackage reach\n\nimport "example.test/ephorclient"\n\nfunc Provider() string { return ephorclient.Dial() }\n' \
				>"$tmp/$1/reach/broker.go"
		}

		# NEGATIVE control — the seam is behind `//go:build broker`, so the default build
		# never imports it.
		mkgo go_seam_off
		printf '//go:build !broker\n\npackage reach\n\nfunc Provider() string { return "direct" }\n' \
			>"$tmp/go_seam_off/reach/default.go"

		# POSITIVE control — the broker is imported by the DEFAULT build file.
		mkgo go_planted
		printf '//go:build !broker\n\npackage reach\n\nimport "example.test/ephorclient"\n\nfunc Provider() string { return ephorclient.Dial() }\n' \
			>"$tmp/go_planted/reach/default.go"

		E='BROKER_RE=ephor|vulos-relayd'
		expect go_seam_off 0 "go: a build-tag seam is outside the default import closure" "$E" \
			SEAM_PATHS="reach go.mod" SEAM_FLAG="broker"
		expect go_planted 1 "go: C-DEP catches a broker imported by the default build" "$E" \
			SEAM_PATHS="reach go.mod" SEAM_FLAG="broker"
	else
		unexercised="$unexercised go(no-go-toolchain)"
	fi

	# ---- Structural controls: three defects found by running this gate across the suite ----
	# Each of these shipped as a clean-looking pass while the gate was wrong. They are controls
	# now so they cannot come back silently.
	if command -v go >/dev/null 2>&1; then
		ran=$((ran + 1))

		# DEFECT 1 — nested prune. A prune list matched by top-level PATH walks every nested
		# node_modules/ and target/, so a vendored file naming the broker fails a product that
		# does not depend on it. The planted file is deep enough that only a name-match prunes it.
		mkdir -p "$tmp/prune_nested/web/node_modules/pkg" "$tmp/prune_nested/crates/x/target/debug"
		printf 'module example.test/prune_nested\n\ngo 1.21\n' >"$tmp/prune_nested/go.mod"
		printf 'package main\n\nfunc main() {}\n' >"$tmp/prune_nested/main.go"
		printf 'const url = "https://ephor.example";\n' \
			>"$tmp/prune_nested/web/node_modules/pkg/index.js"
		printf 'ephor build fingerprint\n' >"$tmp/prune_nested/crates/x/target/debug/build.log"
		expect prune_nested 0 "nested node_modules/ and target/ are pruned at any depth, not just the root" \
			'BROKER_RE=ephor|vulos-relayd'

		# DEFECT 2 — monorepo blind spot. package.json at the root, go.mod in backend/. The
		# if/elif chain read the npm closure and never looked at Go, reporting a clean pass over
		# an unexamined product. The planted broker import is reachable ONLY through the Go side.
		mkdir -p "$tmp/multi_mod/backend"
		printf '{"name":"multi","version":"0.0.0","private":true}\n' >"$tmp/multi_mod/package.json"
		cat >"$tmp/multi_mod/backend/go.mod" <<-'EOF'
			module example.test/multi/backend

			go 1.21

			require example.test/ephorclient v0.0.0

			replace example.test/ephorclient => ../../ephorclient
		EOF
		printf 'package main\n\nimport "example.test/ephorclient"\n\nfunc main() { println(ephorclient.Dial()) }\n' \
			>"$tmp/multi_mod/backend/main.go"
		expect multi_mod 1 "a second manifest below the root is CHECKED, not silently skipped" \
			'BROKER_RE=ephor|vulos-relayd'

		# DEFECT 3 — the gate flagged a CI step whose purpose was asserting the broker's absence.
		# The marker exempts that file and prints the stated reason; without it this same tree
		# fails, which is what makes the control meaningful rather than decorative.
		mkdir -p "$tmp/assert_absence/.github/workflows"
		printf 'module example.test/assert_absence\n\ngo 1.21\n' >"$tmp/assert_absence/go.mod"
		printf 'package main\n\nfunc main() {}\n' >"$tmp/assert_absence/main.go"
		printf 'name: ci\njobs:\n  x:\n    steps:\n      - run: grep -rE "ephor" . && exit 1\n' \
			>"$tmp/assert_absence/.github/workflows/ci.yml"
		expect assert_absence 1 "an unmarked file naming the broker still FAILS (the marker is doing the work)" \
			'BROKER_RE=ephor|vulos-relayd'
		printf '# no-broker-dep%s asserts this broker is absent; the grep must spell its name\n' \
			"$_ALLOW_SUFFIX" >>"$tmp/assert_absence/.github/workflows/ci.yml"
		expect assert_absence 0 "a file may name the broker to assert its ABSENCE, with a printed reason" \
			'BROKER_RE=ephor|vulos-relayd'
	else
		unexercised="$unexercised structural(no-go-toolchain)"
	fi

	say ""
	[ -n "$unexercised" ] &&
		say "NOT VERIFIED   ecosystems not exercised in this run:$unexercised — their mechanics are unproven here."
	if [ "$ran" = 0 ]; then
		say "SELFTEST CANNOT RUN  no toolchain present for any control fixture. This is exit 2, not a"
		say "                     pass: nothing was verified."
		return 2
	fi
	if [ "$rc" = 0 ]; then
		say "SELFTEST PASS  $controls controls across $ran ecosystem(s): clean trees and default-off seams"
		say "               pass, every planted violation fails, unverifiable configurations exit 2, and a"
		say "               violation outranks an unverifiable check. The gate is not inert."
	else
		say "SELFTEST FAIL  a control did not behave as specified — do NOT trust a clean run of this gate"
		say "               until it does."
	fi
	return $rc
}

case ${1:-} in
--selftest) selftest ;;
-h | --help) sed -n '2,66p' "$0" ;;
*) run_gate "${1:-.}" ;;
esac
