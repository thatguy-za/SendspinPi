"""Install/upgrade/configure the sendspin daemon and its systemd unit."""
import json
import os
import re
import shutil
import urllib.request

from .util import run

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


def installed_version():
    rc, out, _ = run([UV, "tool", "list"], env=UV_ENV)
    if rc != 0:
        return None
    m = re.search(r"^sendspin\s+v?(\S+)", out, re.M)
    return m.group(1) if m else None


def latest_version():
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/sendspin/json", timeout=8) as r:
            return json.load(r)["info"]["version"]
    except Exception:  # noqa: BLE001
        return None


def install_steps():
    return [[UV, "tool", "install", "--python", "3.13", "sendspin"]]


def upgrade_steps():
    return [[UV, "tool", "upgrade", "sendspin"], [("systemctl"), "try-restart", SERVICE]]


def service_state():
    _, active, _ = run(["systemctl", "is-active", SERVICE])
    _, enabled, _ = run(["systemctl", "is-enabled", SERVICE])
    return {"active": active.strip() or "unknown", "enabled": enabled.strip() or "unknown"}


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


def read_settings():
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


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
