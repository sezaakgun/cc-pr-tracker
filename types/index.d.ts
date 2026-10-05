export type Check = { key: string; name: string; bucket: string; link: string }
export type View = { number: number; title: string; state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string }
// auto: Claude brought it in (its answer, `gh pr create`), so a /clear drops it;
// dropIfClosed: a merged or closed PR found on the first load is dropped instead of drawn
export type Pr = { url: string; id: string; label: string; pane: string; auto?: boolean; dropIfClosed?: boolean; muted?: boolean; view?: View; required: Check[]; others: Check[]; updated?: number; error?: string }
// what $.store keeps per project root, so the next session watches the same PRs
export type Watched = { url: string; auto?: boolean; muted?: boolean }

declare module 'claude-code' {
  interface PluginState {
    // the watched PRs as last drawn; kept by the host for the session, so a hot reload keeps them
    'cc-pr-tracker': { prs: Pr[] }
  }
  // the input of the tool session.start registers, so a tool.call matcher on it narrows `e`
  interface McpToolInputs {
    'mcp__cc-pr-tracker__pr_status': { pr?: string }
  }
}
