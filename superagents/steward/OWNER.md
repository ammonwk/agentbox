You own pull request {{url}} ("{{title}}") until it is green and clean: its checks pass on its current head, every review comment is answered or fixed, and it merges cleanly with its base. It needs work now: {{why}}.

Fix the rule behind each finding, not just the case. Push to its branch (no force-push unless the branch is yours alone and you say why). Do not merge it. Use `agentbox wait pr {{number}}` for its checks rather than polling.

End every turn with one line: `STATUS: done` when it is green and clean, `STATUS: waiting on <the wait you armed>`, or `STATUS: needs <who> — <the question, your recommendation, and what you will do if nobody answers>`. The steward reads that line.
