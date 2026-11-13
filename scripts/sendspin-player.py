#!/opt/sendspinpi/uv-tools/sendspin/bin/python
"""Start the Sendspin player.

Normally this is exactly `sendspin daemon`. When "Two-way volume" is switched on in SendspinPi
(a marker file), the player controls the Bluetooth speaker's own volume and follows the speaker's
volume buttons, so the speaker and the Sendspin server always show the same level.

If anything here fails, Sendspin starts the normal way.
"""
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time

LOG = logging.getLogger("sendspinpi.volume")
FLAG = os.environ.get("SENDSPINPI_NATIVEFLAG", "/var/lib/sendspin/native-volume")
BTCONF = os.environ.get("SENDSPINPI_BTCONF", "/etc/alsa/conf.d/99-sendspinpi-bluetooth.conf")
VOLFILE = os.environ.get("SENDSPINPI_VOLFILE", "/var/lib/sendspin/last-volume")
POLL_S = 1.5
SETTINGS = os.environ.get("SENDSPINPI_SETTINGS", "/var/lib/sendspin/.config/sendspin/settings-daemon.json")
FORMAT_MARKER = os.environ.get("SENDSPINPI_BTFORMAT", "/var/lib/sendspin/bt-format")


def _pct(raw):
    return max(0, min(100, round(raw * 100 / 127)))


def _raw(pct):
    return max(0, min(127, round(pct * 127 / 100)))


def _write_volfile(pct):
    """Level for the SendspinPi Home page (Sendspin itself saves its settings only after a minute)."""
    try:
        with open(VOLFILE + ".tmp", "w") as f:
            f.write("%d\n" % pct)
        os.replace(VOLFILE + ".tmp", VOLFILE)
    except OSError:
        pass


def _speaker_mac():
    try:
        with open(BTCONF) as f:
            m = re.search(r'device "([0-9A-Fa-f:]{17})"', f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def _transport_rate():
    """Sample rate of the Bluetooth link (44100 or 48000); 48000 if it cannot be read."""
    ctl = shutil.which("bluealsactl") or shutil.which("bluealsa-cli")
    mac = _speaker_mac()
    if not ctl or not mac:
        return 48000
    try:
        key = ("dev_" + mac.replace(":", "_") + "/a2dpsrc").lower()
        out = subprocess.run([ctl, "list-pcms"], capture_output=True, text=True, timeout=8).stdout
        pcm = next((l.split()[0] for l in out.splitlines() if key in l.lower()), None)
        if pcm:
            info = subprocess.run([ctl, "info", pcm], capture_output=True, text=True, timeout=8).stdout
            m = re.search(r"^Sampling:\s*(\d+)", info, re.M)
            if m and int(m.group(1)) in (44100, 48000):
                return int(m.group(1))
    except Exception:  # noqa: BLE001
        pass
    return 48000


def manage_bt_audio_format():
    """A Bluetooth (SBC) link carries 16-bit audio, so ask the server for 16-bit instead of the 24-bit
    default: three times less data over Wi-Fi, which shares one antenna with Bluetooth on a Pi Zero 2 W,
    and no conversion on the Pi. Runs before the player reads its settings.

    Only touches a format that this function set itself (remembered in a marker file), so a format set
    by hand is never overwritten, and the setting is removed again when the output is no longer Bluetooth."""
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    try:
        with open(FORMAT_MARKER) as f:
            managed = f.read().strip() or None
    except OSError:
        managed = None
    changed = False
    if data.get("audio_device") == "sendspin_bt":
        current = data.get("audio_format")
        # ours if unset, if we set it, or if it is exactly what we would choose (a value set by hand while testing)
        if current is None or current == managed or re.fullmatch(r"flac:(44100|48000):16:2", current):
            want = "flac:%d:16:2" % _transport_rate()
            if current != want:
                data["audio_format"] = want
                changed = True
            with open(FORMAT_MARKER, "w") as f:
                f.write(want + "\n")
    elif managed and data.get("audio_format") == managed:
        del data["audio_format"]
        changed = True
        try:
            os.remove(FORMAT_MARKER)
        except OSError:
            pass
    if changed:
        with open(SETTINGS + ".tmp", "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(SETTINGS + ".tmp", SETTINGS)


class BluetoothVolumeController:
    """Sendspin volume controller backed by BlueALSA's native (AVRCP absolute) volume.

    Same interface as sendspin.hook_volume.HookVolumeController, plus monitoring, so changes made
    with the speaker's own buttons reach the Sendspin server."""

    def __init__(self, command, settings):  # command (the hook path) is not used
        self._settings = settings
        self._ctl = shutil.which("bluealsactl") or shutil.which("bluealsa-cli")
        self._native_pcm = None
        self._prev = None
        self._task = None
        self._quiet_until = 0.0   # ignore speaker-side changes while/just after we set the volume
        self._level = self._initial_level()
        LOG.info("Two-way Bluetooth volume is on")

    def _initial_level(self):
        try:
            with open(VOLFILE) as f:
                return max(0, min(100, int(f.read().strip())))
        except (OSError, ValueError):
            return max(0, min(100, self._settings.player_volume))

    # ---- BlueALSA helpers
    async def _run(self, *args):
        if not self._ctl:
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                self._ctl, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=8)
        except Exception:  # noqa: BLE001
            return None
        return out.decode(errors="replace") if proc.returncode == 0 else None

    async def _pcm(self):
        try:
            with open(BTCONF) as f:
                m = re.search(r'device "([0-9A-Fa-f:]{17})"', f.read())
        except OSError:
            return None
        if not m:
            return None
        key = ("dev_" + m.group(1).replace(":", "_") + "/a2dpsrc").lower()
        for line in (await self._run("list-pcms") or "").splitlines():
            if key in line.lower():
                return line.split()[0]
        return None

    async def _read_raw(self, pcm):
        out = await self._run("info", pcm)
        m = re.search(r"Volume:\s*(?:L:\s*)?(\d+)", out or "")
        return int(m.group(1)) if m else None

    async def _native(self, pcm):
        """Pass volume to the speaker instead of scaling it in software (once per connection)."""
        if self._native_pcm != pcm:
            await self._run("soft-volume", pcm, "off")
            self._native_pcm = pcm

    async def _apply(self, pcm, pct):
        """Send a level to the speaker. BlueALSA's own idea of the speaker's volume is only a guess
        until something has been sent, so never trust a read before this has happened."""
        self._quiet_until = time.monotonic() + 4
        await self._native(pcm)
        await self._run("volume", pcm, str(_raw(pct)))
        # the speaker rounds to its own steps; remember where it settled so that
        # is not mistaken for someone pressing the speaker's buttons
        await asyncio.sleep(0.4)
        raw = await self._read_raw(pcm)
        if raw is not None:
            self._prev = raw
        self._quiet_until = time.monotonic() + 1.5

    # ---- the Sendspin volume controller interface
    async def set_state(self, volume, *, muted):
        if not 0 <= volume <= 100:
            raise ValueError("Volume must be 0-100, got %s" % volume)
        effective = 0 if muted else volume
        pcm = await self._pcm()
        if pcm is None:
            LOG.warning("Bluetooth speaker not connected: volume %d%% not applied", effective)
        else:
            await self._apply(pcm, effective)
        self._level = volume
        self._settings.update(player_volume=volume, player_muted=muted)
        _write_volfile(effective)

    async def get_state(self):
        """The player starts with its saved level, and the speaker is made to match it."""
        muted = bool(self._settings.player_muted)
        pcm = await self._pcm()
        if pcm is not None:
            await self._apply(pcm, 0 if muted else self._level)
        return self._level, muted

    async def start_monitoring(self, callback):
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._watch(callback))

    async def stop_monitoring(self):
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _watch(self, callback):
        """Report volume changes made on the speaker itself."""
        while True:
            await asyncio.sleep(POLL_S)
            try:
                pcm = await self._pcm()
                if pcm is None:
                    self._prev = None
                    continue
                await self._native(pcm)
                raw = await self._read_raw(pcm)
                if raw is None:
                    continue
                if self._prev is None:   # the speaker just (re)connected: make it match the slider
                    await self._apply(pcm, 0 if self._settings.player_muted else self._level)
                    continue
                if time.monotonic() < self._quiet_until:
                    self._prev = raw
                    continue
                if raw != self._prev:
                    self._prev = raw
                    pct = _pct(raw)
                    LOG.info("Speaker volume changed to %d%%", pct)
                    self._level = pct
                    self._settings.update(player_volume=pct, player_muted=False)
                    _write_volfile(pct)
                    callback(pct, False)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                LOG.debug("Volume check failed", exc_info=True)


def main():
    try:
        manage_bt_audio_format()
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("sendspinpi").warning("Could not adjust the audio format (%s)", exc)
    import sendspin.cli as cli   # the same module the normal `sendspin` command runs
    if os.path.exists(FLAG):
        try:
            if not hasattr(cli, "HookVolumeController"):
                raise AttributeError("this Sendspin version has no HookVolumeController")
            cli.HookVolumeController = BluetoothVolumeController
        except Exception as exc:  # noqa: BLE001
            logging.getLogger("sendspinpi").warning(
                "Two-way volume unavailable (%s); using the normal volume control", exc)
    sys.argv[0] = "sendspin"
    return cli.main()


if __name__ == "__main__":
    sys.exit(main())
