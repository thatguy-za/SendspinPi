"""Tiny stdlib HTTP server: static UI + JSON API."""
import json
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import audio, bluetooth, config, selfupdate, sendspin_ctl, system, updates, util, wifi

STATIC = os.path.join(os.path.dirname(__file__), "static")
FILES = {"/": ("index.html", "text/html; charset=utf-8"),
         "/app.js": ("app.js", "application/javascript; charset=utf-8"),
         "/style.css": ("style.css", "text/css; charset=utf-8")}
SESSION_TTL = 12 * 3600
_sessions = {}          # token -> expiry
_fails = {}             # ip -> [count, first_ts]
_slock = threading.Lock()
ROUTES = {}


def route(method, path, auth=True):
    def deco(fn):
        ROUTES[(method, path)] = (fn, auth)
        return fn
    return deco


class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


# ------------------------------------------------------------------ auth
@route("POST", "/api/login", auth=False)
def login(h, q, body):
    ip = h.client_address[0]
    with _slock:
        cnt, first = _fails.get(ip, [0, time.time()])
        if time.time() - first > 300:
            cnt, first = 0, time.time()
        if cnt >= 5:
            raise ApiError("Too many attempts, wait a few minutes", 429)
    cfg = config.load()
    ok = (secrets.compare_digest(str(body.get("username", "")), cfg["username"]) &
          config.verify_password(str(body.get("password", "")), cfg["password_hash"]))
    if not ok:
        with _slock:
            _fails[ip] = [cnt + 1, first]
        time.sleep(1)
        raise ApiError("Wrong username or password", 401)
    with _slock:
        _fails.pop(ip, None)
        tok = secrets.token_urlsafe(32)
        _sessions[tok] = time.time() + SESSION_TTL
    h.set_cookie = "session=%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=%d" % (tok, SESSION_TTL)
    return {"ok": True}


@route("POST", "/api/logout", auth=False)
def logout(h, q, body):
    tok = h.session_token()
    with _slock:
        _sessions.pop(tok, None)
    h.set_cookie = "session=; Max-Age=0; Path=/"
    return {"ok": True}


@route("POST", "/api/account")
def account(h, q, body):
    cfg = config.load()
    if not config.verify_password(str(body.get("current_password", "")), cfg["password_hash"]):
        raise ApiError("Current password is incorrect", 403)
    user = str(body.get("username", "")).strip() or cfg["username"]
    if not (1 <= len(user) <= 32) or not user.isprintable():
        raise ApiError("Username must be 1-32 characters")
    new = str(body.get("new_password", ""))
    if new:
        if len(new) < 8:
            raise ApiError("Password must be at least 8 characters")
        cfg["password_hash"] = config.hash_password(new)
    cfg["username"] = user
    config.save(cfg)
    if new:  # invalidate other sessions
        with _slock:
            keep = h.session_token()
            for t in list(_sessions):
                if t != keep:
                    del _sessions[t]
    return {"ok": True, "username": user}


# ---------------------------------------------------------------- status
@route("GET", "/api/status")
def status(h, q, body):
    cfg = config.load()
    return {"username": cfg["username"], "setup_complete": cfg["setup_complete"],
            "system": system.info(), "sendspin": sendspin_ctl.info(),
            "job": util.active_job()}


@route("GET", "/api/job")
def job(h, q, body):
    st = util.job_state(q.get("id", ""), int(q.get("since", "0") or 0))
    if not st:
        raise ApiError("Unknown job", 404)
    return st


def _start(title, steps, env=None):
    try:
        return {"job": util.start_job(title, steps, env)}
    except util.Busy:
        raise ApiError("Another task is already running", 409)


# --------------------------------------------------------------- sendspin
@route("GET", "/api/sendspin/versions")
def versions(h, q, body):
    return {"installed": sendspin_ctl.installed_version(),
            "latest": sendspin_ctl.latest_version()}


@route("POST", "/api/sendspin/install")
def sp_install(h, q, body):
    return _start("Install Sendspin", sendspin_ctl.install_steps(), sendspin_ctl.UV_ENV)


@route("POST", "/api/sendspin/upgrade")
def sp_upgrade(h, q, body):
    return _start("Upgrade Sendspin", sendspin_ctl.upgrade_steps(), sendspin_ctl.UV_ENV)


@route("POST", "/api/sendspin/service")
def sp_service(h, q, body):
    rc, msg = sendspin_ctl.service_action(str(body.get("action", "")))
    if rc != 0:
        raise ApiError(msg or "Failed")
    return {"ok": True, "service": sendspin_ctl.service_state()}


@route("POST", "/api/sendspin/config")
def sp_config(h, q, body):
    kw = {}
    if "name" in body:
        name = str(body["name"]).strip()
        if len(name) > 64 or not name.isprintable():
            raise ApiError("Invalid name")
        kw["name"] = name
    if "audio_device" in body:
        dev = str(body["audio_device"]).strip()
        if dev and not audio.valid_device(dev):
            raise ApiError("Invalid audio device")
        sendspin_ctl.set_audio_device(dev)
    if kw:
        sendspin_ctl.write_settings(**kw)
    restarted = False
    if sendspin_ctl.service_state()["active"] == "active":
        sendspin_ctl.service_action("restart")
        restarted = True
    return {"ok": True, "restarted": restarted, "settings": sendspin_ctl.read_settings()}


@route("GET", "/api/sendspin/logs")
def sp_logs(h, q, body):
    text = sendspin_ctl.logs(int(q.get("n", "80")))
    return {"logs": text, "pairing": sendspin_ctl.pairing_line(sendspin_ctl.logs(300))}


@route("POST", "/api/setup/complete")
def setup_complete(h, q, body):
    config.update(setup_complete=bool(body.get("complete", True)))
    return {"ok": True}


# ------------------------------------------------------------------ audio
@route("GET", "/api/audio")
def audio_info(h, q, body):
    res = audio.cards()
    res.update(overlays=audio.OVERLAYS, overlay=audio.current_overlay(),
               selected=sendspin_ctl.read_settings().get("audio_device", ""),
               sendspin_devices=audio.sendspin_devices() if q.get("raw") else None)
    return res


@route("POST", "/api/audio/overlay")
def audio_overlay(h, q, body):
    err = audio.set_overlay(str(body.get("overlay", "")))
    if err:
        raise ApiError(err)
    return {"ok": True, "reboot_required": True}


@route("POST", "/api/audio/test")
def audio_test(h, q, body):
    dev = str(body.get("device", "")).strip()
    if dev and not audio.valid_device(dev):
        raise ApiError("Invalid audio device")
    return _start("Test tone", audio.test_tone_steps(dev))


# ----------------------------------------------------------------- system
@route("GET", "/api/system/upgradable")
def upgradable(h, q, body):
    return {"packages": system.upgradable()}


@route("POST", "/api/system/apt-update")
def apt_update(h, q, body):
    return _start("Refresh package lists", system.apt_update_steps(), system.APT_ENV)


@route("POST", "/api/system/apt-upgrade")
def apt_upgrade(h, q, body):
    return _start("Upgrade OS packages", system.apt_upgrade_steps(), system.APT_ENV)


@route("GET", "/api/updates")
def updates_status(h, q, body):
    return updates.status()


@route("POST", "/api/updates")
def updates_save(h, q, body):
    cur = updates.status()
    err = updates.apply(bool(body.get("enabled", cur["enabled"])),
                        str(body.get("scope", cur["scope"])),
                        bool(body.get("reboot", cur["reboot"])),
                        str(body.get("reboot_time", cur["reboot_time"])))
    if err:
        raise ApiError(err)
    return updates.status()


@route("POST", "/api/updates/run")
def updates_run(h, q, body):
    return _start("Install updates now", updates.run_now_steps(), system.APT_ENV)


@route("GET", "/api/selfupdate")
def selfupdate_status(h, q, body):
    return selfupdate.status(force=bool(q.get("check")))


@route("POST", "/api/selfupdate")
def selfupdate_save(h, q, body):
    config.update(selfupdate_auto=bool(body.get("auto")))
    return selfupdate.status()


@route("POST", "/api/selfupdate/run")
def selfupdate_run(h, q, body):
    err = selfupdate.start_update()
    if err:
        raise ApiError(err)
    return {"ok": True}


@route("GET", "/api/selfupdate/log")
def selfupdate_log(h, q, body):
    return {"log": selfupdate.log_tail(), "version": selfupdate.__version__}


@route("POST", "/api/power")
def power(h, q, body):
    action = body.get("action")
    if action not in ("reboot", "shutdown"):
        raise ApiError("Bad action")
    system.power(action)
    return {"ok": True}


# ------------------------------------------------------------------- wifi
@route("GET", "/api/wifi")
def wifi_status(h, q, body):
    return wifi.status()


@route("GET", "/api/wifi/scan")
def wifi_scan(h, q, body):
    return wifi.scan()


@route("POST", "/api/wifi/connect")
def wifi_connect(h, q, body):
    ssid = str(body.get("ssid", ""))
    pw = str(body.get("password", ""))
    if not ssid or len(ssid.encode()) > 32:
        raise ApiError("Invalid SSID")
    if pw and not (8 <= len(pw) <= 63):
        raise ApiError("WiFi password must be 8-63 characters")
    if not wifi.connect_async(ssid, pw, bool(body.get("hidden"))):
        raise ApiError("A connection attempt is already in progress", 409)
    return {"ok": True}


@route("POST", "/api/wifi/forget")
def wifi_forget(h, q, body):
    if not wifi.forget(str(body.get("name", ""))):
        raise ApiError("Could not forget network")
    return {"ok": True}


# -------------------------------------------------------------- bluetooth
def _mac(body):
    mac = bluetooth.norm(body.get("mac", ""))
    if not mac:
        raise ApiError("Invalid Bluetooth address")
    return mac


@route("GET", "/api/bluetooth")
def bt_status(h, q, body):
    return bluetooth.status()


@route("POST", "/api/bluetooth/scan")
def bt_scan(h, q, body):
    return {"devices": bluetooth.scan()}


@route("POST", "/api/bluetooth/pair")
def bt_pair(h, q, body):
    return _start("Pair Bluetooth speaker", bluetooth.pair_steps(_mac(body)))


@route("POST", "/api/bluetooth/connect")
def bt_connect(h, q, body):
    ok, msg = bluetooth.connect(_mac(body))
    if not ok:
        raise ApiError(msg or "Could not connect")
    return {"ok": True}


@route("POST", "/api/bluetooth/disconnect")
def bt_disconnect(h, q, body):
    bluetooth.disconnect(_mac(body))
    return {"ok": True}


@route("POST", "/api/bluetooth/forget")
def bt_forget(h, q, body):
    ok, msg = bluetooth.forget(_mac(body))
    if not ok:
        raise ApiError(msg or "Could not remove device")
    return {"ok": True}


@route("POST", "/api/bluetooth/auto")
def bt_auto(h, q, body):
    config.update(bluetooth_auto_reconnect=bool(body.get("enabled")))
    return {"ok": True}


@route("POST", "/api/bluetooth/use")
def bt_use(h, q, body):
    if body.get("mac"):
        bluetooth.use(_mac(body))
    else:
        bluetooth.unuse()
    return {"ok": True, "selected": bluetooth.selected_mac()}


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    server_version = "SendspinPi"
    protocol_version = "HTTP/1.1"
    set_cookie = None

    def log_message(self, *a):
        pass

    def session_token(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c["session"].value if "session" in c else ""

    def authed(self):
        tok = self.session_token()
        with _slock:
            exp = _sessions.get(tok)
            if exp and exp > time.time():
                return True
            _sessions.pop(tok, None)
        return False

    def _send(self, status, data, ctype="application/json", extra=None):
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if self.set_cookie:
            self.send_header("Set-Cookie", self.set_cookie)
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        self.set_cookie = None
        u = urlparse(self.path)
        if method == "GET" and u.path in FILES:
            name, ctype = FILES[u.path]
            with open(os.path.join(STATIC, name), "rb") as f:
                return self._send(200, f.read(), ctype)
        entry = ROUTES.get((method, u.path))
        if not entry:
            return self._send(404, {"error": "Not found"})
        fn, needs_auth = entry
        try:
            if method == "POST" and self.headers.get("X-Requested-With") != "sendspinpi":
                raise ApiError("Bad request", 403)
            if needs_auth and not self.authed():
                raise ApiError("Not logged in", 401)
            body = {}
            if method == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                if n > 65536:
                    raise ApiError("Body too large", 413)
                if n:
                    try:
                        body = json.loads(self.rfile.read(n))
                    except ValueError:
                        raise ApiError("Invalid JSON")
                    if not isinstance(body, dict):
                        raise ApiError("Invalid JSON")
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            self._send(200, fn(self, q, body))
        except ApiError as e:
            self._send(e.status, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": "Internal error: %s" % e})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def main():
    cfg = config.load()
    if not cfg["password_hash"]:
        config.init()
    port = int(os.environ.get("SENDSPINPI_PORT", cfg["port"]))
    threading.Thread(target=wifi.hotspot_loop, daemon=True).start()
    threading.Thread(target=bluetooth.watchdog_loop, daemon=True).start()
    threading.Thread(target=selfupdate.auto_loop, daemon=True).start()
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("", port), Handler).serve_forever()
