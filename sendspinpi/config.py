"""Persistent config + password hashing."""
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading

CONF_DIR = os.environ.get("SENDSPINPI_CONF_DIR", "/etc/sendspinpi")
CONF_FILE = os.path.join(CONF_DIR, "config.json")
_lock = threading.Lock()
ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

DEFAULTS = {
    "username": "admin",
    "password_hash": "",
    "port": 80,
    "setup_complete": False,
    "hotspot_enabled": True,
    "bluetooth_auto_reconnect": True,
    "selfupdate_auto": False,
    "bt_native_volume": False,
    "hotspot_ssid": "SendspinPi-Setup",
    "hotspot_psk": "",
}


def random_password(n=12):
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def hash_password(pw, salt=None, iters=200_000):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), iters).hex()
    return "pbkdf2$%d$%s$%s" % (iters, salt, dk)


def verify_password(pw, stored):
    try:
        _, iters, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(iters)).hex()
        return hmac.compare_digest(calc, dk)
    except Exception:  # noqa: BLE001
        return False


def load():
    with _lock:
        cfg = dict(DEFAULTS)
        try:
            with open(CONF_FILE) as f:
                cfg.update(json.load(f))
        except (OSError, ValueError):
            pass
        return cfg


def save(cfg):
    with _lock:
        os.makedirs(CONF_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=CONF_DIR)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONF_FILE)


def update(**kw):
    cfg = load()
    cfg.update(kw)
    save(cfg)
    return cfg


def init(reset_password=False, password=None):
    """Create config on first install. Returns (username, generated_password|None, hotspot_psk).
    A user-supplied password is stored but never returned."""
    cfg = load()
    pw = None
    if reset_password or not cfg["password_hash"]:
        if password and len(password) >= 8:
            cfg["password_hash"] = hash_password(password)
        else:
            pw = random_password()
            cfg["password_hash"] = hash_password(pw)
        cfg["username"] = cfg["username"] or "admin"
    if not cfg["hotspot_psk"]:
        cfg["hotspot_psk"] = random_password(10)
    save(cfg)
    return cfg["username"], pw, cfg["hotspot_psk"]
