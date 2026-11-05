#!/bin/bash
# Move this machine onto the team tailnet (docs/org.md "The tailnet"), keeping the personal
# Tailscale account as a second profile: `tailscale switch ammonwk@gmail.com` goes back.
# Needs to be the Tailscale operator (`sudo tailscale set --operator=$USER` once) or root.
# Restarts agentbox, so its tailnet listener takes the new address.
#   move-here.sh [hostname] [headscale user, default ammon]
set -euo pipefail
KEY=$("$(dirname "$0")/key.sh" "${2:-ammon}")
tailscale login --login-server https://headscale.plaibook.tech --authkey "$KEY" --hostname "${1:-$(hostname -s)}"
tailscale ip -4
if systemctl --user is-active -q agentbox 2>/dev/null; then systemctl --user restart agentbox; fi
