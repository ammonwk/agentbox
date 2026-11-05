#!/bin/bash
# A one-use pre-auth key for the team tailnet (docs/org.md "The tailnet"), good for 24 hours,
# for a device of <user> (ammon, nate, maxwell, tanner, austin; `headscale users create <name>`
# adds one). Needs SSH to the headscale box, which only Ammon's machine has.
#   key.sh <headscale user>
set -euo pipefail
HS=ubuntu@54.84.189.218
ID=$(ssh -o BatchMode=yes "$HS" "sudo headscale users list -o json" | python3 -c "import json,sys;print([u['id'] for u in json.load(sys.stdin) if u['name']=='$1'][0])")
ssh -o BatchMode=yes "$HS" "sudo headscale preauthkeys create --user $ID --expiration 24h -o json" | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])"
