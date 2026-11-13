"""Factory reset: put the Pi back to a fresh, un-set-up state (the admin login is kept)."""
import os
import threading
import time

from . import audio, bluetooth, config, sendspin_ctl, updates, util, wifi
from .util import run

CONFIG_KEYS = ("updates_scope", "updates_reboot", "updates_reboot_time",
               "previous_audio_device", "audio_type")


def factory_reset(forget_wifi=False):
    # 1. stop the player and keep it from starting until setup enables it again
    sendspin_ctl.service_action("disable")
    # 2. the player's own settings (name, audio output, volume, hook)
    try:
        os.remove(sendspin_ctl.SETTINGS)
    except OSError:
        pass
    # 3. Bluetooth speakers and our device definition
    bluetooth.forget_all()
    # 4. I2S DAC overlay (needs a restart to take effect)
    overlay_was_set = bool(audio.current_overlay())
    if overlay_was_set:
        audio.set_overlay("")
    # 5. automatic OS updates back to the system defaults
    try:
        os.remove(updates.APT_CONF)
    except OSError:
        pass
    # 6. SendspinPi's own settings (admin login and setup hotspot are kept)
    cfg = config.load()
    for k in CONFIG_KEYS:
        cfg.pop(k, None)
    cfg.update(setup_complete=False, selfupdate_auto=False, bluetooth_auto_reconnect=True)
    config.save(cfg)
    util.cache_clear()
    # 7. optionally forget saved WiFi networks, after the reply has gone out (it drops the connection)
    if forget_wifi:
        def forget():
            time.sleep(3)
            for name in wifi.saved():
                wifi.forget(name)
        threading.Thread(target=forget, daemon=True).start()
    return {"ok": True, "reboot_recommended": overlay_was_set, "forgot_wifi": bool(forget_wifi)}
