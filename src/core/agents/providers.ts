/** Which provider a conversational agent's fresh conversation starts on.
 *
 * Asked only where a conversation starts: an agent's first message, or a
 * rollover after its cache went cold or it filled. A warm conversation keeps
 * its provider and account whatever another provider's headroom.
 *
 * The rule, in order:
 *   1. An explicit override (`LocalAgent.pinned`) is the only candidate.
 *      Otherwise the candidates are `AUTO_PROVIDERS`.
 *   2. A provider whose CLI is not installed (its adapter's cached
 *      `detect()`, src/core/accounts/homes.ts) is out; placement does not
 *      know. Each other is asked of Fleet's placement, which applies the
 *      balancer to that provider's own accounts: logged out, unfunded,
 *      refused and spent accounts are not eligible there. A provider whose
 *      placement is "none" (or has no account) is out.
 *   3. A provider whose placement found headroom ("auto"/"manual") comes
 *      before one placed only by "overflow" (every account's weekly claimed).
 *   4. Within a tier, the order Codex's weekly left sets (`automaticOrder`):
 *      above 50% left, Codex first; below 10%, Claude first; from 10% to 50%,
 *      a conversation keeps Codex first and an implementation (work writer)
 *      session takes the provider the agent's last writer did not. The
 *      weekly is the one of the Codex account placement picked. When it is
 *      not known, the provider of the previous conversation first, then the
 *      order of `AUTO_PROVIDERS`. Usage percentages are never compared
 *      across providers: their windows do not measure the same capacity.
 */
import type { Placement } from "../types";

export type AgentProvider = "codex" | "claude" | "muse";
/** Agentbox's supported conversational providers for Automatic, in its
 *  default order. Muse is used only when chosen explicitly. */
export const AUTO_PROVIDERS: readonly AgentProvider[] = ["claude", "codex"];
const LABEL: Record<AgentProvider, string> = { claude: "Claude", codex: "Codex", muse: "Muse" };

export type ProviderChoice = {
  provider: AgentProvider;
  /** The account placement picked, which the successor is started on. */
  accountId: string;
  /** The model asked for; null is the provider CLI's own default. */
  model: string | null;
  /** "auto" when Automatic chose it, "pinned" for an explicit override. */
  policy: "auto" | "pinned";
  /** One sentence for About and the log. */
  why: string;
  at: number;
  considered: { provider: AgentProvider; mode: Placement["mode"]; accountId: string | null; why: string }[];
};

/** Codex leads while more than this much of its weekly is left. */
export const CODEX_FIRST_ABOVE = 50;
/** Claude leads once less than this much of Codex's weekly is left. */
export const CLAUDE_FIRST_BELOW = 10;

/** Weekly percent left on the account a placement picked; null when unknown. */
export function weeklyLeft(p: Placement): number | null {
  const c = p.candidates.find((x) => x.accountId === p.accountId);
  return c?.weekly == null ? null : Math.round(Math.max(0, 100 - c.weekly) * 10) / 10;
}

/** The order Automatic tries Claude and Codex in, by Codex's weekly left.
 *  `writer` is set for an implementation session: the provider of the
 *  agent's last writer, or null for its first. Null when the weekly is not
 *  known: the default rule decides. */
export function automaticOrder(codexLeft: number | null, writer?: { last: AgentProvider | null }): { order: AgentProvider[]; why: string } | null {
  if (codexLeft === null) return null;
  const left = `Codex has ${codexLeft}% of its weekly left`;
  if (codexLeft > CODEX_FIRST_ABOVE) return { order: ["codex", "claude"], why: `${left}, above ${CODEX_FIRST_ABOVE}%, so Codex comes first.` };
  if (codexLeft < CLAUDE_FIRST_BELOW) return { order: ["claude", "codex"], why: `${left}, below ${CLAUDE_FIRST_BELOW}%, so Claude comes first.` };
  const band = `${left}, from ${CLAUDE_FIRST_BELOW}% to ${CODEX_FIRST_ABOVE}%`;
  if (!writer) return { order: ["codex", "claude"], why: `${band}: the conversation stays on Codex and implementation sessions alternate.` };
  return writer.last === "codex"
    ? { order: ["claude", "codex"], why: `${band}, so implementation sessions alternate: the last one ran on Codex, this one comes to Claude first.` }
    : { order: ["codex", "claude"], why: `${band}, so implementation sessions alternate: ${writer.last ? `the last one ran on ${LABEL[writer.last]}, ` : ""}this one comes to Codex first.` };
}

export function chooseProvider(
  place: (p: AgentProvider) => Placement,
  opts: {
    pinned?: AgentProvider;
    previous?: AgentProvider | null;
    installed: (p: AgentProvider) => boolean;
    model: (p: AgentProvider) => string | null;
    now: number;
    /** Set for an implementation (work writer) session (`automaticOrder`). */
    writer?: { last: AgentProvider | null };
  },
): ProviderChoice | { none: string; considered: ProviderChoice["considered"] } {
  const candidates = opts.pinned ? [opts.pinned] : [...AUTO_PROVIDERS];
  let codexLeft: number | null = null;
  const considered = candidates.map((provider) => {
    if (!opts.installed(provider)) return { provider, mode: "none" as const, accountId: null, why: "its CLI is not installed on this machine." };
    let p: Placement;
    try {
      p = place(provider);
    } catch (e) {
      return { provider, mode: "none" as const, accountId: null, why: (e as Error).message };
    }
    if (provider === "codex" && p.accountId) codexLeft = weeklyLeft(p);
    return { provider, mode: p.accountId ? p.mode : ("none" as const), accountId: p.accountId, why: p.why };
  });
  const auto = opts.pinned ? null : automaticOrder(codexLeft, opts.writer);
  const rank = (p: AgentProvider) => (auto ? auto.order.indexOf(p) : p === opts.previous ? -1 : candidates.indexOf(p));
  const tier = (m: Placement["mode"]) => (m === "auto" || m === "manual" ? 0 : m === "overflow" ? 1 : 2);
  const ranked = considered.filter((c) => tier(c.mode) < 2).sort((a, b) => tier(a.mode) - tier(b.mode) || rank(a.provider) - rank(b.provider));
  const best = ranked[0];
  const others = considered.filter((c) => c !== best && tier(c.mode) === 2).map((c) => `${LABEL[c.provider]}: ${c.why}`);
  if (!best)
    return { none: `No provider can take this conversation now. ${considered.map((c) => `${LABEL[c.provider]}: ${c.why}`).join(" ")}`, considered };
  const name = LABEL[best.provider];
  const why = opts.pinned
    ? `${name}, chosen explicitly.`
    : `${name}${!auto && best.provider === opts.previous ? ", as before," : ""} ${best.mode === "overflow" ? "has only claimed headroom left, the best available" : "has room"}.${auto ? ` ${auto.why}` : ""}${others.length ? ` ${others.join(" ")}` : ""}`;
  return { provider: best.provider, accountId: best.accountId!, model: opts.model(best.provider), policy: opts.pinned ? "pinned" : "auto", why: why.slice(0, 400), at: opts.now, considered };
}
