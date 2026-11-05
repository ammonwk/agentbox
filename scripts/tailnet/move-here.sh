#!/bin/bash
# Move this machine onto the team tailnet (docs/org.md "The tailnet"), keeping the personal
# Tailscale account as a second profile: `sudo tailscale switch ammonwk@gmail.com` goes back.
# Needs sudo: the operator setting is per profile, so the old profile's operator cannot log
# the new one in (it leaves the machine logged out of both). Sets the operator on the new one.
# Restarts agentbox, so its tailnet listener takes the new address.
#   move-here.sh [hostname] [headscale user, default ammon]
set -euo pipefail
KEY=$("$(dirname "$0")/key.sh" "${2:-ammon}")
sudo tailscale login --login-server https://headscale.plaibook.tech --authkey "$KEY" --hostname "${1:-$(hostname -s)}" --operator="$USER"
tailscale ip -4
if systemctl --user is-active -q agentbox 2>/dev/null; then systemctl --user restart agentbox; fi
