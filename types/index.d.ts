export type Check = { key: string; name: string; bucket: string; link: string }
export type View = { number: number; title: string; state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string }
// auto: Claude brought it in (its answer, `gh pr create`), so a /clear drops it;
// dropIfClosed: a merged or closed PR found on the first load is dropped instead of drawn
export type Pr = { url: string; id: string; label: string; pane: string; auto?: boolean; dropIfClosed?: boolean; muted?: boolean; view?: View; required: Check[]; others: Check[]; updated?: number; error?: string }
// what $.store keeps per session (a resume watches the same PRs) or per project root (every new
// session there does); `at` dates the write, so a session never resumed is pruned
export type Watched = { url: string; auto?: boolean; muted?: boolean }
export type Stored = { at: number; prs: Watched[] }

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
