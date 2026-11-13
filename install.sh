#!/usr/bin/env bash
# SendspinPi one-line installer:
#   curl -fsSL https://raw.githubusercontent.com/thatguy-za/SendspinPi/main/install.sh | sudo bash
# Pin a version:  ... | sudo SENDSPINPI_REF=v0.1.1 bash
# Extra options (e.g. --reset-password):  ... | sudo bash -s -- --reset-password
set -euo pipefail

REPO="thatguy-za/SendspinPi"
REF="${SENDSPINPI_REF:-main}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: curl -fsSL <url> | sudo bash"; exit 1; }

# Running from a clone or an unpacked release? Use it as is.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/setup.sh" ]; then
  exec bash "$HERE/setup.sh" "$@"
fi

command -v curl >/dev/null || { apt-get update && apt-get install -y curl ca-certificates; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading SendspinPi ($REF)"
curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP" --strip-components=1
bash "$TMP/setup.sh" "$@"
