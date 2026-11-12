import sys

from . import config

if len(sys.argv) > 1 and sys.argv[1] == "init":
    import os
    user, pw, psk = config.init(reset_password="--reset-password" in sys.argv,
                                password=os.environ.get("SENDSPINPI_PASSWORD") or None)
    print("USERNAME=%s" % user)
    print("PASSWORD=%s" % (pw or ""))
    print("HOTSPOT_SSID=%s" % config.load()["hotspot_ssid"])
    print("HOTSPOT_PSK=%s" % psk)
else:
    from . import server
    server.main()
