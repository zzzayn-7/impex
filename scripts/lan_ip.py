#!/usr/bin/env python3
"""Print this computer's LAN address (the one a phone on the same Wi-Fi would use), for the local HTTPS proxy.

    python scripts/lan_ip.py

It does not send any data: it only asks the operating system which local address it would use to reach the internet, which
is the Wi-Fi / Ethernet address (not a Docker or WSL one such as 172.x). Then:

    1. put  LAN_HOST=<that address>  in .env
    2. docker compose --profile https up -d --force-recreate https-proxy
    3. open  https://<that address>:3443  on the phone (after installing the local root certificate, see docs/scanning.md)
"""
import ipaddress
import socket
import sys


def lan_address() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect(("203.0.113.1", 9))  # a documentation-only address: UDP connect() sends nothing, it only selects a route
        return probe.getsockname()[0]


def main() -> int:
    try:
        address = lan_address()
    except OSError:
        print("Could not find a network address. Are you connected to Wi-Fi or Ethernet?", file=sys.stderr)
        return 1
    note = ""
    if not ipaddress.ip_address(address).is_private:
        note = "  (this is not a private LAN address: check that you are on your local network)"
    if address.startswith(("172.17.", "172.18.", "172.19.", "169.254.")):
        note = "  (this looks like a Docker/virtual address, not your Wi-Fi: find the real one with ipconfig)"
    print(f"LAN_HOST={address}{note}")
    print(f"Phone URL once the proxy is running: https://{address}:3443")
    return 0


if __name__ == "__main__":
    sys.exit(main())
