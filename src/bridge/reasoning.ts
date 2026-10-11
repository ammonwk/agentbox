/**
 * Reasoning one account issued, left out of what another account sends.
 *
 * A Responses model's hidden reasoning comes back as an `encrypted_content`
 * blob (the CLI asks for it with `include: ["reasoning.encrypted_content"]`
 * and replays every one in the session's history), and OpenCode Go takes a
 * blob back only from the sign-in it issued it to: from any other, the whole
 * request is "400 reasoning `encrypted_content` was not issued to this
 * caller". A session agentbox wakes on another account (`Fleet.wake`: a cold
 * one goes where the balancer has room, one at a limit to an account that can
 * take it) carries its first account's blobs, so from then on every request
 * is refused the same way, a continue included. omp hides it for one turn:
 * it replays no reasoning until its process has had an answer, so the
 * request that wakes the session is taken and the next one ends it.
 *
 * The history is the CLI's to keep; which sign-in a request goes out on is
 * the proxy's doing, so the proxy leaves out what that sign-in cannot send.
 * A blob cannot be read for who issued it, so the refusal is the evidence:
 * every blob in a refused request is the other account's (nothing of this
 * account's own is among them the first time, and a session moved back to
 * where it began loses only reasoning), remembered so later requests go out
 * right the first time. A reasoning item keeps its summary, which is plain
 * text any account may send; one with no summary goes altogether. What is
 * remembered lives as long as the bridge does: after a restart the first
 * request of such a session is refused once more and repaired again.
 */

interface ReasoningItem {
  type?: unknown;
  summary?: unknown;
  encrypted_content?: unknown;
}

/** Go's refusal of a blob it issued to someone else. */
export function refusedForeignReasoning(status: number, text: string): boolean {
  return status === 400 && /encrypted_content`? was not issued to this caller/.test(text);
}

/** Beyond this many blobs for one account, forget and learn again from a refusal. */
const MOST = 200_000;

export class ForeignReasoning {
  private byAccount = new Map<string, Set<string>>();

  /** The body without the blobs this account is known unable to send, or null
   *  when it holds none of them and goes out byte for byte. */
  strip(account: string, body: string): { body: string; dropped: number } | null {
    const known = this.byAccount.get(account);
    if (!known?.size) return null;
    return rewrite(body, (key) => known.has(key));
  }

  /** The account was refused this body: every blob in it is another's. The
   *  body without them, or null when it holds none. */
  refused(account: string, body: string): { body: string; dropped: number } | null {
    let known = this.byAccount.get(account);
    if (!known || known.size > MOST) this.byAccount.set(account, (known = new Set()));
    const seen = known;
    return rewrite(body, (key) => (seen.add(key), true));
  }
}

function rewrite(body: string, foreign: (key: string) => boolean): { body: string; dropped: number } | null {
  if (!body.includes('"encrypted_content"')) return null;
  let req: { input?: unknown };
  try {
    req = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(req.input)) return null;
  let dropped = 0;
  const input: unknown[] = [];
  for (const item of req.input as (ReasoningItem | null)[]) {
    const blob = item?.type === "reasoning" ? item.encrypted_content : null;
    if (typeof blob !== "string" || !blob || !foreign(Bun.hash(blob).toString(36))) {
      input.push(item);
      continue;
    }
    dropped++;
    if (!Array.isArray(item!.summary) || !item!.summary.length) continue;
    const { encrypted_content: _, ...rest } = item!;
    input.push(rest);
  }
  if (!dropped) return null;
  req.input = input;
  return { body: JSON.stringify(req), dropped };
}
