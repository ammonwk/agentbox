#!/bin/bash
# The org store's proxy (docs/org.md "The tailnet"): run as root on plaibook-ssm-jump, the
# host in the VPC whose NAT addresses Atlas admits. It joins the team tailnet as atlas-proxy
# and serves SOCKS5 on its tailnet address, port 1080, to the members of the cluster the store is on (production's, rmplanner) only.
#   atlas-proxy.sh <headscale pre-auth key, tagged tag:atlas-proxy>
# Run again to update the proxy; the key is then not used and may be anything.
set -euo pipefail
KEY=$1
if ! command -v tailscale >/dev/null; then
  curl -fsSL -o /etc/yum.repos.d/tailscale.repo https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo
  dnf install -y tailscale
  systemctl enable --now tailscaled
fi
tailscale status >/dev/null 2>&1 || tailscale up --login-server https://headscale.plaibook.tech --authkey "$KEY" --hostname atlas-proxy
mkdir -p /opt/atlas-proxy
cat > /opt/atlas-proxy/socks.py <<'PY'
"""SOCKS5, no auth, CONNECT by name to the store's Atlas cluster's members only (rmplanner)."""
import asyncio, re, struct, sys

ALLOWED = re.compile(r"^[a-z0-9-]+\.ofldod7\.mongodb\.net$")


async def pipe(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data:
                break
            w.write(data)
            await w.drain()
    except OSError:
        pass
    finally:
        w.close()


async def serve(r, w):
    try:
        ver, n = await r.readexactly(2)
        await r.readexactly(n)
        w.write(b"\x05\x00")
        ver, cmd, _, atyp = await r.readexactly(4)
        if atyp != 3:
            raise ValueError("not by name")
        host = (await r.readexactly((await r.readexactly(1))[0])).decode().lower()
        port = struct.unpack("!H", await r.readexactly(2))[0]
        if ver != 5 or cmd != 1 or port != 27017 or not ALLOWED.match(host):
            raise ValueError(f"refused {host}:{port}")
        ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 15)
    except Exception as e:
        print("atlas-proxy:", w.get_extra_info("peername"), repr(e), file=sys.stderr, flush=True)
        w.write(b"\x05\x02\x00\x01" + bytes(6))
        w.close()
        return
    w.write(b"\x05\x00\x00\x01" + bytes(6))
    await asyncio.gather(pipe(r, uw), pipe(ur, w))


async def main():
    server = await asyncio.start_server(serve, sys.argv[1], 1080)
    async with server:
        await server.serve_forever()

asyncio.run(main())
PY
cat > /etc/systemd/system/atlas-proxy.service <<'UNIT'
[Unit]
Description=SOCKS5 to the org store's Atlas cluster on the tailnet (agentbox docs/org.md)
After=tailscaled.service
Wants=tailscaled.service

[Service]
ExecStartPre=/bin/sh -c 'until tailscale ip -4; do sleep 2; done'
ExecStart=/bin/sh -c 'exec python3 /opt/atlas-proxy/socks.py "$(tailscale ip -4)"'
DynamicUser=yes
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable atlas-proxy
systemctl restart atlas-proxy
sleep 2
systemctl is-active atlas-proxy
tailscale ip -4
