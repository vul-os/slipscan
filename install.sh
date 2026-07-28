#!/usr/bin/env sh
# FlowStock installer — downloads a release archive for this platform and
# verifies it against the release's own SHA256SUMS.txt before unpacking it.
#
# The verification is the point. A checksum file that nobody checks is
# decoration: it documents what the bytes should have been while the installer
# runs whatever bytes arrived. So every failure here is fatal — a missing
# SHA256SUMS.txt, a sums file with no line for this archive, a digest that does
# not match, or no SHA-256 tool on the machine to compute one. There is no path
# through this script that installs an unverified binary.
#
# Overrides, for testing and for mirrors:
#   FLOWSTOCK_REPO             owner/name          (default vul-os/flowstock)
#   FLOWSTOCK_VERSION          tag, e.g. v1.0.0    (default: resolve "latest")
#   FLOWSTOCK_INSTALL_BASE_URL releases base URL   (default: the GitHub repo's)
set -eu

REPO="${FLOWSTOCK_REPO:-vul-os/flowstock}"
BASE_URL="${FLOWSTOCK_INSTALL_BASE_URL:-https://github.com/${REPO}/releases}"

die() {
  echo "install: $*" >&2
  exit 1
}

# A plaintext origin delivers the archive AND the checksum file over the same
# unauthenticated channel, so comparing one against the other proves only that
# a single attacker was self-consistent. FLOWSTOCK_INSTALL_BASE_URL exists for
# mirrors, and a mirror over http is not a mirror worth verifying against.
# Loopback stays allowed so the failure matrix can stand up a synthetic origin.
case "$BASE_URL" in
  https://*) ;;
  http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) ;;
  *) die "refusing a plaintext, non-loopback release origin: ${BASE_URL} — the archive and its checksums would both arrive unauthenticated. Use an https:// URL." ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

# sha256 of stdin, on whichever of the three usual tools this machine has. There
# is deliberately no fourth branch that skips the check: a machine that cannot
# hash cannot verify, and an unverified download is the thing this script exists
# to prevent.
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | sed 's/^.*= *//'
  else
    return 1
  fi
}

sha256_stdin </dev/null >/dev/null 2>&1 ||
  die "no SHA-256 tool found (need sha256sum, shasum, or openssl) — refusing to install an unverified binary"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux | darwin) ;;
  *) die "unsupported OS: $OS" ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported arch: $ARCH" ;;
esac

# The archive name embeds the tag (see .github/workflows/release.yml), so the
# tag has to be known before anything can be downloaded. GitHub's /latest URL
# redirects to /tag/<tag>; ask curl where it landed rather than parse the API.
TAG="${FLOWSTOCK_VERSION:-}"
if [ -z "$TAG" ]; then
  resolved=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${BASE_URL}/latest") ||
    die "could not resolve the latest release from ${BASE_URL}/latest"
  TAG="${resolved##*/}"
  [ -n "$TAG" ] || die "could not read a tag out of ${resolved}"
fi

ASSET="flowstock_${TAG}_${OS}_${ARCH}.tar.gz"
DOWNLOAD="${BASE_URL}/download/${TAG}"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/flowstock-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "Downloading ${DOWNLOAD}/${ASSET} ..."
rc=0
curl -fSL "${DOWNLOAD}/${ASSET}" -o "${TMP}/${ASSET}" || rc=$?
# curl exit 18 is a short read: the origin declared a Content-Length and then
# hung up. Reported separately from a digest mismatch on purpose — a truncated
# transfer is something to retry, not evidence of tampering.
[ "$rc" -eq 18 ] &&
  die "the download of ${ASSET} was TRUNCATED (curl exit 18) — the origin closed the connection early. Nothing was installed; retry."
[ "$rc" -eq 0 ] ||
  die "download failed (curl exit ${rc}): ${DOWNLOAD}/${ASSET}"

echo "Downloading ${DOWNLOAD}/SHA256SUMS.txt ..."
curl -fsSL "${DOWNLOAD}/SHA256SUMS.txt" -o "${TMP}/SHA256SUMS.txt" ||
  die "no SHA256SUMS.txt in release ${TAG} — refusing to install an unverified binary"

# An empty sums file and an HTML error page both reach the awk lookup below and
# both come back "no entry", which is fail-closed but sends the reader hunting
# through a manifest for a line that was never the problem. Name what actually
# happened instead.
[ -s "${TMP}/SHA256SUMS.txt" ] ||
  die "SHA256SUMS.txt is empty (0 bytes) — it vouches for nothing while looking like a manifest. Refusing to install an unverified binary"

if head -c 512 "${TMP}/SHA256SUMS.txt" | LC_ALL=C grep -qiE '<(!doctype|html|head|body)\b'; then
  die "the origin returned an HTML page where SHA256SUMS.txt was expected (${DOWNLOAD}/SHA256SUMS.txt) — that is a captive portal, a login wall, or a CDN error page answering 200, not a manifest. Nothing was installed"
fi

# The sums file covers every attached file; pull out the one line for this
# archive. sha256sum writes "<digest>  <name>" and marks binary mode with a
# leading '*' on the name, so tolerate both spellings and nothing else. The
# comparison is a string compare on field 2 — a substring grep would treat every
# '.' in "flowstock_v1.2.3_linux_amd64.tar.gz" as a wildcard and could return
# the digest of a neighbouring asset.
expected=$(awk -v want="$ASSET" '{ name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }' \
  "${TMP}/SHA256SUMS.txt")
[ -n "$expected" ] ||
  die "SHA256SUMS.txt has no entry for ${ASSET} — refusing to install an asset the release does not vouch for. Names are matched exactly: ${ASSET} does not match ${ASSET}.sig"

# A truncated or foreign-format manifest can yield a field 2 that matches while
# field 1 is not a digest at all. Comparing against it would produce a MISMATCH
# diagnostic, sending the reader looking for tampering that did not happen.
if ! printf '%s' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  die "the entry for ${ASSET} in SHA256SUMS.txt is not a 64-hex SHA-256 digest (got '${expected}') — the manifest is malformed or truncated. Nothing was installed"
fi

actual=$(sha256_stdin <"${TMP}/${ASSET}")
[ -n "$actual" ] ||
  die "could not compute a SHA-256 digest for ${ASSET} — refusing to report an install as verified without one"

if [ "$actual" != "$expected" ]; then
  rm -f "${TMP}/${ASSET}"
  echo "install: CHECKSUM MISMATCH for ${ASSET}" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  die "the download does not match the release's published digest — not installing. The archive has been deleted; either the transfer corrupted it or it was substituted"
fi
echo "Verified sha256 ${actual}"

# Optional, and honest about being optional. If the GitHub CLI is present, also
# check the sigstore build provenance attached at release time — the thing that
# makes SHA256SUMS.txt itself trustworthy rather than merely self-consistent
# with the archive beside it. Never load-bearing: a machine without `gh` still
# gets the digest check, and the final line says which checks actually ran, so
# a pass never implies more than it checked.
attested="not checked (install the gh CLI to check build provenance)"
if command -v gh >/dev/null 2>&1; then
  if gh attestation verify "${TMP}/${ASSET}" --repo "$REPO" >/dev/null 2>&1; then
    attested="VERIFIED"
    echo "Verified build provenance attestation"
  else
    rm -f "${TMP}/${ASSET}"
    die "build provenance attestation FAILED for ${ASSET} (repo ${REPO}) — the digest matched SHA256SUMS.txt, but no valid sigstore attestation ties these bytes to a workflow run in that repository, so the manifest itself is unvouched-for. Run 'gh attestation verify <file> --repo ${REPO}' for detail. Nothing was installed"
  fi
fi

# The archive holds one directory, flowstock_<tag>_<os>_<arch>/, with the binary
# and the docs that ship beside it.
tar -xzf "${TMP}/${ASSET}" -C "$TMP" || die "could not unpack ${ASSET}"
unpacked="${TMP}/flowstock_${TAG}_${OS}_${ARCH}/flowstock"
[ -f "$unpacked" ] || die "the archive did not contain flowstock where expected"

chmod +x "$unpacked"
mv "$unpacked" ./flowstock
echo "Installed ./flowstock ${TAG} — run it with:  ./flowstock"
echo "  sha256:           ${actual}"
echo "  build provenance: ${attested}"
