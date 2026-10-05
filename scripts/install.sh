#!/bin/sh
# Installs the latest butterfly binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/Deveshu04/Butterfly-Code-CLI/master/scripts/install.sh | sh
# Options (environment): BUTTERFLY_VERSION=0.1.0  BUTTERFLY_INSTALL_DIR=$HOME/.local/bin
set -eu

REPO="Deveshu04/Butterfly-Code-CLI"
INSTALL_DIR="${BUTTERFLY_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "butterfly install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required"; }
need curl
need tar
need uname

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

if [ -n "${BUTTERFLY_VERSION:-}" ]; then
  version="${BUTTERFLY_VERSION#v}"
else
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || fail "could not determine the latest version"
fi

name="butterfly-v$version-$os-$arch.tar.gz"
base="https://github.com/$REPO/releases/download/v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading butterfly v$version ($os-$arch)..."
curl -fsSL "$base/$name" -o "$tmp/$name" || fail "download failed: $base/$name"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download checksums"

expected="$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "no checksum for $name"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$name" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $name"

tar -xzf "$tmp/$name" -C "$tmp"
mkdir -p "$INSTALL_DIR"
mv "$tmp/butterfly" "$INSTALL_DIR/butterfly"
chmod +x "$INSTALL_DIR/butterfly"

echo "Installed butterfly v$version to $INSTALL_DIR/butterfly"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add it to your PATH, e.g.: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
