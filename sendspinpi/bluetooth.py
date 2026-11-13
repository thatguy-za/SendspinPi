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
    return {"mac": mac, "name": name.group(1).strip() if name else mac, "paired": flag("Paired"),
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


def pair_steps(mac):
    def go(log):
        d = info(mac)
        if not d or not d["paired"]:
            log("Pairing with %s…" % mac)
            rc, out, err = run(["bluetoothctl", "--agent", "NoInputNoOutput", "pair", mac], timeout=60)
            log((out + err).strip())
            d = info(mac)
            if not d or not d["paired"]:
                raise RuntimeError("Pairing failed. Put the speaker in pairing mode and try again.")
        log("Trusting (so it reconnects automatically)…")
        log(" ".join(_ctl("trust", mac)[1:]).strip())
        log("Connecting…")
        rc, out, err = _ctl("connect", mac, timeout=40)
        log((out + err).strip())
        d = info(mac)
        if not d or not d["connected"]:
            raise RuntimeError("Paired, but could not connect.")
        log("Connected to %s." % d["name"])
    return [go]


def connect(mac):
    rc, out, err = _ctl("connect", mac, timeout=40)
    d = info(mac)
    return bool(d and d["connected"]), (out + err).strip()


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
    run(["bluetoothctl", "--agent", "NoInputNoOutput", "pair", mac], timeout=60)
    d = info(mac)
    if not d or not d["paired"]:
        return False
    _ctl("trust", mac)
    _ctl("connect", mac, timeout=40)
    return True


def watchdog_loop():
    """Keep the selected speaker connected; restart the player when it (re)appears."""
    time.sleep(45)
    last = None
    attempt = 0.0
    repair_at = 0.0
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
                last = connected
        except Exception:  # noqa: BLE001
            pass
        time.sleep(20)
