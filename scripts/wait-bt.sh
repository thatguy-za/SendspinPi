#!/usr/bin/env bash
# Runs before the Sendspin player starts. The player (PortAudio) only looks for sound devices
# once, at start-up, so if the Bluetooth speaker is the selected output give it up to 10 s to
# connect first. Always exits 0: if the speaker is off, the player starts anyway and
# SendspinPi restarts it as soon as the speaker connects.
SETTINGS="${SENDSPINPI_SETTINGS:-/var/lib/sendspin/.config/sendspin/settings-daemon.json}"
BTCONF="${SENDSPINPI_BTCONF:-/etc/alsa/conf.d/99-sendspinpi-bluetooth.conf}"

grep -q '"audio_device": *"sendspin_bt"' "$SETTINGS" 2>/dev/null || exit 0
MAC="$(grep -o 'device "[0-9A-Fa-f:]*"' "$BTCONF" 2>/dev/null | head -1 | cut -d'"' -f2)"
[ -n "$MAC" ] || exit 0
CTL="$(command -v bluealsactl || command -v bluealsa-cli)" || exit 0
KEY="dev_$(echo "$MAC" | tr ':a-f' '_A-F')"

for _ in $(seq 1 5); do
  "$CTL" list-pcms 2>/dev/null | grep -qi "$KEY/a2dpsrc" && exit 0
  sleep 2
done
exit 0
