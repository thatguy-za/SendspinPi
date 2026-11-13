"""WiFi management via NetworkManager (nmcli) plus a fallback setup hotspot."""
import re
import threading
import time

from . import config
from .util import cached, run

HOTSPOT_CON = "SendspinPi-Setup"
HOTSPOT_IP = "10.42.0.1"
_scan_cache = []
_last_connect = {"state": "idle", "message": ""}
_connect_lock = threading.Lock()


def _split(line):
    """Split an nmcli -t line on unescaped ':'."""
    out, cur, i = [], "", 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur += line[i + 1]
            i += 2
            continue
        if c == ":":
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out


def _nm(fields, *args, timeout=30):
    rc, out, err = run(["nmcli", "-t", "-f", fields] + list(args), timeout=timeout)
    return rc, [_split(l) for l in out.splitlines() if l], err


def iface():
    _, rows, _ = _nm("DEVICE,TYPE", "dev")
    for d, t in rows:
        if t == "wifi":
            return d
    return None


def hotspot_active():
    _, rows, _ = _nm("NAME", "con", "show", "--active")
    return any(r[0] == HOTSPOT_CON for r in rows)


def active_connections():
    _, rows, _ = _nm("NAME,TYPE,DEVICE", "con", "show", "--active")
    return [{"name": n, "type": t, "device": d} for n, t, d in rows
            if t in ("802-11-wireless", "802-3-ethernet") and n != HOTSPOT_CON]


def ip_of(dev):
    rc, out, _ = run(["nmcli", "-g", "IP4.ADDRESS", "dev", "show", dev])
    return out.split()[0] if rc == 0 and out.split() else None


def saved():
    _, rows, _ = _nm("NAME,TYPE", "con", "show")
    return [r[0] for r in rows if len(r) > 1 and r[1] == "802-11-wireless" and r[0] != HOTSPOT_CON]


def status():
    dev = iface()
    act = active_connections()
    wifi_act = [a for a in act if a["type"] == "802-11-wireless"]
    return {
        "available": dev is not None,
        "iface": dev,
        "hotspot": hotspot_active() if dev else False,
        "hotspot_ssid": config.load()["hotspot_ssid"],
        "connections": [dict(a, ip=(ip_of(a["device"]) or "").split("/")[0] or None) for a in act],
        "current_ssid": wifi_act[0]["name"] if wifi_act else None,
        "saved": saved(),
        "last_connect": dict(_last_connect),
    }


def scan():
    global _scan_cache
    dev = iface()
    if not dev:
        return {"networks": [], "cached": False, "error": "No Wi-Fi interface found"}
    rc, rows, err = _nm("IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list",
                        "ifname", dev, "--rescan", "yes", timeout=40)
    best = {}
    for r in rows:
        if len(r) < 4 or not r[1]:
            continue
        sig = int(r[2]) if r[2].isdigit() else 0
        if r[1] not in best or sig > best[r[1]]["signal"]:
            best[r[1]] = {"ssid": r[1], "signal": sig, "security": r[3] or "open",
                          "in_use": r[0] == "*"}
    nets = sorted(best.values(), key=lambda n: -n["signal"])
    if nets:
        _scan_cache = nets
        return {"networks": nets, "cached": False}
    return {"networks": _scan_cache, "cached": True,
            "error": err.strip() or ("Showing networks seen before the setup hotspot started"
                                     if _scan_cache else None)}


def connect_async(ssid, password, hidden):
    """Runs in background: the caller may lose connectivity (hotspot -> home WiFi)."""
    if not _connect_lock.acquire(blocking=False):
        return False
    _last_connect.update(state="connecting", message="Connecting to %s…" % ssid)

    def work():
        try:
            dev = iface()
            had_hotspot = hotspot_active()
            if had_hotspot:
                time.sleep(2)  # give the browser time to receive the reply
                run(["nmcli", "con", "down", HOTSPOT_CON])
            existed = ssid in saved()
            args = ["nmcli", "-w", "40", "dev", "wifi", "connect", ssid]
            if password:
                args += ["password", password]
            if hidden:
                args += ["hidden", "yes"]
            if dev:
                args += ["ifname", dev]
            rc, out, err = run(args, timeout=60)
            if rc == 0:
                _last_connect.update(state="ok", message="Connected to %s" % ssid)
            else:
                if not existed:
                    run(["nmcli", "con", "delete", "id", ssid])
                _last_connect.update(state="failed",
                                     message=(err or out).strip() or "Connection failed")
                if had_hotspot and config.load()["hotspot_enabled"]:
                    start_hotspot()
        finally:
            _connect_lock.release()
    threading.Thread(target=work, daemon=True).start()
    return True


def forget(name):
    if name == HOTSPOT_CON or name not in saved():
        return False
    return run(["nmcli", "con", "delete", "id", name])[0] == 0


# ------------------------------------------------------------ hotspot
def start_hotspot():
    dev = iface()
    if not dev:
        return False
    if not _scan_cache:
        scan()
    cfg = config.load()
    run(["nmcli", "con", "delete", "id", HOTSPOT_CON])
    rc, _, _ = run(["nmcli", "con", "add", "type", "wifi", "ifname", dev, "con-name", HOTSPOT_CON,
                    "autoconnect", "no", "ssid", cfg["hotspot_ssid"], "mode", "ap",
                    "802-11-wireless.band", "bg", "ipv4.method", "shared",
                    "ipv4.addresses", HOTSPOT_IP + "/24",
                    "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", cfg["hotspot_psk"]])
    if rc != 0:
        return False
    return run(["nmcli", "con", "up", HOTSPOT_CON], timeout=40)[0] == 0


def stop_hotspot():
    run(["nmcli", "con", "down", HOTSPOT_CON])


def _stations(dev):
    rc, out, _ = run(["iw", "dev", dev, "station", "dump"])
    return sum(1 for l in out.splitlines() if l.startswith("Station")) if rc == 0 else 1


def _dev_state(dev):
    _, rows, _ = _nm("DEVICE,STATE", "dev")
    for d, s in rows:
        if d == dev:
            return s
    return ""


def hotspot_loop():
    """Fallback AP: start when offline after boot; periodically retry saved networks."""
    time.sleep(60)
    idle_since = None
    while True:
        try:
            cfg = config.load()
            dev = iface()
            if dev and cfg["hotspot_enabled"] and not _connect_lock.locked():
                active = hotspot_active()
                online = bool(active_connections())
                if active and online:  # ethernet came up; AP no longer needed
                    stop_hotspot()
                    active = False
                if not active and not online and not _dev_state(dev).startswith("connecting"):
                    start_hotspot()
                    idle_since = None
                elif active:
                    if _stations(dev) == 0:
                        idle_since = idle_since or time.time()
                        if time.time() - idle_since > 600 and saved():
                            stop_hotspot()  # let NetworkManager retry known networks
                            idle_since = None
                            time.sleep(45)
                    else:
                        idle_since = None
        except Exception:  # noqa: BLE001
            pass
        time.sleep(30)


def _signal_percent(dev):
    rc, out, _ = run(["iw", "dev", dev, "link"])
    m = re.search(r"signal:\s*(-?\d+)\s*dBm", out) if rc == 0 else None
    return max(0, min(100, 2 * (int(m.group(1)) + 100))) if m else None


def _summary():
    _, rows, _ = _nm("DEVICE,TYPE,STATE,CONNECTION", "dev")
    wifi_row = next((r for r in rows if len(r) >= 4 and r[1] == "wifi"), None)
    eth_row = next((r for r in rows if len(r) >= 4 and r[1] == "ethernet" and r[2].startswith("connected")), None)
    res = {"available": wifi_row is not None, "connected": False, "hotspot": False,
           "ssid": None, "ip": None, "signal": None, "ethernet": None}
    if wifi_row:
        dev, _, state, conn = wifi_row[:4]
        res["hotspot"] = conn == HOTSPOT_CON
        if state.startswith("connected") and not res["hotspot"]:
            res.update(connected=True, ssid=conn or None, ip=(ip_of(dev) or "").split("/")[0] or None, signal=_signal_percent(dev))
    if eth_row:
        res["ethernet"] = {"name": eth_row[3], "ip": (ip_of(eth_row[0]) or "").split("/")[0] or None}
    return res


def summary():
    """One quick look at the network for the Home page (remembered for a few seconds)."""
    return cached("wifi_summary", 8, _summary)
