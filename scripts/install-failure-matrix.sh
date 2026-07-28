#!/usr/bin/env bash
# =============================================================================
# scripts/install-failure-matrix.sh — prove install.sh refuses, every way.
#
# install.sh is the script users pipe into a shell. Its checksum gate is only
# worth having if its refusals actually fire, so this stands up a synthetic
# release origin on loopback whose routes are each broken in exactly one way
# and asserts, for every case:
#
#   1. the exit status               (0 for the happy path, non-zero otherwise)
#   2. that a diagnostic was PRINTED — an installer that aborts with no message
#                                      reads like a crash, not a refusal
#   3. THAT NOTHING WAS INSTALLED    — the assertion that actually matters. An
#                                      installer can print a refusal and still
#                                      have left ./flowstock on disk.
#
# History this is guarding: before commit 3819e20 install.sh downloaded the
# archive, chmod +x'd it and installed it having checked nothing, while the
# release workflow published SHA256SUMS.txt the whole time. The gate exists
# now; this file is what stops it from silently going away again.
#
# Nothing here touches the network or the real working directory: each case
# runs in its own temporary CWD, and the "binary" inside the archives is a
# short text file that is never executed.
#
# Run:  bash scripts/install-failure-matrix.sh
# =============================================================================
set -euo pipefail

SELF_NAME="${BASH_SOURCE[0]##*/}"
SELF_DIR="${BASH_SOURCE[0]%/*}"
[ "$SELF_DIR" = "${BASH_SOURCE[0]}" ] && SELF_DIR="."
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"

[ -f "$INSTALL_SH" ] || { echo "$SELF_NAME: no install.sh at $INSTALL_SH" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || {
  echo "$SELF_NAME: python3 is required (test-only dependency)" >&2; exit 1; }

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  GRN="$(tput setaf 2)"; BLD="$(tput bold)"; RST="$(tput sgr0)"
else
  GRN=''; BLD=''; RST=''
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/flowstock-install-matrix.XXXXXX")"
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf -- "$TMP"
  return 0
}
trap cleanup EXIT

# Derived exactly as install.sh derives them, so the synthetic origin and the
# installer agree on the asset name without either being told.
T_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$T_OS" in linux | darwin) ;; *) echo "$SELF_NAME: unsupported test host $T_OS" >&2; exit 1 ;; esac
case "$(uname -m)" in
  x86_64 | amd64) T_ARCH=amd64 ;;
  aarch64 | arm64) T_ARCH=arm64 ;;
  *) echo "$SELF_NAME: unsupported test host arch $(uname -m)" >&2; exit 1 ;;
esac
TAG="v9.9.9"
ASSET="flowstock_${TAG}_${T_OS}_${T_ARCH}.tar.gz"

cat > "${TMP}/origin.py" <<'PYEOF'
import hashlib, io, sys, tarfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ASSET    = sys.argv[1]
TAG      = sys.argv[2]
OS       = sys.argv[3]
ARCH     = sys.argv[4]
MANIFEST = "SHA256SUMS.txt"

INNER = "flowstock_%s_%s_%s" % (TAG, OS, ARCH)


def tarball(binary_bytes, member="flowstock"):
    """A .tar.gz shaped like the release archive: one dir, the binary inside."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo("%s/%s" % (INNER, member))
        info.size = len(binary_bytes)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(binary_bytes))
    return buf.getvalue()


GOOD_BIN  = b"#!/bin/false\n# synthetic flowstock binary, never executed\n" * 16
OTHER_BIN = b"#!/bin/false\n# SUBSTITUTED bytes, not the published ones\n" * 16

GOOD  = tarball(GOOD_BIN)
OTHER = tarball(OTHER_BIN)
# An archive that unpacks but has no flowstock binary where install.sh expects.
EMPTYARC = tarball(b"not-the-binary\n", member="README.md")

HTML = (b"<!DOCTYPE html><html><head><title>404 Not Found</title></head>"
        b"<body><h1>Not Found</h1></body></html>")


def line(name, data):
    return "%s  %s\n" % (hashlib.sha256(data).hexdigest(), name)


good_sums = line(ASSET, GOOD).encode()

ROUTES = {}
def add(case, path, status, ctype, body, declared=None):
    ROUTES["/%s/download/%s/%s" % (case, TAG, path)] = (status, ctype, body, declared)

add("good",      ASSET,    200, "application/gzip", GOOD)
add("good",      MANIFEST, 200, "text/plain", good_sums)

# The manifest 404 — the case a warn-and-continue installer walks straight past.
add("nosums",    ASSET,    200, "application/gzip", GOOD)

add("emptysums", ASSET,    200, "application/gzip", GOOD)
add("emptysums", MANIFEST, 200, "text/plain", b"")

add("htmlsums",  ASSET,    200, "application/gzip", GOOD)
add("htmlsums",  MANIFEST, 200, "text/plain", HTML)      # lying content-type

add("noentry",   ASSET,    200, "application/gzip", GOOD)
add("noentry",   MANIFEST, 200, "text/plain", line("flowstock_v9.9.9_other_arch.tar.gz", GOOD).encode())

# The .sig trap arranged so a SUBSTRING match falsely passes: the manifest
# vouches only for "<asset>.sig" and the origin serves those exact bytes under
# the asset's own name. Exact field-2 matching must refuse.
add("sigswap",   ASSET,    200, "application/gzip", OTHER)
add("sigswap",   MANIFEST, 200, "text/plain", line(ASSET + ".sig", OTHER).encode())

add("malformed", ASSET,    200, "application/gzip", GOOD)
add("malformed", MANIFEST, 200, "text/plain", ("deadbeef  %s\n" % ASSET).encode())

add("mismatch",  ASSET,    200, "application/gzip", OTHER)
add("mismatch",  MANIFEST, 200, "text/plain", good_sums)

add("truncart",  ASSET,    200, "application/gzip", GOOD[:64], 50000)
add("truncart",  MANIFEST, 200, "text/plain", good_sums)

add("noart",     MANIFEST, 200, "text/plain", good_sums)

# Digest matches, archive is well-formed, but there is no flowstock inside it.
add("noinner",   ASSET,    200, "application/gzip", EMPTYARC)
add("noinner",   MANIFEST, 200, "text/plain", line(ASSET, EMPTYARC).encode())


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def _send(self, status, ctype, body, declared=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body) if declared is None else declared))
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except Exception:
            pass
        if declared is not None:
            self.close_connection = True
    def do_HEAD(self):
        # "no releases yet" must be matched BEFORE the generic /latest rule, or
        # it never fires and its case silently duplicates another.
        if self.path.startswith("/notag/"):
            if self.path.endswith("/releases"):
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(302)
            self.send_header("Location", "/notag/releases")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.endswith("/latest"):
            self.send_response(302)
            self.send_header("Location", self.path[:-len("latest")] + "tag/" + TAG)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_GET(self):
        r = ROUTES.get(self.path)
        if r is None:
            self._send(404, "text/html", HTML)
            return
        self._send(*r)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
print("PORT %d" % srv.server_address[1], flush=True)
threading.Thread(target=srv.serve_forever, daemon=True).start()
try:
    threading.Event().wait()
except KeyboardInterrupt:
    pass
PYEOF

python3 "${TMP}/origin.py" "$ASSET" "$TAG" "$T_OS" "$T_ARCH" > "${TMP}/origin.log" 2>&1 &
SRV_PID=$!

PORT=""
for _ in $(seq 1 100); do
  PORT="$(awk '/^PORT /{print $2; exit}' "${TMP}/origin.log" 2>/dev/null || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || { echo "$SELF_NAME: synthetic origin failed to start:" >&2
                    cat "${TMP}/origin.log" >&2; exit 1; }
BASE="http://127.0.0.1:${PORT}"

# A PATH with everything install.sh needs EXCEPT `gh`, so these cases measure
# the digest gate on its own. The attestation gate gets its own case below.
NOGH="${TMP}/nogh"
mkdir -p "$NOGH"
for _t in sh bash curl tar awk grep sed cut tr head cat wc mktemp mkdir rm mv ln \
          env uname chmod printf seq openssl sha256sum shasum; do
  _p="$(command -v "$_t" 2>/dev/null || true)"
  [ -n "$_p" ] && ln -sf "$_p" "${NOGH}/${_t}"
done
[ -e "${NOGH}/gh" ] && { echo "$SELF_NAME: gh leaked into the no-gh PATH" >&2; exit 1; }

FAILURES=0
N=0

# run_case <label> <want-exit 0|nonzero> <want-installed yes|no> <want-substring> <base-url>
run_case() {
  local label="$1" want="$2" want_installed="$3" want_msg="$4" url="$5"
  N=$((N + 1))
  local cwd="${TMP}/case${N}"
  mkdir -p "$cwd"

  local outf="${cwd}/.out" rc=0
  # install.sh drops ./flowstock into the CWD, so the CWD is the sandbox.
  ( cd "$cwd" && env -i PATH="$NOGH" HOME="$cwd" \
      FLOWSTOCK_INSTALL_BASE_URL="$url" \
      FLOWSTOCK_VERSION="${FS_VERSION_OVERRIDE:-}" \
      FLOWSTOCK_REPO="vul-os/flowstock" \
      sh "$INSTALL_SH" ) > "$outf" 2>&1 || rc=$?

  local installed="no"
  [ -e "${cwd}/flowstock" ] && installed="yes"

  local diag
  diag="$(grep -m1 -E '^install: ' "$outf" | sed 's/^install: //' || true)"
  [ -n "$diag" ] || diag="$(tail -1 "$outf" || true)"
  [ -n "$diag" ] || diag="(NO DIAGNOSTIC PRINTED)"

  local verdict="ok"
  if [ "$want" = "0" ] && [ "$rc" -ne 0 ]; then
    verdict="FAIL(exit ${rc}, want 0)"
  elif [ "$want" != "0" ] && [ "$rc" -eq 0 ]; then
    verdict="FAIL(exit 0, want non-zero)"
  elif [ "$installed" != "$want_installed" ]; then
    verdict="FAIL(installed=${installed}, want ${want_installed})"
  elif [ "$want" != "0" ] && [ "$diag" = "(NO DIAGNOSTIC PRINTED)" ]; then
    verdict="FAIL(silent)"
  elif [ -n "$want_msg" ] && ! grep -qF -- "$want_msg" "$outf"; then
    verdict="FAIL(no '${want_msg}')"
  fi
  [ "$verdict" = "ok" ] || FAILURES=$((FAILURES + 1))

  printf '  %-32s exit %-4s installed=%-4s %-30s %s\n' \
    "$label" "$rc" "$installed" "$verdict" "${diag:0:88}"
}

printf '\n%s%s — synthetic release origin on %s%s\n' "$BLD" "$SELF_NAME" "$BASE" "$RST"
printf '  asset under test: %s   tag: %s\n\n' "$ASSET" "$TAG"
printf '  %-32s %-9s %-14s %-30s %s\n' "CASE" "EXIT" "INSTALLED?" "VERDICT" "DIAGNOSTIC"
printf '  %s\n' "--------------------------------------------------------------------------------------------------------"

run_case "happy path"                0 yes "Verified sha256"                "${BASE}/good"
run_case "SHA256SUMS.txt 404"        1 no  "refusing to install an unverif" "${BASE}/nosums"
run_case "SHA256SUMS.txt empty"      1 no  "is empty (0 bytes)"             "${BASE}/emptysums"
run_case "SHA256SUMS.txt is HTML"    1 no  "HTML page where SHA256SUMS.txt" "${BASE}/htmlsums"
run_case "no entry for this asset"   1 no  "has no entry for"               "${BASE}/noentry"
run_case "the .sig false-pass trap"  1 no  "has no entry for"               "${BASE}/sigswap"
run_case "manifest digest malformed" 1 no  "not a 64-hex SHA-256 digest"    "${BASE}/malformed"
run_case "digest mismatch"           1 no  "CHECKSUM MISMATCH"              "${BASE}/mismatch"
run_case "truncated download"        1 no  "TRUNCATED"                      "${BASE}/truncart"
run_case "archive 404"               1 no  "download failed"                "${BASE}/noart"
run_case "archive lacks the binary"  1 no  "did not contain flowstock"      "${BASE}/noinner"
run_case "plaintext non-loopback"    1 no  "refusing a plaintext"           "http://example.com/releases"

# The attestation gate. On a machine WITH the gh CLI, install.sh additionally
# demands sigstore build provenance, and a synthetic origin has none — so even
# a perfectly matching digest must not install. Reported as SKIP, never as a
# pass, when gh is absent: a case that did not run is not a case that passed.
if command -v gh >/dev/null 2>&1; then
  N=$((N + 1))
  attcwd="${TMP}/att"; mkdir -p "$attcwd"
  rc=0
  ( cd "$attcwd" && env HOME="$attcwd" \
      FLOWSTOCK_INSTALL_BASE_URL="${BASE}/good" \
      FLOWSTOCK_VERSION="$TAG" \
      sh "$INSTALL_SH" ) > "${attcwd}/.out" 2>&1 || rc=$?
  installed="no"; [ -e "${attcwd}/flowstock" ] && installed="yes"
  diag="$(grep -m1 -E '^install: ' "${attcwd}/.out" | sed 's/^install: //' || true)"
  [ -n "$diag" ] || diag="(NO DIAGNOSTIC PRINTED)"
  verdict="ok"
  if [ "$rc" -eq 0 ] || [ "$installed" != "no" ] ||
     ! grep -qF "build provenance attestation FAILED" "${attcwd}/.out"; then
    verdict="FAIL"; FAILURES=$((FAILURES + 1))
  fi
  printf '  %-32s exit %-4s installed=%-4s %-30s %s\n' \
    "gh present, no attestation" "$rc" "$installed" "$verdict" "${diag:0:88}"
else
  printf '  %-32s %s\n' "gh present, no attestation" \
    "SKIP (gh not installed — case did not run, and is not counted as a pass)"
fi

# A machine with no SHA-256 tool must refuse, not install.
N=$((N + 1))
NOHASH="${TMP}/nohash-bin"; NOHASH_CWD="${TMP}/nohash-cwd"
mkdir -p "$NOHASH" "$NOHASH_CWD"
for _t in sh bash curl tar awk grep sed cut tr head cat mktemp mkdir rm mv env uname chmod printf; do
  _p="$(command -v "$_t" 2>/dev/null || true)"
  [ -n "$_p" ] && ln -sf "$_p" "${NOHASH}/${_t}"
done
rc=0
( cd "$NOHASH_CWD" && env -i PATH="$NOHASH" HOME="$NOHASH_CWD" \
    FLOWSTOCK_INSTALL_BASE_URL="${BASE}/good" FLOWSTOCK_VERSION="$TAG" \
    "${BASH:-/bin/sh}" "$INSTALL_SH" ) > "${TMP}/nohash.out" 2>&1 || rc=$?
installed="no"; [ -e "${NOHASH_CWD}/flowstock" ] && installed="yes"
diag="$(grep -m1 -E '^install: ' "${TMP}/nohash.out" | sed 's/^install: //' || true)"
[ -n "$diag" ] || diag="(NO DIAGNOSTIC PRINTED)"
verdict="ok"
if [ "$rc" -eq 0 ] || [ "$installed" != "no" ] ||
   ! grep -qF "no SHA-256 tool found" "${TMP}/nohash.out"; then
  verdict="FAIL"; FAILURES=$((FAILURES + 1))
fi
printf '  %-32s exit %-4s installed=%-4s %-30s %s\n' \
  "no sha256 tool on PATH" "$rc" "$installed" "$verdict" "${diag:0:88}"

printf '\n'
if [ "$FAILURES" -ne 0 ]; then
  printf '%s: %d of %d case(s) did not behave as specified.\n' "$SELF_NAME" "$FAILURES" "$N" >&2
  exit 1
fi
printf '%s%s: %d cases — install.sh installed bytes ONLY on the case where the published digest matched.%s\n' \
  "$GRN$BLD" "$SELF_NAME" "$N" "$RST"
