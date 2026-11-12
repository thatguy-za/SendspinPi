#!/usr/bin/env bash
# SensSpinPi installer for Raspberry Pi OS (Bookworm/Trixie, NetworkManager).
# Usage: sudo ./install.sh [--reset-password]
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/sensspin
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages"
apt-get update
apt-get install -y python3 curl ca-certificates alsa-utils iw libportaudio2 \
  network-manager dnsmasq-base avahi-daemon

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
rm -rf "$APP/app/sensspin"
cp -r "$SRC/sensspin" "$APP/app/sensspin"
find "$APP/app" -name __pycache__ -prune -exec rm -rf {} +
chmod -R a+rX "$APP"
cp "$SRC/systemd/sensspin-web.service" "$SRC/systemd/sendspin.service" /etc/systemd/system/

echo "==> Creating credentials"
mkdir -p /etc/sensspin
chmod 700 /etc/sensspin
INIT="$(cd "$APP/app" && python3 -m sensspin init "$@")"
val() { echo "$INIT" | sed -n "s/^$1=//p"; }
USERNAME="$(val USERNAME)"; PASSWORD="$(val PASSWORD)"
HS_SSID="$(val HOTSPOT_SSID)"; HS_PSK="$(val HOTSPOT_PSK)"

systemctl daemon-reload
systemctl enable sensspin-web.service
systemctl restart sensspin-web.service

HOST="$(hostname)"
IP="$(hostname -I | awk '{print $1}')"
echo
echo "=============================================================="
echo " SensSpinPi is running"
echo "   Open:      http://${HOST}.local/   ${IP:+or http://$IP/}"
echo "   Username:  ${USERNAME}"
if [ -n "$PASSWORD" ]; then
  echo "   Password:  ${PASSWORD}"
  echo "   (shown only once - change both in the web UI > Account)"
else
  echo "   Password:  unchanged (re-run with --reset-password to generate a new one)"
fi
echo
echo " No network? After boot the Pi starts a setup hotspot:"
echo "   WiFi:      ${HS_SSID}   Password: ${HS_PSK}"
echo "   Then open  http://10.42.0.1/"
echo "=============================================================="
