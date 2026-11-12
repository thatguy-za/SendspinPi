#!/usr/bin/env bash
# Sendspin --hook-set-volume script: applies Sendspin's volume (0-100, last argument)
# to the connected Bluetooth speaker selected as the audio output.
# Does nothing when the output is not a BlueALSA device.
set -u

SETTINGS="${SENDSPINPI_SETTINGS:-/var/lib/sendspin/.config/sendspin/settings-daemon.json}"
VOL="${*: -1}"
[[ "$VOL" =~ ^[0-9]+$ ]] && [ "$VOL" -le 100 ] || exit 0

MAC="$(grep -o 'bluealsa:DEV=[0-9A-Fa-f:]*' "$SETTINGS" 2>/dev/null | head -1 | cut -d= -f2)"
[ -n "$MAC" ] || exit 0

CTL="$(command -v bluealsactl || command -v bluealsa-cli)" || exit 0
KEY="dev_$(echo "$MAC" | tr ':a-f' '_A-F')"

# Playback PCM of an A2DP speaker (we are the source): .../a2dpsrc/sink
PCM="$("$CTL" list-pcms 2>/dev/null | grep -i "$KEY/a2dpsrc" | head -1)"
[ -n "$PCM" ] || exit 0

"$CTL" volume "$PCM" "$(( VOL * 127 / 100 ))" >/dev/null 2>&1
