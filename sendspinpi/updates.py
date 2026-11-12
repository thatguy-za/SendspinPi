"""Automatic (unattended) OS updates via the unattended-upgrades package."""
import os
import re

from . import config
from .util import run

APT_CONF = os.environ.get("SENDSPINPI_APT_CONF", "/etc/apt/apt.conf.d/99sendspinpi-unattended")
LOG = "/var/log/unattended-upgrades/unattended-upgrades.log"
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SECURITY = [
    "origin=Debian,codename=${distro_codename}-security,label=Debian-Security",
]
EVERYTHING = SECURITY + [
    "origin=Debian,codename=${distro_codename},label=Debian",
    "origin=Debian,codename=${distro_codename}-updates,label=Debian",
    "origin=Raspberry Pi Foundation,codename=${distro_codename}",
    "origin=Raspbian,codename=${distro_codename},label=Raspbian",
]


def installed():
    return run(["dpkg", "-s", "unattended-upgrades"])[0] == 0


def _effective_enabled():
    rc, out, _ = run(["apt-config", "dump", "APT::Periodic::Unattended-Upgrade"])
    m = re.search(r'Unattended-Upgrade "(\d+)"', out)
    return bool(m and m.group(1) != "0")


def _settings():
    cfg = config.load()
    return {"scope": cfg.get("updates_scope", "security"),
            "reboot": bool(cfg.get("updates_reboot", False)),
            "reboot_time": cfg.get("updates_reboot_time", "04:00")}


def last_activity():
    """Plain-language summary of the most recent unattended run."""
    try:
        with open(LOG, errors="replace") as f:
            lines = f.read().splitlines()[-200:]
    except OSError:
        return {"when": None, "summary": "Hasn't run yet", "level": "idle", "tail": ""}
    summary, level, when = "Hasn't run yet", "idle", None
    for line in reversed(lines):
        m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", line)
        low = line.lower()
        if "all upgrades installed" in low:
            summary, level = "Installed updates", "ok"
        elif "no packages found that can be upgraded" in low:
            summary, level = "Everything was already up to date", "ok"
        elif " error" in low or "failed" in low:
            summary, level = "There was a problem (see details)", "bad"
        else:
            continue
        when = m.group(1) if m else None
        break
    return {"when": when, "summary": summary, "level": level, "tail": "\n".join(lines[-30:])}


def status():
    st = {"installed": installed(), "enabled": _effective_enabled(), "last": last_activity()}
    st.update(_settings())
    st["reboot_required"] = os.path.exists("/var/run/reboot-required")
    return st


def _render(enabled, scope, reboot, reboot_time):
    patterns = EVERYTHING if scope == "all" else SECURITY
    lines = [
        "// Managed by SendspinPi - changes here are overwritten.",
        'APT::Periodic::Update-Package-Lists "1";',
        'APT::Periodic::Unattended-Upgrade "%d";' % (1 if enabled else 0),
        "#clear Unattended-Upgrade::Allowed-Origins;",
        "#clear Unattended-Upgrade::Origins-Pattern;",
        "Unattended-Upgrade::Origins-Pattern {",
    ] + ['  "%s";' % p for p in patterns] + [
        "};",
        'Unattended-Upgrade::Remove-Unused-Dependencies "true";',
        'Unattended-Upgrade::Automatic-Reboot "%s";' % ("true" if reboot else "false"),
        'Unattended-Upgrade::Automatic-Reboot-WithUsers "true";',
        'Unattended-Upgrade::Automatic-Reboot-Time "%s";' % reboot_time,
        "",
    ]
    return "\n".join(lines)


def apply(enabled, scope, reboot, reboot_time):
    """Returns an error string or None."""
    if scope not in ("security", "all"):
        return "Invalid update type"
    if not TIME_RE.match(reboot_time):
        return "Invalid restart time"
    if not installed():
        return "The unattended-upgrades package is missing. Re-run the installer."
    tmp = APT_CONF + ".tmp"
    with open(tmp, "w") as f:
        f.write(_render(enabled, scope, reboot, reboot_time))
    os.replace(tmp, APT_CONF)
    config.update(updates_scope=scope, updates_reboot=reboot, updates_reboot_time=reboot_time)
    run(["systemctl", "enable", "--now", "apt-daily.timer", "apt-daily-upgrade.timer"])
    return None


def run_now_steps():
    return [["unattended-upgrade", "-v"]]
