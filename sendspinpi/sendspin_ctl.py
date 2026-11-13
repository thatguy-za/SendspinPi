"""Install/upgrade/configure the sendspin daemon and its systemd unit."""
import json
import os
import re
import shutil
import urllib.request

from .util import cached, run

SERVICE = "sendspin"
BASE = os.environ.get("SENDSPINPI_BASE", "/opt/sendspinpi")
UV = os.environ.get("SENDSPINPI_UV", "/usr/local/bin/uv")
BIN = os.path.join(BASE, "bin", "sendspin")
SENDSPIN_USER = "sendspin"
SENDSPIN_HOME = os.environ.get("SENDSPINPI_SENDSPIN_HOME", "/var/lib/sendspin")
SETTINGS = os.path.join(SENDSPIN_HOME, ".config", "sendspin", "settings-daemon.json")
UV_ENV = {
    "UV_TOOL_DIR": os.path.join(BASE, "uv-tools"),
    "UV_TOOL_BIN_DIR": os.path.join(BASE, "bin"),
    "UV_PYTHON_INSTALL_DIR": os.path.join(BASE, "python"),
    "UV_CACHE_DIR": os.path.join(BASE, "uv-cache"),
    "UV_NO_PROGRESS": "1",
    # keeps uv from warning that its tool bin dir isn't on PATH (the service uses the full path)
    "PATH": os.path.join(BASE, "bin") + os.pathsep + os.environ.get("PATH", ""),
}
ACTIONS = {"start", "stop", "restart", "enable", "disable"}


def _installed_version():
    rc, out, _ = run([UV, "tool", "list"], env=UV_ENV)
    if rc != 0:
        return None
    m = re.search(r"^sendspin\s+v?(\S+)", out, re.M)
    return m.group(1) if m else None


def installed_version():
    # `uv tool list` is slow on a Pi Zero; remembered until a job finishes (installs/updates)
    return cached("sendspin_installed", 600, _installed_version, fail_ttl=15)


def _latest_version():
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/sendspin/json", timeout=8) as r:
            return json.load(r)["info"]["version"]
    except Exception:  # noqa: BLE001
        return None


def latest_version():
    return cached("sendspin_latest", 1800, _latest_version, fail_ttl=120)


def install_steps():
    return [[UV, "tool", "install", "--python", "3.13", "sendspin"]]


def upgrade_steps():
    return [[UV, "tool", "upgrade", "sendspin"], [("systemctl"), "try-restart", SERVICE]]


def service_state():
    # one systemctl call instead of two
    _, out, _ = run(["systemctl", "show", SERVICE, "-p", "ActiveState", "-p", "UnitFileState"])
    kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    return {"active": kv.get("ActiveState") or "unknown",
            "enabled": kv.get("UnitFileState") or "unknown"}


def service_action(action):
    if action not in ACTIONS:
        return 1, "bad action"
    args = ["systemctl"] + (["enable", "--now"] if action == "enable" else
                            ["disable", "--now"] if action == "disable" else [action])
    rc, out, err = run(args + [SERVICE], timeout=60)
    return rc, (out + err).strip()


def logs(n=80):
    rc, out, err = run(["journalctl", "-u", SERVICE, "-n", str(n), "--no-pager", "-o", "cat"])
    return out if rc == 0 else err


def pairing_line(text):
    for line in reversed(text.splitlines()):
        if "pairing" in line.lower() and "code" in line.lower():
            return line.strip()
    return None


PLAYBACK = os.path.join(SENDSPIN_HOME, "playback.json")   # written by hooks/state-hook.sh


def parse_connection(text):
    """Server the player is connected to (name, or "" if connected without a name), or None. Reads the daemon's log."""
    server = None
    for line in text.splitlines():
        m = re.search(r"(?:Admitted|Switching to) server '([^']*)'", line)
        if m:
            server = m.group(1)
        elif re.search(r"Server connected|Connected to ", line):
            server = "" if server is None else server
        elif re.search(r"Server '[^']*' disconnected|Disconnected from server|Daemon stopped|Starting Sendspin daemon", line):
            server = None
    return server


def _playback():
    rc, out, _ = run(["journalctl", "-u", SERVICE, "-n", "200", "--no-pager", "-o", "cat"])
    server = parse_connection(out) if rc == 0 else None
    state = None
    try:
        with open(PLAYBACK) as f:
            pb = json.load(f)
        state = pb.get("state")
        if state == "playing" and server is None and pb.get("server"):
            server = pb["server"]
    except (OSError, ValueError):
        pass
    if state not in ("playing", "idle"):
        state = None   # no hook data (older service file, or the player has not played since it started)
    return {"connected": server is not None, "server": server or None, "state": state}


def playback(svc=None):
    """Live player status: {connected, server, state: playing|idle|None}. Cheap enough to poll."""
    if (svc or service_state())["active"] != "active":
        return {"connected": False, "server": None, "state": None}
    return cached("sendspin_playback", 4, _playback)


def read_settings():
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


VOLFILE = os.path.join(SENDSPIN_HOME, "last-volume")
BT_FORMAT_MARKER = os.path.join(SENDSPIN_HOME, "bt-format")   # written by hooks/sendspin-player.py


def last_volume():
    """Volume (0-100) last applied through the Bluetooth volume script, or None."""
    try:
        with open(VOLFILE) as f:
            return max(0, min(100, int(f.read().strip())))
    except (OSError, ValueError):
        return None


def write_settings(**kw):
    s = read_settings()
    for k, v in kw.items():
        if v in (None, ""):
            s.pop(k, None)
        else:
            s[k] = v
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w") as f:
        json.dump(s, f, indent=2)
    try:
        shutil.chown(SETTINGS, SENDSPIN_USER, SENDSPIN_USER)
        shutil.chown(os.path.dirname(SETTINGS), SENDSPIN_USER, SENDSPIN_USER)
    except (LookupError, PermissionError, OSError):
        pass
    return s


HOOK = os.path.join(BASE, "hooks", "set-volume.sh")


def set_audio_device(dev):
    """Set the output device. Bluetooth (BlueALSA) outputs get the volume hook so
    Sendspin's volume drives the speaker; other outputs drop it."""
    return write_settings(audio_device=dev,
                          hook_set_volume=HOOK if (dev == "sendspin_bt" or dev.startswith("bluealsa")) else "")


def info():
    return {
        "installed": installed_version(),
        "service": service_state(),
        "settings": read_settings(),
    }
