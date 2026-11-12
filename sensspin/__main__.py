import sys

from . import config

if len(sys.argv) > 1 and sys.argv[1] == "init":
    user, pw, psk = config.init(reset_password="--reset-password" in sys.argv)
    print("USERNAME=%s" % user)
    print("PASSWORD=%s" % (pw or ""))
    print("HOTSPOT_SSID=%s" % config.load()["hotspot_ssid"])
    print("HOTSPOT_PSK=%s" % psk)
else:
    from . import server
    server.main()
