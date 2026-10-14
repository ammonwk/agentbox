import { z } from "zod";
import type { AgentsRuntime } from "../core/agents/runtime";
import { HttpError, json, readBody, type Router } from "./router";
import { authenticatedSession } from "../core/session-authority";
import { cloudConfig } from "../core/cloud/config";
import { FleetError } from "../core/fleet";
import { requireOperator } from "../core/agents/work";
import { AVATAR_MAX_BYTES } from "../core/agents/avatar";
import { AgentFeedback } from "../core/agents/feedback";

export function agentRoutes(router: Router, agents: AgentsRuntime) {
  const feedback = new AgentFeedback(agents);
  const human = async (req: Request, b: Record<string, unknown>) => {
    const cfg = cloudConfig().config,
      host = agents.cloud.status().installation?.id;
    if (
      authenticatedSession(req) ||
      !cfg ||
      !host ||
      typeof b.humanToken !== "string" ||
      b.humanToken.length > 16000
    )
      throw new HttpError(
        403,
        "sign in as this installation's human owner to change execution settings or start a fresh session",
      );
    // The human-only cloud guard verifies the JWT and current ownership; an
    // omitted process ID or editable identity cannot stand in for either.
    const response = await fetch(`${cfg.url}/rest/v1/rpc/agent_host_operator`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        apikey: cfg.publishableKey,
        Authorization: `Bearer ${b.humanToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_installation: host }),
    });
    if (!response.ok)
      throw new HttpError(
        403,
        "only the signed-in current installation owner may change execution settings",
      );
  };
  router
    .add("POST", "/api/agents/work-grants", async ({ req }) => {
      requireOperator(req);
      return json(await agents.works.authorize(await readBody(req)));
    })
    .add("DELETE", "/api/agents/work-grants/:id", async ({ req, params }) => {
      requireOperator(req);
      return json(await agents.works.revoke(params.id!));
    })
    .add("GET", "/api/agents/work", () => json(agents.works.list()))
    .add("GET", "/api/agents/work/:id", ({ params }) =>
      json(agents.works.get(params.id!)),
    )
    .add("POST", "/api/agents/work", async ({ req }) =>
      json(
        await agents.works.start(
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/work/:id/validation", async ({ req, params }) =>
      json(await agents.works.validation(params.id!, authenticatedSession(req), await readBody(req))),
    )
    .add("POST", "/api/agents/work/:id/review", async ({ req, params }) =>
      json(
        await agents.works.review(
          params.id!,
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/work/:id/follow", ({ req, params }) =>
      agents.works.followPublication(params.id!, authenticatedSession(req)).then(json),
    )
    .add("POST", "/api/agents/work/:id/collect", ({ req, params }) =>
      agents.works.collect(params.id!, authenticatedSession(req)).then(json),
    )
    .add("POST", "/api/agents/work/:id/publish", async ({ req, params }) =>
      json(
        await agents.works.publish(
          params.id!,
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/work/:id/retry-review", async ({ req, params }) =>
      json(
        await agents.works.retryReview(
          params.id!,
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/work/:id/retry-start", ({ req, params }) =>
      agents.works.retryStart(params.id!, authenticatedSession(req)).then(json),
    )
    .add("POST", "/api/agents/work/:id/reconcile", ({ req, params }) =>
      agents.works.reconcile(params.id!, authenticatedSession(req)).then(json),
    )
    .add("POST", "/api/agents/work/:id/milestone", async ({ req, params }) =>
      json(
        await agents.works.milestone(
          params.id!,
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/work/:id/failure", async ({ req, params }) =>
      json(
        await agents.works.failure(
          params.id!,
          authenticatedSession(req),
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/:id/creation-drafts", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.conversations.draft(
          params.id!,
          authenticatedSession(req),
          z.string().uuid().parse(b.request),
          b.spec,
        ),
      );
    })
    .add("GET", "/api/agents/local/:id/creations", ({ params }) =>
      json(agents.conversations.creations(params.id!)),
    )
    .add(
      "POST",
      "/api/agents/local/:id/creations/:draft",
      async ({ req, params }) => {
        // Local UI is the trusted loopback operator. Scoped provider callers can
        // propose only; editable callerPid/name cannot manufacture human authority.
        if (authenticatedSession(req))
          throw new HttpError(
            403,
            "Only the human operator may accept or edit a creation draft",
          );
        const b = await readBody(req);
        return json(
          agents.conversations.editCreation(
            params.id!,
            z.string().uuid().parse(params.draft),
            z.number().int().parse(b.revision),
            z.string().nullable().parse(b.repo),
            b.spec,
            z.boolean().parse(b.create),
          ),
        );
      },
    )
    .add("GET", "/api/agents/local", () => json(agents.conversations.local()))
    .add("POST", "/api/agents/local/:id/help", async ({req,params}) => {
      // Same trusted-loopback UI boundary as local chat; a session capability
      // cannot use the human's feedback command to bypass publication grants.
      if (req.headers.has("x-agentbox-session") || req.headers.has("x-agentbox-session-token"))
        throw new HttpError(403,"Only the user can publish an agent feedback report");
      return json(await feedback.submit(params.id!,await readBody(req)));
    })
    // An agent's own report: only its session capability, filed as the agent's.
    .add("POST", "/api/agents/report", async ({ req }) => {
      const by = authenticatedSession(req);
      if (!by) throw new HttpError(403, "Only an agent session can file an agent report; use /help in Agent chat");
      return json(await feedback.report(by, await readBody(req)));
    })
    .add("GET", "/api/agents/local/:id/help/:request", async ({params}) =>
      json(await feedback.receipt(params.id!,z.string().uuid().parse(params.request))),
    )
    .add("POST", "/api/agents/local/project", async ({ req }) => {
      const b = await readBody(req);
      return json(
        agents.conversations.local(z.string().min(1).max(200).parse(b.repo)),
      );
    })
    .add("POST", "/api/agents/local/:id/configure", async ({ req, params }) => {
      const b = await readBody(req);
      return json(await agents.conversations.configure(params.id!, b));
    })
    .add("POST", "/api/agents/local/:id/chat", async ({ req, params }) => {
      const b = await readBody(req);
      // The person's composer interrupts a running turn; a request carrying
      // a session capability is a session's, and is only typed in.
      const person = !req.headers.has("x-agentbox-session") && !req.headers.has("x-agentbox-session-token");
      // A session that starts another agent's chat (agentbox agent send) is
      // its opening's sender, as for any session it starts.
      const from = authenticatedSession(req);
      try {
        return json(
          await agents.conversations.localSend(
            params.id!,
            z.string().uuid().parse(b.request),
            z.string().parse(b.body),
            z
              .object({ proposal: z.string().uuid(), run: z.string() })
              .strict()
              .optional()
              .parse(b.context),
            z.string().min(1).max(200).nullable().parse(b.target),
            person,
            from ? { from, agent: agents.conversations.registeredAgent(from)?.id ?? null } : undefined,
          ),
        );
      } catch (e) {
        // Errors after the attempt boundary are already caught by localSend.
        if (e instanceof FleetError)
          return json({ id: b.request, state: "refused", result: e.message });
        throw e;
      }
    })
    // Memory: an agent's own conversation (by its session capability) or the
    // local operator. Handoffs and decisions come only from the conversation.
    .add("GET", "/api/agents/:id/memory", ({ req, params, url }) =>
      agents.memoryView(params.id!, authenticatedSession(req), z.string().max(400).parse(url.searchParams.get("q") ?? "")).then(json),
    )
    .add("GET", "/api/agents/:id/memory/:record", ({ req, params }) =>
      agents.memoryRecord(params.id!, authenticatedSession(req), z.string().uuid().parse(params.record)).then(json),
    )
    .add("POST", "/api/agents/:id/memory/:kind", async ({ req, params }) => {
      const b = await readBody(req),
        kind = z.enum(["handoff", "note", "prefer"]).parse(params.kind);
      return json(
        await agents.remember(
          params.id!,
          authenticatedSession(req),
          kind,
          kind === "prefer" ? null : z.string().uuid().parse(b.request),
          b.body,
        ),
      );
    })
    .add("PUT", "/api/agents/local/:id/avatar", async ({ req, params }) => {
      if (Number(req.headers.get("content-length") ?? 0) > AVATAR_MAX_BYTES)
        throw new HttpError(413, `Choose an image of at most ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
      return json(
        agents.conversations.setAvatar(params.id!, authenticatedSession(req), new Uint8Array(await req.arrayBuffer()), req.headers.get("content-type") ?? ""),
      );
    })
    .add("DELETE", "/api/agents/local/:id/avatar", ({ req, params }) =>
      json(agents.conversations.clearAvatar(params.id!, authenticatedSession(req))),
    )
    .add("GET", "/api/agents/local/:id/avatar", ({ params }) => {
      const f = agents.conversations.avatar(params.id!);
      if (!f) throw new HttpError(404, "This agent has no picture");
      // The URL carries the picture's version, so a replaced one is a new URL.
      return new Response(Bun.file(f.path), {
        headers: { "content-type": f.mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
      });
    })
    .add("GET", "/api/agents/local/:id/receipt/:request", async ({ params }) =>
      json(await feedback.receipt(params.id!,params.request!) ?? agents.conversations.localReceipt(params.id!, params.request!)),
    )
    .add("POST", "/api/agents/local/:id/read", async ({ req, params }) =>
      json(await agents.conversations.page(params.id!, await readBody(req))),
    )
    .add("POST", "/api/agents/local/:id/sessions/:session", async ({ req, params }) => {
      const caller = authenticatedSession(req);
      if (!caller && (req.headers.has("x-agentbox-session") || req.headers.has("x-agentbox-session-token")))
        throw new HttpError(403, "Invalid session capability");
      return json(await agents.conversations.sessionAction(params.id!, params.session!, caller, await readBody(req)));
    })
    .add("GET", "/api/agents/local/:id/proposals", ({ params }) =>
      json(agents.conversations.localProposals(params.id!)),
    )
    .add("POST", "/api/agents/local/:id/decide", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.conversations.localDecide(
          params.id!,
          z.string().uuid().parse(b.id),
          z.string().parse(b.decision),
          z.string().uuid().parse(b.request),
        ),
      );
    })
    .add("POST", "/api/agents/:id/recommend", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.conversations.propose(
          params.id!,
          authenticatedSession(req),
          z.string().uuid().parse(b.request),
          b.proposal,
        ),
      );
    })
    .add("POST", "/api/agents/runs/:id/prepare", async ({ req, params }) =>
      json(
        await agents.reviews.operation(
          params.id!,
          authenticatedSession(req),
          "prepare",
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/runs/:id/review", async ({ req, params }) =>
      json(
        await agents.reviews.operation(
          params.id!,
          authenticatedSession(req),
          "review",
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/runs/:id/collect", async ({ req, params }) =>
      json(
        await agents.reviews.operation(
          params.id!,
          authenticatedSession(req),
          "collect",
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/runs/:id/retry-review", async ({ req, params }) =>
      json(
        await agents.reviews.operation(
          params.id!,
          authenticatedSession(req),
          "retry-review",
          await readBody(req),
        ),
      ),
    )
    .add("POST", "/api/agents/runs/:id/intake", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.conversationIntake(
          params.id!,
          authenticatedSession(req),
          b.item,
        ),
      );
    })
    .add("GET", "/api/agents/runtime", () => json(agents.status()))
    .add("POST", "/api/agents/binding", async ({ req }) => {
      const b = await readBody(req);
      await human(req, b);
      return json(await agents.bind(b.binding));
    })
    .add("POST", "/api/agents/sync", async () => {
      await agents.tick();
      return json(agents.status());
    })
    .add("POST", "/api/agents/runs/:id/read", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.read(params.id!, authenticatedSession(req), b.source),
      );
    })
    .add("POST", "/api/agents/runs/:id/progress", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.progress(
          params.id!,
          authenticatedSession(req),
          b.progress,
          z
            .string()
            .max(1000)
            .parse(b.decision ?? ""),
        ),
      );
    })
    .add("POST", "/api/agents/runs/:id/finish", async ({ req, params }) =>
      json(await agents.finish(params.id!, authenticatedSession(req))),
    )
    .add("POST", "/api/agents/runs/:id/actions", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.action(
          params.id!,
          authenticatedSession(req),
          b.action,
          z.string().uuid().parse(b.request),
        ),
      );
    })
    .add("POST", "/api/agents/runs/:id/rotate", async ({ req, params }) => {
      const b = await readBody(req);
      await human(req, b);
      return json(await agents.rotate(params.id!));
    })
    .add("POST", "/api/agents/:id/experts", async ({ req, params }) => {
      const b = await readBody(req);
      return json(
        await agents.suggestions(
          params.id!,
          z
            .array(z.string().max(80))
            .max(30)
            .parse(b.areas ?? []),
          z
            .array(z.string().max(500))
            .max(40)
            .parse(b.paths ?? []),
        ),
      );
    });
  return router;
}
