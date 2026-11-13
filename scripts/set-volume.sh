#!/usr/bin/env bash
# Sendspin --hook-set-volume script: applies Sendspin's volume (0-100, last argument)
# to the connected Bluetooth speaker selected as the audio output.
# Does nothing when the output is not the Bluetooth speaker.
# Every call is logged: journalctl -t sendspinpi-volume
set -u

SETTINGS="${SENDSPINPI_SETTINGS:-/var/lib/sendspin/.config/sendspin/settings-daemon.json}"
BTCONF="${SENDSPINPI_BTCONF:-/etc/alsa/conf.d/99-sendspinpi-bluetooth.conf}"

log() { logger -t sendspinpi-volume -- "$*" 2>/dev/null || true; [ -n "${VERBOSE:-}" ] && echo "$*"; return 0; }

VOL="${*: -1}"
if ! [[ "$VOL" =~ ^[0-9]+$ ]] || [ "$VOL" -gt 100 ]; then log "ignored: bad volume argument '$*'"; exit 0; fi

# Only act when the Bluetooth speaker is the selected output.
if ! grep -q '"audio_device": *"sendspin_bt"' "$SETTINGS" 2>/dev/null; then
  log "volume $VOL ignored: output is not the Bluetooth speaker (settings: $SETTINGS)"; exit 0
fi
MAC="$(grep -o 'device "[0-9A-Fa-f:]*"' "$BTCONF" 2>/dev/null | head -1 | cut -d'"' -f2)"
if [ -z "$MAC" ]; then log "volume $VOL failed: no speaker address in $BTCONF"; exit 0; fi

CTL="$(command -v bluealsactl || command -v bluealsa-cli)" || { log "volume $VOL failed: bluealsa-cli not found"; exit 0; }
KEY="dev_$(echo "$MAC" | tr ':a-f' '_A-F')"

# Playback PCM of an A2DP speaker (we are the source): .../a2dpsrc/sink
PCM="$("$CTL" list-pcms 2>/dev/null | grep -i "$KEY/a2dpsrc" | head -1)"
if [ -z "$PCM" ]; then log "volume $VOL failed: speaker $MAC is not connected (no a2dpsrc PCM)"; exit 0; fi

RAW=$(( VOL * 127 / 100 ))
OUT="$("$CTL" volume "$PCM" "$RAW" 2>&1)"; RC=$?
log "volume $VOL% -> $RAW/127 on $PCM (exit $RC) $OUT"
exit 0
