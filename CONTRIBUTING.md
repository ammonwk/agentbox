# Contributing

agentbox is one person's daily driver, published in case it is useful to
yours. Issues and pull requests are welcome; small, focused ones land fastest.

Before you start:

- Read `docs/v2.md` (the design and the HTTP/WebSocket contract) and the rules
  in `AGENTS.md`. Most of them exist because breaking them once lost someone's
  session, prompt cache or login.
- `bun run typecheck` must stay clean, and `bun run web:build` must succeed.
  CI runs both, plus `bun test`.
- Check a change by running it: `bun run web:dev` serves the UI against your
  server, and `?mock=1` runs it on fake data with no server at all.
- The tests are few on purpose (see "Tests" in `AGENTS.md`). Please do not add
  one unless it guards a rule whose breakage would be destructive or a
  security hole.
- Nothing personal belongs in the checkout: no names, emails, paths or
  private project names, in code, tests, fixtures or docs. Who agentbox works
  for is derived on each machine into `~/.local/share/agentbox/user.env`.

For anything that touches credentials, the CSRF rules or the tailnet listener,
read `SECURITY.md` first.
