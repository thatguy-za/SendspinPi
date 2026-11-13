"""Audio output discovery, I2S DAC overlays and test tone."""
import os
import re

from . import sendspin_ctl
from .util import run

# Overlays for common I2S DAC HATs (name -> label).
OVERLAYS = {
    "hifiberry-dac": "HiFiBerry DAC / DAC Light",
    "hifiberry-dacplus": "HiFiBerry DAC+ / DAC+ Pro",
    "hifiberry-dacplusadc": "HiFiBerry DAC+ ADC",
    "hifiberry-digi": "HiFiBerry Digi / Digi+",
    "hifiberry-amp": "HiFiBerry Amp / Amp+",
    "iqaudio-dac": "IQaudIO DAC",
    "iqaudio-dacplus": "IQaudIO DAC+ / Pi-DAC+",
    "justboom-dac": "JustBoom DAC / Amp",
    "justboom-digi": "JustBoom Digi",
    "allo-boss-dac-pcm512x-audio": "Allo Boss DAC",
    "allo-piano-dac-pcm512x-audio": "Allo Piano DAC",
    "allo-digione": "Allo DigiOne",
    "audioinjector-wm8731-audio": "AudioInjector Zero/Stereo",
    "pcm5102a": "Generic PCM5102A (GY-PCM5102)",
    "merus-amp": "Merus Amp",
}
BEGIN, END = "# sendspinpi-dac begin", "# sendspinpi-dac end"


def config_txt():
    for p in ("/boot/firmware/config.txt", "/boot/config.txt"):
        if os.path.exists(p):
            return p
    return None


def current_overlay():
    p = config_txt()
    if not p:
        return None
    try:
        text = open(p).read()
    except OSError:
        return None
    m = re.search(re.escape(BEGIN) + r"\ndtoverlay=(\S+)", text)
    return m.group(1) if m else None


def set_overlay(name):
    """name '' removes the managed block. Returns error string or None. Reboot required."""
    p = config_txt()
    if not p:
        return "config.txt not found (not a Raspberry Pi?)"
    if name and name not in OVERLAYS:
        return "unknown overlay"
    text = open(p).read()
    bak = p + ".sendspinpi.bak"
    if not os.path.exists(bak):
        open(bak, "w").write(text)
    text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S)
    text = text.rstrip("\n") + "\n"
    if name:
        text += "[all]\n%s\ndtoverlay=%s\ndtparam=audio=off\n%s\n" % (BEGIN, name, END)
    open(p, "w").write(text)
    return None


def cards():
    rc, out, err = run(["aplay", "-l"])
    res = []
    for line in out.splitlines():
        m = re.match(r"card (\d+): (\S+) \[(.*?)\], device (\d+): (.*?) \[(.*?)\]", line)
        if m:
            cid, short, longname, dev, _, devname = m.groups()
            res.append({"card": int(cid), "id": short, "name": longname, "device": int(dev),
                        "label": "%s – %s" % (longname, devname),
                        "alsa": "plughw:CARD=%s,DEV=%s" % (short, dev)})
    return {"cards": res, "error": err.strip() if rc != 0 else None}


def sendspin_devices():
    if not os.path.exists(sendspin_ctl.BIN):
        return "sendspin is not installed yet."
    rc, out, err = run(["runuser", "-u", sendspin_ctl.SENDSPIN_USER, "--",
                        "env", "HOME=" + sendspin_ctl.SENDSPIN_HOME, sendspin_ctl.BIN,
                        "audio-devices", "list"], timeout=30)
    return (out + err).strip()


_DEVICE_RE = re.compile(r"^[A-Za-z0-9_:=,.\-]{1,80}$")


def valid_device(dev):
    return bool(_DEVICE_RE.match(dev))


def test_tone_steps(device):
    """Pause the player (it may hold the device), play a short tone, resume."""
    state = sendspin_ctl.service_state()["active"]
    steps = []
    if state == "active":
        steps.append(["systemctl", "stop", sendspin_ctl.SERVICE])
    cmd = ["speaker-test", "-t", "sine", "-f", "440", "-c", "2", "-l", "1"]
    if device:
        cmd += ["-D", device]
    # Run as the same user as the player so the test reflects what the player can do
    # (permissions on the sound card / Bluetooth service differ from root's).
    steps.append(["runuser", "-u", sendspin_ctl.SENDSPIN_USER, "--", "timeout", "8"] + cmd)
    if state == "active":
        steps.append(["systemctl", "start", sendspin_ctl.SERVICE])
    return steps
