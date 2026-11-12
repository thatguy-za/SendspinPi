# SendspinPi

A lightweight web UI for running the [Sendspin CLI](https://github.com/Sendspin/sendspin-cli) on small Raspberry Pi boards such as the Pi Zero 2 W. It walks you through setup and handles the day-to-day admin from your phone.

- **Guided setup wizard**: name the player, install Sendspin, pick your DAC, test the sound, connect to your server.
- **Sendspin management**: install, update, start/stop, logs.
- **Audio**: choose a USB/onboard output or an I²S DAC HAT (writes the `dtoverlay` for you), with a test tone.
- **OS updates**: refresh package lists and run full upgrades with live output.
- **WiFi**: scan, connect, forget networks. If the Pi has no network, it starts a setup hotspot.
- **Power**: reboot and shut down.
- Mobile-first UI, no frameworks, Python standard library only (about 20–30 MB RAM).

## Requirements

- Raspberry Pi OS (Bookworm or Trixie), **Lite** recommended. Audio goes straight to ALSA, so on the Desktop image PipeWire may hold the sound card.
- NetworkManager (the default on current Raspberry Pi OS) for WiFi management.
- An internet connection during install.

## Install

On the Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/thatguy-za/SendspinPi/main/get.sh | sudo bash
```

The installer asks you to choose a password (twice, at least 8 characters) for the web UI. The username is `admin`. When it finishes it prints the address and the setup hotspot details. You can change the username and password later in the web UI under **Account**.

For unattended installs there's no terminal to ask on, so set `SENDSPINPI_PASSWORD=...` before `bash`, or let it generate a random password, which is shown once at the end.

Prefer to read the code first? Clone and run it yourself:

```bash
git clone https://github.com/thatguy-za/SendspinPi.git
cd SendspinPi
sudo ./install.sh
```

## First use

1. Open `http://<hostname>.local/` (or the Pi's IP address) in a browser.
2. Log in with the credentials printed by the installer.
3. Follow the **Setup** wizard. Installing Sendspin takes several minutes on a Zero 2 W, so keep the page open.
4. Open your Sendspin server (for example Music Assistant). The player appears under the name you chose. If the server asks for a pairing code, it is shown in the wizard and in the Sendspin tab's logs.

### No network yet?

If the Pi can't connect to a network about a minute after boot, it starts a hotspot called `SendspinPi-Setup`. The installer prints its password. Join it, open `http://10.42.0.1/`, go to **WiFi** and pick your network. The hotspot goes away once you're connected.

### I²S DAC HATs

In **Audio**, pick your HAT from the list and apply it. This adds a managed block to `/boot/firmware/config.txt` (a backup is saved next to it as `config.txt.sendspinpi.bak`) and needs a reboot. Choosing "None" removes it again.

### Bluetooth speakers

Open the **Bluetooth** tab, put your speaker in pairing mode, press **Scan**, then **Pair & connect** and **Use for Sendspin**. The speaker is trusted, so it can reconnect on its own after a reboot. **Auto-reconnect** (on by default, toggle in the Bluetooth tab) also makes the Pi retry every 30 seconds if the speaker drops, and the player restarts when it comes back. It only applies to the speaker currently used for Sendspin.

While a Bluetooth speaker is the output, volume changes from your Sendspin server are applied to the speaker's own volume (through Sendspin's `hook_set_volume` and `bluealsactl`). Choosing another output in **Audio**, or pressing **Stop using**, switches back.

Audio uses [BlueALSA](https://github.com/arkq/bluez-alsa), which is much lighter than PipeWire. The Pi Zero 2 W shares one antenna between WiFi and Bluetooth, so audio may stutter if the signal is weak. Keep the Pi near the speaker, or use ethernet if you can.

### Automatic updates

In **System → Automatic updates**, switch on "Install updates automatically" and the Pi checks once a day and installs updates in the background (using Debian's `unattended-upgrades`). Choose **Security fixes only** (safest) or **All updates** (also bug fixes and Raspberry Pi updates). You can optionally let the Pi restart itself at a set time when an update needs it. Music stops for about a minute. If you leave that off, the System page shows a reminder when a restart is needed. **Check and install now** runs it straight away, and **Show details** shows the log.

### SendspinPi updates

**System → SendspinPi updates** shows the installed version and whether a newer release exists. **Update now** installs it (the page restarts for about a minute and your settings are kept). Switch on "Update SendspinPi automatically" to check every few hours and install new releases without you doing anything. It's off by default, and it only installs tagged [GitHub releases](https://github.com/thatguy-za/SendspinPi/releases), never unreleased code.

## Updating

Re-run the install command. It updates the app and keeps your password, WiFi and Sendspin settings:

```bash
curl -fsSL https://raw.githubusercontent.com/thatguy-za/SendspinPi/main/get.sh | sudo bash
```

## Forgot your password?

Running the installer with `--reset-password` asks you for a new admin password. It also installs the latest version, but your WiFi and Sendspin settings are kept:

```bash
curl -fsSL https://raw.githubusercontent.com/thatguy-za/SendspinPi/main/get.sh | sudo bash -s -- --reset-password
```

## Security notes

- The UI runs as root on plain HTTP (port 80) because it manages the OS. Keep it on a trusted network and don't expose it to the internet.
- Logins are rate limited and passwords are stored as PBKDF2 hashes in `/etc/sendspinpi/config.json` (root only).

## Uninstall

```bash
sudo systemctl disable --now sendspinpi-web sendspin
sudo rm -rf /opt/sendspinpi /etc/sendspinpi /etc/systemd/system/sendspinpi-web.service /etc/systemd/system/sendspin.service
sudo userdel -r sendspin
```

## Layout

```
get.sh / install.sh    installers
sendspinpi/              Python backend (server, wifi, audio, system, sendspin control)
sendspinpi/static/       web UI (HTML/CSS/JS)
systemd/               service units
```

## Status

Early release. Developed and smoke-tested off-device; please open an issue if something misbehaves on your hardware.

## License

MIT

## Releasing (maintainers)

Automatic updates follow GitHub releases. To ship a version, set `__version__` in `sendspinpi/__init__.py`, commit, then tag and publish a release named `vX.Y.Z` (for example `gh release create v0.2.0 --generate-notes`). The tag must match the version number.
