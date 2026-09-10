import { useState } from "react";
import type { Session } from "../../../../src/core/types";
import { api } from "../../api";
import { Button, Icon } from "../../components";
import { canSteer, RESUME_HINT, steerPlaceholder } from "./format";
import { useAction } from "./useAction";

/**
 * The always-visible composer, or the permission prompt that replaces it.
 *
 * The placeholder is load-bearing: a message to a running agent reaches it
 * only after its current step (host.ts `deliver`), while a waiting agent gets
 * it immediately. Someone who does not know which case they are in cannot
 * tell whether their correction landed — the transcript marks the first kind
 * queued until it has.
 */
export function Steer({ session }: { session: Session }) {
  if (session.blocked) return <PermissionPrompt session={session} />;
  return <Composer session={session} />;
}

function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const { run, busy, error } = useAction();
  const allowed = canSteer(session.status);

  async function send() {
    const body = text.trim();
    if (!body || busy || !allowed) return;
    const ok = await run(() => api.sendMessage(session.id, body));
    if (ok) setText("");
  }

  const queued = session.status === "running" || session.status === "spawning";

  return (
    <div className="sx-steer">
      {error && <div className="sx-error">Message not sent: {error}</div>}
      <div className="sx-steer-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={steerPlaceholder(session.status)}
          aria-label="Message to the agent"
          disabled={!allowed || busy}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          variant="primary"
          icon={Icon.play}
          onClick={() => void send()}
          loading={busy}
          disabled={!allowed || busy || text.trim() === ""}
        >
          {queued ? "Queue" : "Send"}
        </Button>
      </div>
      <div className="sx-steer-hint">
        {allowed
          ? "Enter sends · Shift+Enter for a new line"
          : `Resume the session first — the message is delivered once it is running again. ${RESUME_HINT}`}
      </div>
    </div>
  );
}

function PermissionPrompt({ session }: { session: Session }) {
  const { run, busy, error } = useAction();
  const req = session.permission ?? null;

  return (
    <div className="sx-steer">
      {error && <div className="sx-error">Could not answer the prompt: {error}</div>}
      <div className="sx-permission">
        <div>
          <div className="sx-permission-title">
            {req?.title ?? "The agent is waiting on a permission decision"}
          </div>
          {req?.tool && <div className="sx-permission-tool">{req.tool}</div>}
          {!req && (
            // `permission` is in-memory only (types.ts), so a server restart
            // loses the details while the session stays blocked. Say that
            // rather than rendering an unlabelled pair of buttons.
            <div className="sx-permission-tool">
              The request details were lost when the server restarted. Denying is the safe answer if
              you cannot tell what was asked.
            </div>
          )}
          {req && req.options.length > 0 && (
            <div className="sx-permission-tool">
              Offered: {req.options.map((o) => o.name).join(", ")}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            variant="primary"
            icon={Icon.check}
            loading={busy}
            disabled={busy}
            onClick={() => void run(() => api.replyPermission(session.id, true))}
          >
            Approve
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run(() => api.replyPermission(session.id, false))}
          >
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
