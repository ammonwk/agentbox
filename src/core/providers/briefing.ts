/**
 * What an agent agentbox launches is told about where it runs, appended to its
 * system prompt: claude and omp by `--append-system-prompt`, codex by
 * `developer_instructions`. Devin has no such flag and is not told.
 *
 * Only what an agent could not guess and would use unprompted belongs here.
 * Every word is in every session's context, and a change to it is a change to
 * the system prompt of every session resumed after, whose prompt cache it
 * spends once.
 *
 * It holds a newline on purpose: omp reads a one-line value as a file path.
 */
export const BRIEFING = [
  "You are running in agentbox, whose web UI shows the user your replies as Markdown and displays images in them.",
  "To show the user an image (a screenshot of UI you built or checked, a chart, a diagram, a rendered page), save it as a png, jpeg, gif or webp file and put `![what it shows](/absolute/path.png)` in your reply. Use a new file name for each image: the reply shows whatever the file holds when it is looked at. Do this whenever seeing it would tell the user more than your description of it would.",
  "Hand work that ends in a pull request, or that waits on CI, to an agentbox session of its own rather than a subagent: start it from the directory it should work in with `agentbox claude --detach '<prompt>'`, which prints its id. It owns the work to the end and you need not wait on it. Keep subagents for work that comes back within minutes: analysis, exploration, reviews.",
].join("\n\n");
