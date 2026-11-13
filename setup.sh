#!/usr/bin/env bash
# SendspinPi installer for Raspberry Pi OS (Bookworm/Trixie, NetworkManager).
# Usage: sudo ./setup.sh [--reset-password]  (or use install.sh, which also works from a clone)
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/sendspinpi
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages"
apt-get update
apt-get install -y python3 curl ca-certificates alsa-utils iw libportaudio2 \
  network-manager dnsmasq-base avahi-daemon unattended-upgrades

echo "==> Installing Bluetooth audio support (BlueALSA)"
BA_NEW=0
if apt-get install -y bluez bluez-alsa-utils libasound2-plugin-bluez rfkill; then
  BA="$(command -v bluealsad || command -v bluealsa || true)"
  if [ -n "$BA" ]; then
    # We are the A2DP *source* (sending audio to a speaker); don't also act as a speaker.
    mkdir -p /etc/systemd/system/bluealsa.service.d
    [ -f /etc/systemd/system/bluealsa.service.d/sendspinpi.conf ] || BA_NEW=1
    printf '[Service]\nExecStart=\nExecStart=%s -p a2dp-source\n' "$BA" \
      > /etc/systemd/system/bluealsa.service.d/sendspinpi.conf
  fi
  systemctl daemon-reload
  systemctl enable --now bluetooth bluealsa || echo "WARNING: could not start Bluetooth services"
else
  echo "WARNING: Bluetooth packages failed to install; the Bluetooth tab will be unavailable."
fi

if ! systemctl is-active --quiet NetworkManager; then
  echo "WARNING: NetworkManager is not running. WiFi management needs it"
  echo "         (default on current Raspberry Pi OS). Use raspi-config > Advanced > Network Config."
fi

echo "==> Creating sendspin user"
id sendspin >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/sendspin \
  --shell /usr/sbin/nologin -G audio sendspin
usermod -aG audio sendspin

echo "==> Installing uv (used to install Sendspin)"
if [ ! -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

echo "==> Installing application"
mkdir -p "$APP/app"
rm -rf "$APP/app/sendspinpi"
cp -r "$SRC/sendspinpi" "$APP/app/sendspinpi"
find "$APP/app" -name __pycache__ -prune -exec rm -rf {} +
mkdir -p "$APP/hooks"
install -m 755 "$SRC/scripts/set-volume.sh" "$APP/hooks/set-volume.sh"
install -m 755 "$SRC/scripts/wait-bt.sh" "$APP/hooks/wait-bt.sh"
chmod -R a+rX "$APP"
# Only restart BlueALSA on first install (avoids interrupting Bluetooth audio on updates)
[ "$BA_NEW" = 1 ] && { systemctl try-restart bluealsa 2>/dev/null || true; }
cp "$SRC/systemd/sendspinpi-web.service" "$SRC/systemd/sendspin.service" /etc/systemd/system/

echo "==> Creating credentials"

# Ask for the web UI password (first install, or with --reset-password).
# Done last so the long install above runs unattended; the web UI is only started after this.
# Reads from /dev/tty so it also works when piped via `curl | sudo bash`.
if [[ " $* " == *" --reset-password "* ]] || ! grep -qs '"password_hash": "pbkdf2' /etc/sendspinpi/config.json; then
  if [ -z "${SENDSPINPI_PASSWORD:-}" ]; then
    if (: </dev/tty) 2>/dev/null; then
      echo "Choose a password for the web UI (username: admin)."
      while :; do
        read -rsp "Password (min 8 characters): " p1 </dev/tty; echo
        read -rsp "Repeat password: " p2 </dev/tty; echo
        [ "${#p1}" -ge 8 ] || { echo "Too short, try again."; continue; }
        [ "$p1" = "$p2" ] || { echo "Passwords do not match, try again."; continue; }
        SENDSPINPI_PASSWORD="$p1"
        break
      done
    else
      echo "No terminal available: a random password will be generated and shown at the end."
    fi
  fi
else
  SENDSPINPI_PASSWORD=""
fi
export SENDSPINPI_PASSWORD="${SENDSPINPI_PASSWORD:-}"

mkdir -p /etc/sendspinpi
chmod 700 /etc/sendspinpi
INIT="$(cd "$APP/app" && python3 -m sendspinpi init "$@")"
val() { echo "$INIT" | sed -n "s/^$1=//p"; }
USERNAME="$(val USERNAME)"; PASSWORD="$(val PASSWORD)"
HS_SSID="$(val HOTSPOT_SSID)"; HS_PSK="$(val HOTSPOT_PSK)"

systemctl daemon-reload
systemctl enable sendspinpi-web.service
systemctl restart sendspinpi-web.service

HOST="$(hostname)"
IP="$(hostname -I | awk '{print $1}')"
echo
echo "=============================================================="
echo " SendspinPi is running"
echo "   Open:      http://${HOST}.local/   ${IP:+or http://$IP/}"
echo "   Username:  ${USERNAME}"
if [ -n "$PASSWORD" ]; then
  echo "   Password:  ${PASSWORD}   (randomly generated, shown only once)"
elif [ -n "$SENDSPINPI_PASSWORD" ]; then
  echo "   Password:  the one you just entered"
else
  echo "   Password:  unchanged (re-run with --reset-password to set a new one)"
fi
echo "   (change both in the web UI > Account)"
echo
echo " No network? After boot the Pi starts a setup hotspot:"
echo "   WiFi:      ${HS_SSID}   Password: ${HS_PSK}"
echo "   Then open  http://10.42.0.1/"
echo "=============================================================="
