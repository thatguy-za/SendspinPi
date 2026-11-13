"""Bluetooth speaker management (BlueZ via bluetoothctl) for BlueALSA output."""
import os
import re
import threading
import time

from . import config, sendspin_ctl
from .util import run

# Sendspin only accepts custom ALSA names that appear in `aplay -L`, so the speaker is
# exposed as a named, hinted ALSA device defined here.
BT_PCM = "sendspin_bt"
BT_CONF = os.environ.get("SENDSPINPI_BTCONF", "/etc/alsa/conf.d/99-sendspinpi-bluetooth.conf")
BT_CONF_TEMPLATE = """# Managed by SendspinPi - changes here are overwritten.
# A plain bluealsa PCM (no plug wrapper): PortAudio drops devices that reject its
# small probe buffers, which a plug-wrapped bluealsa PCM does.
pcm.%(name)s {
    type bluealsa
    device "%(mac)s"
    profile "a2dp"
    hint {
        show on
        description "Bluetooth speaker (SendspinPi)"
    }
}
"""

MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


def norm(mac):
    m = str(mac).strip().upper()
    return m if MAC_RE.match(m) else None


def _ctl(*args, timeout=20):
    return run(["bluetoothctl"] + list(args), timeout=timeout)


def adapter():
    rc, out, err = _ctl("show")
    if rc == 127:
        return {"available": False, "error": "Bluetooth tools are not installed (re-run the installer)."}
    if rc != 0 or "Controller" not in out:
        return {"available": False, "error": (err or out or "No Bluetooth adapter found").strip()}
    m = re.search(r"Powered: (\w+)", out)
    return {"available": True, "powered": bool(m and m.group(1) == "yes")}


def ensure_powered():
    run(["rfkill", "unblock", "bluetooth"])
    _ctl("power", "on")
    _ctl("pairable", "on")  # if the adapter isn't bondable, BlueZ keeps pairings in memory only


def info(mac):
    rc, out, _ = _ctl("info", mac)
    if rc != 0:
        return None

    def flag(name):
        m = re.search(r"^\s*%s: (\w+)" % name, out, re.M)
        return bool(m and m.group(1) == "yes")
    name = re.search(r"^\s*Alias: (.+)$", out, re.M) or re.search(r"^\s*Name: (.+)$", out, re.M)
    icon = re.search(r"^\s*Icon: (\S+)", out, re.M)
    audio = bool((icon and icon.group(1).startswith("audio")) or "Audio Sink" in out
                 or "0000110b" in out.lower())
    bm = re.search(r"^\s*Bonded: (\w+)", out, re.M)
    bonded = (bm.group(1) == "yes") if bm else flag("Paired")
    return {"mac": mac, "name": name.group(1).strip() if name else mac, "paired": flag("Paired"), "bonded": bonded,
            "trusted": flag("Trusted"), "connected": flag("Connected"), "audio": audio,
            "known_type": bool(icon), "seen": bool(re.search(r"^\s*RSSI:", out, re.M))}


def _conf_mac():
    try:
        with open(BT_CONF) as f:
            m = re.search(r'device "([0-9A-Fa-f:]{17})"', f.read())
        return m.group(1).upper() if m else None
    except OSError:
        return None


def selected_mac():
    dev = sendspin_ctl.read_settings().get("audio_device", "")
    if dev == BT_PCM:
        return _conf_mac()
    m = re.search(r"DEV=([0-9A-Fa-f:]{17})", dev)  # older inline form
    return m.group(1).upper() if m else None


def devices():
    _, out, _ = _ctl("devices")
    sel = selected_mac()
    res = []
    for line in out.splitlines():
        m = re.match(r"Device ([0-9A-F:]{17}) (.*)", line)
        if not m:
            continue
        d = info(m.group(1))
        if not d:
            continue
        d["in_use"] = d["mac"] == sel
        # hide unnamed random devices (name == MAC with dashes) unless known audio
        if not d["audio"] and d["name"].replace("-", ":") == d["mac"]:
            continue
        res.append(d)
    res.sort(key=lambda d: (not d["in_use"], not d["connected"], not d["audio"], d["name"].lower()))
    return res


def status():
    a = adapter()
    if a["available"] and not a["powered"]:
        ensure_powered()
        a = adapter()
    a["devices"] = devices() if a["available"] else []
    a["selected"] = selected_mac()
    a["auto_reconnect"] = config.load()["bluetooth_auto_reconnect"]
    return a


def scan(seconds=8):
    ensure_powered()
    _ctl("--timeout", str(seconds), "scan", "on", timeout=seconds + 10)
    return devices()


def _wait_for_speaker(mac, log, seconds):
    """Scan in 8 second windows until the speaker is visible (i.e. in pairing mode)."""
    deadline = time.time() + seconds
    first = True
    while True:
        _ctl("--timeout", "8", "scan", "on", timeout=20)
        d = info(mac)
        if d and (d["seen"] or d["paired"]):   # speakers in pairing mode often pair on their own
            return True
        if time.time() >= deadline:
            return False
        if first:
            log("Now put the speaker in pairing mode (usually hold its Bluetooth button until it flashes). Waiting up to %d seconds…" % seconds)
            first = False
        else:
            log("Still waiting for the speaker…")


def _pair_permanently(mac, log, wait=60):
    """Pair with the speaker so the link key is saved (Bonded: yes). A pairing that exists but isn't
    bonded is thrown away and redone. Raises RuntimeError with a user-friendly message on failure."""
    ensure_powered()
    d = info(mac)
    if d and d["paired"] and not d["bonded"]:
        log("This pairing is only temporary and would be lost on restart. Removing it and pairing again…")
        _ctl("remove", mac)
        d = None
    if not d or not d["paired"]:
        if not d or not d["seen"]:
            if not _wait_for_speaker(mac, log, wait):
                raise RuntimeError("The speaker didn't show up. Put it in pairing mode and try again.")
            d = info(mac)
    if not d or not d["paired"]:
        log("Pairing with %s…" % mac)
        rc, out, err = run(["bluetoothctl", "--agent", "NoInputNoOutput", "pair", mac], timeout=60)
        log((out + err).strip())
        d = info(mac)
        if not d or not d["paired"]:
            raise RuntimeError("Pairing failed. Put the speaker in pairing mode and try again.")
    log("Trusting (so it reconnects automatically)…")
    _ctl("trust", mac)
    d = info(mac)
    if d and not d["bonded"]:
        log("Warning: the pairing was not saved permanently, so it may need repeating after a restart.")


def pair_steps(mac):
    def go(log):
        _pair_permanently(mac, log)
        log("Connecting…")
        rc, out, err = _ctl("connect", mac, timeout=40)
        log((out + err).strip())
        d = info(mac)
        if not d or not d["connected"]:
            raise RuntimeError("Paired, but could not connect.")
        log("Connected to %s." % d["name"])
        if selected_mac() == mac:
            log("Restarting the player so it picks up the speaker…")
            _restart_player()
    return [go]


def connect(mac):
    rc, out, err = _ctl("connect", mac, timeout=40)
    d = info(mac)
    ok = bool(d and d["connected"])
    if ok and selected_mac() == mac:
        _restart_player()  # the player only sees devices that exist when it starts
    return ok, (out + err).strip()


def disconnect(mac):
    rc, out, err = _ctl("disconnect", mac)
    return rc == 0, (out + err).strip()


def _restart_player():
    if sendspin_ctl.service_state()["active"] == "active":
        sendspin_ctl.service_action("restart")


def _write_conf(mac):
    os.makedirs(os.path.dirname(BT_CONF), exist_ok=True)
    with open(BT_CONF, "w") as f:
        f.write(BT_CONF_TEMPLATE % {"name": BT_PCM, "mac": mac})
    os.chmod(BT_CONF, 0o644)


def use(mac):
    cur = sendspin_ctl.read_settings().get("audio_device", "")
    if cur and cur != BT_PCM and not cur.startswith("bluealsa"):
        config.update(previous_audio_device=cur)
    _write_conf(mac)
    sendspin_ctl.set_audio_device(BT_PCM)
    _restart_player()


def unuse():
    cfg = config.load()
    sendspin_ctl.set_audio_device(cfg.get("previous_audio_device", ""))
    try:
        os.remove(BT_CONF)
    except OSError:
        pass
    _restart_player()


def migrate():
    """Older versions stored an inline bluealsa:DEV=... device that Sendspin rejects."""
    dev = sendspin_ctl.read_settings().get("audio_device", "")
    m = re.match(r"bluealsa:DEV=([0-9A-Fa-f:]{17})", dev)
    if m:
        use(m.group(1).upper())
        return
    # Existing installs: upgrade the old plug-wrapped definition to the plain one.
    mac = _conf_mac()
    if dev == BT_PCM and mac:
        try:
            with open(BT_CONF) as f:
                old_conf = f.read()
        except OSError:
            return
        if "type plug" in old_conf:
            _write_conf(mac)
            _restart_player()


def forget(mac):
    if selected_mac() == mac:
        unuse()
    rc, out, err = _ctl("remove", mac)
    return rc == 0, (out + err).strip()


def auto_repair(mac):
    """The Pi lost its pairing with the chosen speaker (e.g. the speaker forgot it).
    If the speaker is nearby and willing, pair again without user action.
    Only ever touches the speaker the user selected. Returns True when paired."""
    ensure_powered()
    _ctl("--timeout", "8", "scan", "on", timeout=20)
    d = info(mac)
    if not d or not d["seen"]:
        return False  # not in range / not in pairing mode
    try:
        _pair_permanently(mac, lambda *_: None, wait=0)
    except RuntimeError:
        return False
    _ctl("connect", mac, timeout=40)
    return True


def _player_cannot_see_speaker():
    """True if the *current* run of the player logged that it can't find the Bluetooth device
    (it only looks for devices at start-up, and its audio thread then dies silently)."""
    _, inv, _ = run(["systemctl", "show", sendspin_ctl.SERVICE, "-p", "InvocationID", "--value"])
    inv = inv.strip()
    if not inv:
        return False
    _, logs, _ = run(["journalctl", "_SYSTEMD_INVOCATION_ID=" + inv, "-o", "cat", "--no-pager", "-n", "300"])
    return "No output device matching" in logs


def watchdog_loop():
    """Keep the selected speaker connected; restart the player when it (re)appears."""
    time.sleep(45)
    try:
        ensure_powered()  # also turns on "pairable", which is off by default on this Pi
    except Exception:  # noqa: BLE001
        pass
    last = None
    attempt = 0.0
    repair_at = 0.0
    fixed_at = 0.0
    while True:
        try:
            mac = selected_mac()
            if not mac:
                last = None
            else:
                d = info(mac)
                connected = bool(d and d["connected"])
                auto = config.load()["bluetooth_auto_reconnect"]
                if auto and not (d and d["paired"]) and time.time() - repair_at > 60:
                    repair_at = time.time()
                    auto_repair(mac)
                    d = info(mac)
                    connected = bool(d and d["connected"])
                if auto and not connected and time.time() - attempt > 30 and d and d["paired"]:
                    attempt = time.time()
                    ensure_powered()
                    _ctl("connect", mac, timeout=30)
                    d = info(mac)
                    connected = bool(d and d["connected"])
                if connected and last is False and sendspin_ctl.service_state()["enabled"] == "enabled":
                    sendspin_ctl.service_action("restart")
                    fixed_at = time.time()
                elif (connected and time.time() - fixed_at > 90
                        and sendspin_ctl.service_state()["active"] == "active" and _player_cannot_see_speaker()):
                    sendspin_ctl.service_action("restart")
                    fixed_at = time.time()
                last = connected
        except Exception:  # noqa: BLE001
            pass
        time.sleep(20)
