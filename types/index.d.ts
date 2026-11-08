// one step of a PR as GitHub reports it; mirrors hooks/steps.ts, which this file does not import
export type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'skipped'
export type Step = { key: string; name: string; phase: 'checks' | 'review' | 'queue' | 'merge' | 'after merge'; state: StepState; startedAt?: string; completedAt?: string; link?: string; expected?: boolean; optional?: boolean }
export type Progress = { k: number; n: number; pct: number; current?: Step; failed?: Step; afterMergeFailed: boolean; settled: boolean }
export type Check = { key: string; name: string; bucket: string; link: string }
export type View = { number: number; title: string; state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string; mergedAt?: string | null; closedAt?: string | null }
// auto: Claude brought it in (its answer, `gh pr create`), so a /clear drops it;
// dropIfClosed: a merged or closed PR found on the first load is dropped instead of drawn;
// doneAt: when a poll first saw it merged or closed, for "Stop watching after"
// under "Show steps": steps and progress as last polled; settled: merged and every job and deploy
// its merge set off finished green (or closed); sawQueue: it was in a merge queue once
export type Pr = { url: string; id: string; label: string; pane: string; auto?: boolean; dropIfClosed?: boolean; muted?: boolean; view?: View; required: Check[]; others: Check[]; updated?: number; error?: string; doneAt?: number; steps?: Step[]; progress?: Progress; settled?: boolean; sawQueue?: boolean }
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
