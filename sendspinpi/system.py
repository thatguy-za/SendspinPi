"""OS info, apt updates and power control."""
import os
import re
import shutil
import threading
import time

from .util import run

APT_ENV = {"DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "a"}
LOCK = ["-o", "DPkg::Lock::Timeout=180"]


def _read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def info():
    mem = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) if v.split() else 0
    temp = _read("/sys/class/thermal/thermal_zone0/temp")
    osr = dict(l.split("=", 1) for l in _read("/etc/os-release").splitlines() if "=" in l)
    try:
        du = shutil.disk_usage("/")
        disk = {"total": du.total, "free": du.free}
    except OSError:
        disk = None
    up = _read("/proc/uptime", "0 0").split()[0]
    _, ips, _ = run(["hostname", "-I"])
    return {
        "hostname": _read("/etc/hostname"),
        "model": _read("/proc/device-tree/model").strip("\x00"),
        "os": osr.get("PRETTY_NAME", "").strip('"'),
        "kernel": os.uname().release,
        "uptime_s": int(float(up)),
        "mem_total_kb": mem.get("MemTotal"),
        "mem_avail_kb": mem.get("MemAvailable"),
        "cpu_temp_c": round(int(temp) / 1000, 1) if temp.isdigit() else None,
        "disk": disk,
        "ips": ips.split(),
        "reboot_required": os.path.exists("/var/run/reboot-required"),
    }


def apt_update_steps():
    return [["apt-get", "update"] + LOCK]


def upgradable():
    rc, out, err = run(["apt", "list", "--upgradable"])
    pk = []
    for line in out.splitlines():
        m = re.match(r"(\S+?)/(\S+) (\S+) (\S+) \[upgradable from: (\S+)\]", line)
        if m:
            pk.append({"name": m.group(1), "new": m.group(3), "old": m.group(5)})
    return pk


def apt_upgrade_steps():
    return [["apt-get", "update"] + LOCK,
            ["apt-get", "-y", "-o", "Dpkg::Options::=--force-confold",
             "-o", "Dpkg::Options::=--force-confdef", "full-upgrade"] + LOCK,
            ["apt-get", "-y", "autoremove"] + LOCK]


def power(action):
    cmd = {"reboot": "reboot", "shutdown": "poweroff"}[action]

    def go():
        time.sleep(2)  # let the HTTP response go out first
        run(["systemctl", cmd], timeout=30)
    threading.Thread(target=go, daemon=True).start()
