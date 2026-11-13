#!/bin/bash
# A one-use pre-auth key for the team tailnet (docs/org.md "The tailnet"), good for 24 hours,
# for a device of <user> (ammon, nate, maxwell, tanner, austin; `headscale users create <name>`
# adds one). Needs SSH to the headscale box over the tailnet, which only Ammon's machine has.
#   key.sh <headscale user>
set -euo pipefail
HS=headscale  # ~/.ssh/config: ubuntu@100.64.0.1 over the tailnet (docs/org.md)
ID=$(ssh -o BatchMode=yes "$HS" "sudo headscale users list -o json" | python3 -c "import json,sys;print([u['id'] for u in json.load(sys.stdin) if u['name']=='$1'][0])")
ssh -o BatchMode=yes "$HS" "sudo headscale preauthkeys create --user $ID --expiration 24h -o json" | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])"
