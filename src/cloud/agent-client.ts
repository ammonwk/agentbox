import { z } from "zod";
import { cloudCall, type HumanCloud, type InstallationCloud } from "./client";
import {
  AgentBoard,
  AgentDefinition,
  AgentRevision,
  AgentRun,
  ExpertiseProfile,
  SharedAgent,
  WorkItem,
  WorkProgress,
  ContactPreference,
  ContactDecision,
  AgentAction,
} from "./agents";

/** Authenticated humans author shared instances directly; machines never
 * acquire a human token or the ability to change a human's permissions. */
export class HumanAgents {
  constructor(readonly human: HumanCloud) {}
  board(workspace: string) {
    return cloudCall(
      this.human.sb,
      "agents_board",
      { p_workspace: workspace },
      AgentBoard,
    );
  }
  save(input: {
    workspace: string;
    id?: string;
    base?: number;
    name: string;
    team: boolean;
    definition: AgentDefinition;
    maintainers: string[];
    enabled?: boolean;
    executor?: string | null;
  }) {
    return cloudCall(
      this.human.sb,
      "agent_save",
      {
        p_workspace: input.workspace,
        p_id: input.id ?? null,
        p_base: input.base ?? 0,
        p_name: input.name,
        p_team: input.team,
        p_definition: AgentDefinition.parse(input.definition),
        p_maintainers: input.maintainers,
        p_enabled: input.enabled ?? false,
        p_executor: input.executor ?? null,
      },
      SharedAgent,
    );
  }
  async clone(a: SharedAgent, userId: string) {
    return this.save({
      workspace: a.workspace_id,
      name: `${a.name} copy`,
      team: false,
      maintainers: [userId],
      definition: a.definition,
    });
  }
  authorize(agent: string, installation: string, allow: boolean) {
    return cloudCall(
      this.human.sb,
      "agent_authorize_executor",
      { p_agent: agent, p_installation: installation, p_allow: allow },
      z.unknown(),
    );
  }
  expertise(
    workspace: string,
    input: {
      areas: string[];
      login: string;
      emails: string[];
      paths: string[];
    },
  ) {
    return cloudCall(
      this.human.sb,
      "agent_set_expertise",
      {
        p_workspace: workspace,
        p_areas: input.areas,
        p_login: input.login,
        p_emails: input.emails,
        p_paths: input.paths,
      },
      ExpertiseProfile,
    );
  }
  intake(
    agent: string,
    input: { source: string; title: string; acceptance: string },
  ) {
    return cloudCall(
      this.human.sb,
      "agent_intake",
      {
        p_agent: agent,
        p_source: input.source,
        p_title: input.title,
        p_acceptance: input.acceptance,
      },
      WorkItem,
    );
  }
  assign(work: WorkItem, assignee: string, agent = work.agent_id) {
    return cloudCall(
      this.human.sb,
      "agent_assign",
      {
        p_work: work.id,
        p_base: work.revision,
        p_assignee: assignee,
        p_agent: agent,
      },
      WorkItem,
    );
  }
  run(work: WorkItem, request: string) {
    return cloudCall(
      this.human.sb,
      "agent_request_run",
      { p_work: work.id, p_base: work.revision, p_request: request },
      AgentRun,
    );
  }
  takeover(work: WorkItem) {
    return cloudCall(
      this.human.sb,
      "agent_takeover",
      { p_work: work.id, p_base: work.revision },
      WorkItem,
    );
  }
  progress(work: WorkItem, input: WorkProgress) {
    const p = WorkProgress.parse(input);
    return cloudCall(
      this.human.sb,
      "agent_human_progress",
      {
        p_work: work.id,
        p_base: work.revision,
        p_stage: p.stage,
        p_next: p.next,
        p_outcome: p.outcome,
        p_evidence: p.evidence,
      },
      WorkItem,
    );
  }
  consent(
    workspace: string,
    repo: string,
    agent: string | null,
    allowed: boolean,
  ) {
    return cloudCall(
      this.human.sb,
      "agent_contact_preference",
      {
        p_workspace: workspace,
        p_repo: repo,
        p_agent: agent,
        p_allowed: allowed,
      },
      ContactPreference,
    );
  }
  async preferences(workspace: string) {
    const r = await this.human.sb
      .from("agent_contact_preferences")
      .select("*")
      .eq("workspace_id", workspace);
    if (r.error) throw r.error;
    return z.array(ContactPreference).parse(r.data);
  }
  async actions(workspace: string) {
    const query = () =>
      this.human.sb
        .from("agent_actions")
        .select("*")
        .eq("workspace_id", workspace);
    const results = await Promise.all([
      query().in("state", [
        "prepared",
        "approved",
        "attempting",
        "pending",
        "uncertain",
      ]),
      query().order("created_at", { ascending: false }).limit(200),
    ]);
    const actions = new Map<string, AgentAction>();
    for (const r of results) {
      if (r.error) throw r.error;
      for (const a of z.array(AgentAction).parse(r.data)) actions.set(a.id, a);
    }
    return [...actions.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }
  decide(action: string, approve: boolean) {
    return cloudCall(
      this.human.sb,
      "agent_action_decide",
      { p_action: action, p_approve: approve },
      AgentAction,
    );
  }
  async revisions(agent: string) {
    const r = await this.human.sb
      .from("agent_revisions")
      .select("*")
      .eq("agent_id", agent)
      .order("revision", { ascending: false });
    if (r.error) throw r.error;
    return z.array(AgentRevision).parse(r.data);
  }
}

export class InstallationAgents {
  constructor(readonly installation: InstallationCloud) {}
  board() {
    return this.installation.agentCall("inst_agents_board", {}, AgentBoard);
  }
  intake(
    agent: string,
    input: { source: string; title: string; acceptance: string },
  ) {
    return this.installation.agentCall(
      "inst_agent_intake",
      {
        p_agent: agent,
        p_source: input.source,
        p_title: input.title,
        p_acceptance: input.acceptance,
      },
      WorkItem,
    );
  }
  claim(run: string) {
    return this.installation.agentCall(
      "inst_agent_claim",
      { p_run: run },
      AgentRun,
    );
  }
  enqueue(work: string) {
    return this.installation.agentCall(
      "inst_agent_enqueue",
      { p_work: work },
      AgentRun,
    );
  }
  report(
    run: AgentRun,
    state: "running" | "waiting" | "stopped" | "finished" | "failed",
    input: {
      session?: string | null;
      next?: string;
      decision?: string;
      error?: string;
    } = {},
  ) {
    return this.installation.agentCall(
      "inst_agent_report",
      {
        p_run: run.id,
        p_fence: run.fence,
        p_state: state,
        p_session: input.session ?? run.session_id,
        p_next: input.next ?? "",
        p_decision: input.decision ?? "",
        p_error: input.error ?? "",
      },
      AgentRun,
    );
  }
  rotate(run: AgentRun, nextSession: string) {
    return this.installation.agentCall(
      "inst_agent_rotate",
      {
        p_run: run.id,
        p_fence: run.fence,
        p_previous: run.session_id,
        p_session: nextSession,
      },
      AgentRun,
    );
  }
  progress(run: AgentRun, input: WorkProgress) {
    const p = WorkProgress.parse(input);
    return this.installation.agentCall(
      "inst_agent_progress",
      {
        p_run: run.id,
        p_fence: run.fence,
        p_stage: p.stage,
        p_next: p.next,
        p_outcome: p.outcome,
        p_evidence: p.evidence,
      },
      WorkItem,
    );
  }
  contacts(agent: string, repo: string, logins: string[]) {
    return this.installation.agentCall(
      "inst_agent_contact_check",
      { p_agent: agent, p_repo: repo, p_logins: logins },
      z.array(ContactDecision),
    );
  }
  prepare(run: AgentRun, id: string, specification: Record<string, unknown>) {
    return this.installation.agentCall(
      "inst_agent_action_prepare",
      {
        p_run: run.id,
        p_fence: run.fence,
        p_id: id,
        p_specification: specification,
      },
      AgentAction,
    );
  }
  dispatch(run: AgentRun, action: string) {
    return this.installation.agentCall(
      "inst_agent_action_dispatch",
      { p_run: run.id, p_fence: run.fence, p_action: action },
      AgentAction,
    );
  }
  actionResult(
    action: string,
    state: "pending" | "sent" | "refused" | "uncertain",
    result: string,
  ) {
    return this.installation.agentCall(
      "inst_agent_action_result",
      { p_action: action, p_state: state, p_result: result },
      AgentAction,
    );
  }
}
