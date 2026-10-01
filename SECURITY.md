# Security

agentbox drives coding agents that often run with their permission prompts
off, and it holds the logins of every account you add. Treat access to its
server as access to your shell.

## What it exposes

- **The server binds `127.0.0.1:4479`.** Being on loopback stops other
  machines, not other web pages, so every mutating request must carry
  `x-agentbox: 1` and Host/Origin must be loopback (`src/server/csrf.ts`).
  That blocks cross-site requests and DNS rebinding.
- **The tailnet listener** (`src/server/tailnet.ts`) serves the same app on
  this machine's Tailscale address, so a phone can use it. Each connection's
  peer is checked with `tailscale whois`: only an untagged device logged in as
  the same Tailscale user as this machine gets in. Set `AGENTBOX_TAILNET=0`
  to turn it off.
- **Credentials** stay in each provider's own credential home under
  `~/.local/share/agentbox/accounts/`. agentbox never copies or refreshes a
  token. Secrets pasted into a login flow are scrubbed from the output the UI
  shows (`src/core/accounts/login.ts`).

Do not put the server behind a reverse proxy or bind it to another address
(`AGENTBOX_HOST`) unless something in front of it authenticates you.

## Reporting a vulnerability

Please report it privately, through GitHub's "Report a vulnerability" on this
repository's Security tab, not in a public issue. Include what an attacker
needs (a page you visit, a device on your tailnet, a local user) and what they
get.
