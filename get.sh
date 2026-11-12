#!/usr/bin/env bash
# One-line installer:
#   curl -fsSL https://raw.githubusercontent.com/thatguy-za/SendspinPi/main/get.sh | sudo bash
# Pin a version:  ... | sudo SENDSPINPI_REF=v0.0.1 bash
set -euo pipefail

REPO="thatguy-za/SendspinPi"
REF="${SENDSPINPI_REF:-main}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: curl -fsSL <url> | sudo bash"; exit 1; }
command -v curl >/dev/null || { apt-get update && apt-get install -y curl ca-certificates; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading SendspinPi ($REF)"
curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP" --strip-components=1
bash "$TMP/install.sh" "$@"
