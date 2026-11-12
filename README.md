# SensSpinPi

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
curl -fsSL https://raw.githubusercontent.com/thatguy-za/SensSpinPi/main/get.sh | sudo bash
```

When it finishes it prints the address, the username `admin` and a **randomly generated password**. The password is shown once, so note it down. You can change both in the web UI under **Account**.

Prefer to read the code first? Clone and run it yourself:

```bash
git clone https://github.com/thatguy-za/SensSpinPi.git
cd SensSpinPi
sudo ./install.sh
```

## First use

1. Open `http://<hostname>.local/` (or the Pi's IP address) in a browser.
2. Log in with the credentials printed by the installer.
3. Follow the **Setup** wizard. Installing Sendspin takes several minutes on a Zero 2 W, so keep the page open.
4. Open your Sendspin server (for example Music Assistant). The player appears under the name you chose. If the server asks for a pairing code, it is shown in the wizard and in the Sendspin tab's logs.

### No network yet?

If the Pi can't connect to a network about a minute after boot, it starts a hotspot called `SensSpin-Setup`. The installer prints its password. Join it, open `http://10.42.0.1/`, go to **WiFi** and pick your network. The hotspot goes away once you're connected.

### I²S DAC HATs

In **Audio**, pick your HAT from the list and apply it. This adds a managed block to `/boot/firmware/config.txt` (a backup is saved next to it as `config.txt.sensspin.bak`) and needs a reboot. Choosing "None" removes it again.

## Updating

Re-run the install command. It keeps your password, WiFi and Sendspin settings. Use `--reset-password` to generate a new admin password:

```bash
curl -fsSL https://raw.githubusercontent.com/thatguy-za/SensSpinPi/main/get.sh | sudo bash -s -- --reset-password
```

## Security notes

- The UI runs as root on plain HTTP (port 80) because it manages the OS. Keep it on a trusted network and don't expose it to the internet.
- Logins are rate limited and passwords are stored as PBKDF2 hashes in `/etc/sensspin/config.json` (root only).

## Uninstall

```bash
sudo systemctl disable --now sensspin-web sendspin
sudo rm -rf /opt/sensspin /etc/sensspin /etc/systemd/system/sensspin-web.service /etc/systemd/system/sendspin.service
sudo userdel -r sendspin
```

## Layout

```
get.sh / install.sh    installers
sensspin/              Python backend (server, wifi, audio, system, sendspin control)
sensspin/static/       web UI (HTML/CSS/JS)
systemd/               service units
```

## Status

Early release. Developed and smoke-tested off-device; please open an issue if something misbehaves on your hardware.

## License

MIT
