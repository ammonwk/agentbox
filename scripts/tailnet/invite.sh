#!/bin/bash
# The org's invite (`agentbox org invite`) with its store reached through atlas-proxy, the
# way every member on the team tailnet reaches it (docs/org.md "The tailnet"). Ammon's
# fedora reaches the store through its own AWS tunnel, so its invite needs this; on any
# other member's machine it changes nothing. Send the result privately.
set -euo pipefail
agentbox org invite | python3 -c '
import base64, json, re, sys
p = "agentbox-org:"
org = json.loads(base64.urlsafe_b64decode(sys.stdin.read().strip()[len(p):] + "=="))
org["store"] = re.sub(r"proxyHost=[^&]*&proxyPort=\d+", "proxyHost=100.64.0.2&proxyPort=1080", org["store"])
print(p + base64.urlsafe_b64encode(json.dumps(org).encode()).decode().rstrip("="))'
