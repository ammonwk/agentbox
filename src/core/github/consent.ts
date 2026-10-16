/**
 * Contact consent from the cloud (docs/cloud.md, "Shared superagents"): each
 * person opts in, per workspace, repo and instance, by the numeric GitHub id
 * of the identity they verified. Default off, and a no wins over every yes.
 * The broker asks at dispatch (`checkContactAtDispatch`), so a consent
 * withdrawn after an approval still stops the action.
 *
 * A superagent this machine shares is checked as its instance; one it does
 * not share, against the workspace-wide and repo-wide answers only.
 */
import type { InstallationSuperagents } from "../../cloud/superagents";
import type { ConsentSource, ContactScope, Recipient } from "./broker";

export class CloudConsent implements ConsentSource {
  constructor(
    /** The machine's client; it throws when the cloud is not reachable or this machine not registered. */
    private readonly api: () => InstallationSuperagents | null,
    private readonly instanceOf: (superagent: string) => string | null,
  ) {}

  async check(recipients: Recipient[], scope: ContactScope): Promise<{ id: number; allowed: boolean }[]> {
    if (!recipients.length) return [];
    const api = this.api();
    // No answer is no consent: the broker refuses every recipient it was not told about.
    if (!api) return [];
    return api.contactCheck(this.instanceOf(scope.superagent), scope.repo, recipients.map((r) => r.id));
  }
}
