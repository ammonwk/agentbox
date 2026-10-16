/** Replaced at UI build time; older development bundles can omit it. */
declare const __AGENTBOX_REVISION__: { commit: string; dirty: boolean } | null;
export const UI_REVISION = typeof __AGENTBOX_REVISION__ === "undefined" ? null : __AGENTBOX_REVISION__;
