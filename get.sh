#!/usr/bin/env bash
# Deprecated name, kept so SendspinPi v0.0.1's built-in updater keeps working.
# Use install.sh instead.
set -euo pipefail
REF="${SENDSPINPI_REF:-main}"
exec bash <(curl -fsSL "https://raw.githubusercontent.com/thatguy-za/SendspinPi/$REF/install.sh") "$@"
