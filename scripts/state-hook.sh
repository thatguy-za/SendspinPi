#!/usr/bin/env bash
# Sendspin --hook-start / --hook-stop script: records whether a stream is playing, for the web UI's Home page.
# Writes {"state": "playing"|"idle", "server": "...", "at": <unix time>} to the player's state file.
set -u

OUT="${SENDSPINPI_PLAYBACK:-/var/lib/sendspin/playback.json}"
case "${SENDSPIN_EVENT:-}" in
  start) state=playing ;;
  stop) state=idle ;;
  *) exit 0 ;;
esac
server=$(printf '%s' "${SENDSPIN_SERVER_NAME:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037')
tmp="$OUT.$$"
printf '{"state": "%s", "server": "%s", "at": %s}\n' "$state" "$server" "$(date +%s)" > "$tmp" && mv -f "$tmp" "$OUT"
exit 0
