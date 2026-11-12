"""Update SendspinPi itself from its tagged GitHub releases."""
import json
import os
import re
import threading
import time
import urllib.request

from . import __version__, config
from .util import run

REPO = "thatguy-za/SendspinPi"
LOG = os.environ.get("SENDSPINPI_UPDATE_LOG", "/var/log/sendspinpi-update.log")
UNIT = "sendspinpi-update"
TAG_RE = re.compile(r"^v?\d+\.\d+\.\d+$")
_cache = {"at": 0.0, "latest": None, "error": None}
_lock = threading.Lock()


def _ver(tag):
    return tuple(int(x) for x in tag.lstrip("v").split("."))


def latest(force=False):
    """Latest release tag (cached for 10 minutes). Returns (tag|None, error|None)."""
    with _lock:
        if not force and time.time() - _cache["at"] < 600:
            return _cache["latest"], _cache["error"]
        tag, err = None, None
        try:
            req = urllib.request.Request(
                "https://api.github.com/repos/%s/releases/latest" % REPO,
                headers={"User-Agent": "SendspinPi", "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=8) as r:
                tag = json.load(r).get("tag_name")
            if not tag or not TAG_RE.match(tag):
                tag, err = None, "No releases published yet"
        except urllib.error.HTTPError as e:
            err = "No releases published yet" if e.code == 404 else "Could not check (HTTP %d)" % e.code
        except Exception:  # noqa: BLE001
            err = "Could not reach GitHub"
        _cache.update(at=time.time(), latest=tag, error=err)
        return tag, err


def status(force=False):
    tag, err = latest(force)
    avail = bool(tag and _ver(tag) > _ver(__version__))
    return {"current": __version__, "latest": tag.lstrip("v") if tag else None,
            "available": avail, "error": err, "auto": config.load()["selfupdate_auto"],
            "updating": run(["systemctl", "is-active", UNIT])[1].strip() == "active"}


def start_update(tag=None):
    """Run the installer in its own systemd unit so it survives our own restart."""
    tag = tag or latest(True)[0]
    if not tag or not TAG_RE.match(tag):
        return "No release available to install"
    if status()["updating"]:
        return "An update is already running"
    script = ("set -e; echo \"== SendspinPi update to %(t)s: $(date)\"; "
              "curl -fsSL https://raw.githubusercontent.com/%(r)s/%(t)s/install.sh "
              "| SENDSPINPI_REF=%(t)s bash") % {"t": tag, "r": REPO}
    rc, out, err = run(["systemd-run", "--unit=" + UNIT, "--collect",
                        "-p", "StandardOutput=append:" + LOG, "-p", "StandardError=append:" + LOG,
                        "bash", "-c", script])
    return None if rc == 0 else (err or out).strip() or "Could not start the update"


def log_tail(n=40):
    try:
        with open(LOG, errors="replace") as f:
            return "".join(f.readlines()[-n:])
    except OSError:
        return ""


def auto_loop():
    """If enabled, install new releases (checked every 6 hours)."""
    time.sleep(600)
    while True:
        try:
            if config.load()["selfupdate_auto"]:
                st = status(force=True)
                if st["available"] and not st["updating"]:
                    start_update("v" + st["latest"])
        except Exception:  # noqa: BLE001
            pass
        time.sleep(6 * 3600)
