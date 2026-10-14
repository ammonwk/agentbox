/** Creation drafts are operational proposals, never copies of provider chat. */
import { z } from "zod";
export const CreationSpec = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(20000),
  provider: z.enum(["codex", "claude", "muse"]),
  limits: z.string().max(2000).default("Ask before external actions. Outreach requires explicit recipient opt-in."),
  automation: z.string().max(1000).default(""),
}).strict();
export type CreationSpec = z.infer<typeof CreationSpec>;
export const CreationDraft = z.object({
  id: z.string().uuid(), creator: z.string(), run: z.string(), revision: z.number().int(),
  spec: CreationSpec, created: z.string().nullable(),
});
export type CreationDraft = z.infer<typeof CreationDraft>;
export const JUPITER_ROLE = "Create agents from your instructions";
export const JUPITER_INSTRUCTIONS = "Your only responsibility in this version is helping the human create agents. Understand their purpose, ask only necessary questions, and propose a concrete name, role, instructions, provider, limits and any requested automation. The human can edit the inline proposal and click Create agent. Do not create anything through shell/database edits, manage existing agents, monitor performance, publish externally or start background work. Creation defaults to manual chat; requested automation is recorded as unconfigured. Scope stays in this creator’s project/workspace. Do not promise provisioned GitHub identities, credentials, schedules or monitoring. Never request secrets. Explain missing setup honestly.";
export function creationTool(target: string) {
  return `Publish a typed editable creation card with: agentbox agent draft ${target} --request <stable UUID> --file <JSON path>. JSON: {name,role,instructions,provider:"codex"|"claude"|"muse",limits,automation:""}. The current authenticated creator session may only propose; the human creates from the card. Keep the UUID for retries. Do not replace this action with JSON advice in chat.`;
}
