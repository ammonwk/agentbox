import { z } from "zod";
import type { AgentsRuntime } from "../core/agents/runtime";
import { HttpError, json, readBody, type Router } from "./router";
import { authenticatedSession } from "../core/session-authority";
import { cloudConfig } from "../core/cloud/config";
import { FleetError } from "../core/fleet";

export function agentRoutes(router: Router, agents: AgentsRuntime) {
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
    .add("GET", "/api/agents/local", () => json(agents.conversations.local()))
    .add("POST", "/api/agents/local/:id/configure", async ({ req, params }) => {
      const b = await readBody(req);
      return json(await agents.conversations.configure(params.id!, b));
    })
    .add("POST", "/api/agents/local/:id/chat", async ({ req, params }) => {
      const b = await readBody(req);
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
          ),
        );
      } catch (e) {
        // Errors after the attempt boundary are already caught by localSend.
        if (e instanceof FleetError)
          return json({ id: b.request, state: "refused", result: e.message });
        throw e;
      }
    })
    .add("GET", "/api/agents/local/:id/receipt/:request", ({ params }) =>
      json(agents.conversations.localReceipt(params.id!, params.request!)),
    )
    .add("POST", "/api/agents/local/:id/read", async ({ req, params }) =>
      json(await agents.conversations.page(params.id!, await readBody(req))),
    )
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
