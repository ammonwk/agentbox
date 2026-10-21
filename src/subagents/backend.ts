/** The agent CLIs a subagent can run on. Each speaks ACP over stdio, so the
 * runner and the pool are the same for all of them; what differs is how the
 * process is started, how it takes a system prompt, and how it is made
 * read-only. */

import { bridgeUrl, bridgedModel } from "../bridge/models";
import { ensureBridge } from "../bridge/service";
import { decodeParent, PARENT_ENV } from "./parent";

export const SUBAGENT_PROVIDERS = ["omp", "devin"] as const;
export type SubagentProvider = (typeof SUBAGENT_PROVIDERS)[number];

export interface AcpBackend {
  readonly id: SubagentProvider;
  /**
   * The model to pass, or null for the CLI's own configured default. Read
   * from `AGENTBOX_SUBAGENT_<ID>_MODEL` and never from a caller: calling
   * models pass the names they know ("sonnet"), which a CLI can accept at
   * launch and fail on only at the first prompt, as a provider error that
   * reads like the agent's own.
   *
   * Failing that, the model of the session that called: a subagent runs on
   * what its caller runs on, when this CLI can run it.
   */
  model(): string | null;
  argv(model: string | null, promptFile: string, readOnly: boolean): string[];
  env(agentName: string): Record<string, string>;
  /** Whether `argv` hands the CLI the system prompt. When it cannot, the
   *  runner leads a new conversation's first message with it instead. */
  readonly systemPromptFlag: boolean;
  /** The ACP session mode to select once a session is open, or null to leave
   *  the CLI's default. Re-applied on every open, since a load does not keep it. */
  mode(readOnly: boolean): string | null;
}

const omp: AcpBackend = {
  id: "omp",
  model: () =>
    process.env.AGENTBOX_SUBAGENT_OMP_MODEL ||
    decodeParent(process.env[PARENT_ENV])?.omp ||
    "opencode-go-responses/muse-spark-1.3-contributor",
  // omp treats an --append-system-prompt value containing a newline as the
  // prompt itself and otherwise reads it as a file, falling back silently to
  // the path as text when the read fails — hence the runner's existence check.
  // omp asks permission before a shell command but never before an edit, so
  // a read-only agent is given only tools that cannot write: no shell, python,
  // notebook or browser, no `task` sub-agents, and no `lsp`, whose renames edit.
  argv: (model, promptFile, readOnly) => [
    "omp", "acp",
    ...(model === null ? [] : ["--model", model]),
    "--append-system-prompt", promptFile,
    ...(readOnly ? ["--tools", "read,grep,glob,web_search,inspect_image,todo"] : []),
  ],
  // opencode.ai asks for a conversation id on every request; omp maps this
  // variable onto that header (~/.omp/agent/models.yml). The agent's name is
  // stable across a park and a resume, so one conversation keeps one id.
  env: (agentName) => ({ AGENTBOX_OMP_SESSION: agentName }),
  systemPromptFlag: true,
  mode: () => null,
};

/** A subagent on one of the bridge's models (`src/bridge/`) reaches it the
 *  way a session does; the bridge is started if this is the first to need it. */
function devinBridgeEnv(): Record<string, string> {
  if (!bridgedModel(devin.model())) return {};
  ensureBridge();
  return { WINDSURF_API_SERVER_URL: bridgeUrl() };
}

const devin: AcpBackend = {
  id: "devin",
  model: () => process.env.AGENTBOX_SUBAGENT_DEVIN_MODEL || decodeParent(process.env[PARENT_ENV])?.devin || null,
  argv: (model) => ["devin", "acp", ...(model === null ? [] : ["--model", model])],
  // devin logs at INFO to stderr, which the pool reports as the agent's errors.
  env: () => ({ RUST_LOG: "error", ...devinBridgeEnv() }),
  systemPromptFlag: false,
  // `ask` removes devin's write and shell tools outright; `bypass` approves
  // everything, as a delegated writer with nobody to ask must.
  mode: (readOnly) => (readOnly ? "ask" : "bypass"),
};

const BACKENDS: Record<SubagentProvider, AcpBackend> = { omp, devin };

export function backendFor(provider: SubagentProvider): AcpBackend {
  return BACKENDS[provider];
}
