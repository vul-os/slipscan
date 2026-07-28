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
curl -fSL "${DOWNLOAD}/${ASSET}" -o "${TMP}/${ASSET}" ||
  die "download failed: ${DOWNLOAD}/${ASSET}"

echo "Downloading ${DOWNLOAD}/SHA256SUMS.txt ..."
curl -fsSL "${DOWNLOAD}/SHA256SUMS.txt" -o "${TMP}/SHA256SUMS.txt" ||
  die "no SHA256SUMS.txt in release ${TAG} — refusing to install an unverified binary"

# The sums file covers every attached file; pull out the one line for this
# archive. sha256sum writes "<digest>  <name>" and marks binary mode with a
# leading '*' on the name, so tolerate both spellings and nothing else.
expected=$(awk -v want="$ASSET" '{ name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }' \
  "${TMP}/SHA256SUMS.txt")
[ -n "$expected" ] ||
  die "SHA256SUMS.txt has no entry for ${ASSET} — refusing to install an unverified binary"

actual=$(sha256_stdin <"${TMP}/${ASSET}")
if [ "$actual" != "$expected" ]; then
  echo "install: CHECKSUM MISMATCH for ${ASSET}" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  die "the download does not match the release's published digest — not installing"
fi
echo "Verified sha256 ${actual}"

# The archive holds one directory, flowstock_<tag>_<os>_<arch>/, with the binary
# and the docs that ship beside it.
tar -xzf "${TMP}/${ASSET}" -C "$TMP" || die "could not unpack ${ASSET}"
unpacked="${TMP}/flowstock_${TAG}_${OS}_${ARCH}/flowstock"
[ -f "$unpacked" ] || die "the archive did not contain flowstock where expected"

chmod +x "$unpacked"
mv "$unpacked" ./flowstock
echo "Installed ./flowstock ${TAG} — run it with:  ./flowstock"
