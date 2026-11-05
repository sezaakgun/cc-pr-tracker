// Show steps: each PR's progress as a mirror of the steps it actually goes through, read
// from the same GraphQL call the tracker already makes. Nothing here is invented: a check run is a
// step because GitHub ran it, a review step exists only when GitHub reports a review decision or a
// requested reviewer, a merge-queue step only when the PR was queued, and the after-merge steps are
// the workflow jobs and deployments GitHub attached to the merge commit. Before the merge, the
// after-merge steps of this repo's last merged PR stand in (marked expected), so the count does not
// jump at the merge.

export type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'skipped'
export type Phase = 'checks' | 'review' | 'queue' | 'merge' | 'after merge'
// optional: a check GitHub does not require; when one fails it is listed but neither counts nor
// stops the percent, since it does not block the merge
export type Step = { key: string; name: string; phase: Phase; state: StepState; startedAt?: string; completedAt?: string; link?: string; expected?: boolean; optional?: boolean }
export type Progress = { k: number; n: number; pct: number; current?: Step; failed?: Step; afterMergeFailed: boolean; settled: boolean }

// the head-commit rollup contexts, as the tracker's query returns them (after latestPerName)
export type HeadContext = { __typename: string; isRequired?: boolean; name?: string; context?: string; status?: string | null; conclusion?: string | null; state?: string; startedAt?: string | null; completedAt?: string | null; createdAt?: string | null; detailsUrl?: string; targetUrl?: string; checkSuite?: { app?: { slug?: string } | null; workflowRun?: { event?: string; workflow?: { name?: string } | null } | null } | null }
export type SuiteRun = { name: string; status: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string }
export type Suite = { app?: { slug?: string } | null; workflowRun?: { event?: string; workflow?: { name?: string } | null } | null; checkRuns: { nodes: SuiteRun[] } }
export type Deployment = { environment?: string | null; createdAt?: string | null; latestStatus?: { state?: string | null; createdAt?: string | null } | null }
export type StepInput = {
  state: string // OPEN | MERGED | CLOSED
  mergedAt?: string | null
  reviewDecision?: string | null
  reviewRequests?: number
  queue?: { position?: number | null; state?: string | null } | null
  sawQueue?: boolean
  head: HeadContext[]
  suites?: Suite[]
  deployments?: Deployment[]
  expectedAfter?: string[] // after-merge step names of this repo's last settled merge
}

// GitHub text goes to the terminal as-is, so control characters are dropped first
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '')

// a check run or commit status: done, running, waiting (queued, not started), failed or skipped
export function runState(status?: string | null, conclusion?: string | null, started?: string | null): StepState {
  if (status && status !== 'COMPLETED') return started ? 'running' : 'waiting'
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'done'
  if (conclusion === 'SKIPPED') return 'skipped'
  return 'failed'
}
function statusContextState(state?: string): StepState {
  if (state === 'SUCCESS') return 'done'
  if (state === 'PENDING') return 'running'
  if (state === 'EXPECTED') return 'waiting'
  return 'failed'
}
function deploymentState(state?: string | null): StepState {
  if (state === 'SUCCESS' || state === 'INACTIVE') return 'done'
  if (state === 'FAILURE' || state === 'ERROR') return 'failed'
  if (state === 'IN_PROGRESS') return 'running'
  return 'waiting' // QUEUED, PENDING, WAITING, or no status yet
}

const byStart = (a: Step, b: Step) => (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿')

// one name per after-merge job: the workflow's name, then the job's when they differ
export function afterMergeName(workflow: string | undefined, job: string): string {
  return workflow && workflow !== job ? `${workflow}: ${job}` : job
}

export function discoverSteps(i: StepInput): Step[] {
  const merged = i.state === 'MERGED'
  const steps: Step[] = []

  // 1. every check on the head commit, in the order it started; a name used twice carries its workflow
  const names = new Map<string, number>()
  for (const c of i.head) names.set(c.name ?? c.context ?? '', (names.get(c.name ?? c.context ?? '') ?? 0) + 1)
  const checks: Step[] = i.head.map(c => {
    if (c.__typename === 'StatusContext') {
      const name = clean(c.context ?? '')
      return { key: `check:status:${name}`, name, phase: 'checks', state: statusContextState(c.state), startedAt: c.createdAt ?? undefined, link: c.targetUrl, optional: c.isRequired === false }
    }
    const raw = c.name ?? ''
    const wf = c.checkSuite?.workflowRun?.workflow?.name ?? c.checkSuite?.app?.slug ?? ''
    const name = clean((names.get(raw) ?? 0) > 1 && wf ? `${raw} (${wf})` : raw)
    return { key: `check:${wf}:${raw}`, name, phase: 'checks', state: runState(c.status, c.conclusion, c.startedAt), startedAt: c.startedAt ?? undefined, completedAt: c.completedAt ?? undefined, link: c.detailsUrl, optional: c.isRequired === false }
  })
  steps.push(...checks.sort(byStart))

  // 2. a review, only when GitHub reports one is required or someone was asked for one
  if (i.reviewDecision || (i.reviewRequests ?? 0) > 0) {
    const state: StepState = merged || i.reviewDecision === 'APPROVED' ? 'done' : i.reviewDecision === 'CHANGES_REQUESTED' ? 'failed' : 'waiting'
    const name = i.reviewDecision === 'CHANGES_REQUESTED' ? 'review: changes requested' : 'review'
    steps.push({ key: 'review', name, phase: 'review', state })
  }

  // 3. the merge queue, only when the PR is (or was) in one
  if (i.queue || i.sawQueue) {
    const pos = i.queue?.position
    steps.push({ key: 'queue', name: pos ? `merge queue #${pos}` : 'merge queue', phase: 'queue', state: merged ? 'done' : i.queue ? 'running' : 'waiting' })
  }

  // 4. the merge itself; a PR closed without merging stops here
  steps.push({ key: 'merge', name: 'merge', phase: 'merge', state: merged ? 'done' : i.state === 'CLOSED' ? 'skipped' : 'waiting', completedAt: i.mergedAt ?? undefined })

  // 5. what the merge commit set off: every workflow job, then every deployment
  if (i.state === 'CLOSED') return steps
  const after: Step[] = []
  for (const s of i.suites ?? []) {
    const wf = s.workflowRun?.workflow?.name ?? s.app?.slug ?? undefined
    for (const r of s.checkRuns.nodes) {
      const name = clean(afterMergeName(wf, r.name))
      after.push({ key: `after:${name}`, name, phase: 'after merge', state: runState(r.status, r.conclusion, r.startedAt), startedAt: r.startedAt ?? undefined, completedAt: r.completedAt ?? undefined, link: r.detailsUrl })
    }
  }
  for (const d of i.deployments ?? []) {
    const name = clean(`deploy ${d.environment ?? ''}`.trim())
    const state = deploymentState(d.latestStatus?.state)
    after.push({ key: `after:${name}`, name, phase: 'after merge', state, startedAt: d.createdAt ?? undefined, completedAt: state === 'done' || state === 'failed' ? d.latestStatus?.createdAt ?? undefined : undefined })
  }
  // before the merge (and in the first moments after it, before GitHub registers the runs) the
  // last merge's after-merge steps stand in, so the denominator does not jump at the merge
  if (!after.length && i.expectedAfter?.length) {
    for (const name of i.expectedAfter) after.push({ key: `after:${name}`, name, phase: 'after merge', state: 'waiting', expected: true })
  } else after.sort(byStart)
  steps.push(...after)
  return steps
}

// how long a merge waits for its after-merge runs to appear before it counts as settled with none
export const AFTER_MERGE_GRACE_MS = 180_000

export const median = (xs: number[]) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// k of n steps done and the percent; a running step adds its elapsed time over this repo's median
// for that step (capped at 99% of a step). A failed step freezes the percent at the steps done.
export function progress(steps: Step[], now: number, medians: Record<string, number[]> = {}, mergedAt?: string | null): Progress {
  const counted = steps.filter(s => s.state !== 'skipped' && !(s.optional && s.state === 'failed'))
  const n = counted.length
  const k = counted.filter(s => s.state === 'done').length
  const failed = counted.find(s => s.state === 'failed')
  let partial = 0
  if (!failed) {
    for (const s of counted) {
      if (s.state !== 'running' || !s.startedAt) continue
      const m = median(medians[s.name] ?? [])
      if (m && m > 0) partial += Math.min(0.99, Math.max(0, (now - Date.parse(s.startedAt)) / m))
    }
  }
  const pct = n === 0 ? 0 : k === n ? 100 : Math.min(99, Math.floor((100 * (k + partial)) / n))
  const current = failed ?? counted.find(s => s.state !== 'done')
  const after = steps.filter(s => s.phase === 'after merge')
  const merged = steps.some(s => s.key === 'merge' && s.state === 'done')
  const closed = steps.some(s => s.key === 'merge' && s.state === 'skipped')
  const afterMergeFailed = merged && after.some(s => s.state === 'failed')
  // with no merge time there is nothing to wait out: settle on what is there
  const graceOver = !mergedAt || now - Date.parse(mergedAt) >= AFTER_MERGE_GRACE_MS
  const afterSettled = after.length
    ? after.every(s => !s.expected && (s.state === 'done' || s.state === 'skipped'))
    : graceOver
  return { k, n, pct, current, failed, afterMergeFailed, settled: closed || (merged && afterSettled) }
}

// a step that just finished adds its duration to this repo's history for that step name: the last
// 20 per name, at most 200 names per repo (the oldest-named drop first)
export function recordDurations(history: Record<string, number[]>, prev: Step[] | undefined, next: Step[]): Record<string, number[]> {
  const before = new Map((prev ?? []).map(s => [s.key, s.state]))
  const out: Record<string, number[]> = { ...history }
  for (const s of next) {
    if (s.state !== 'done' || before.get(s.key) === 'done' || !s.startedAt || !s.completedAt || s.expected) continue
    const ms = Date.parse(s.completedAt) - Date.parse(s.startedAt)
    if (!(ms > 0)) continue
    out[s.name] = [...(out[s.name] ?? []), ms].slice(-20)
  }
  const names = Object.keys(out)
  for (const name of names.slice(0, Math.max(0, names.length - 200))) delete out[name]
  return out
}

// the after-merge step names worth remembering for the next PR in this repo: only a settled
// merge's real runs (never a stand-in list, never a half-registered one)
export function afterMergeNames(steps: Step[], p: Progress): string[] | undefined {
  if (!p.settled || p.afterMergeFailed) return undefined
  const after = steps.filter(s => s.phase === 'after merge' && !s.expected)
  return after.length ? after.map(s => s.name) : undefined
}

// what changed in the after-merge steps between two polls, for the alert flow: a job or deploy that
// failed, or every after-merge step finishing green
export function afterMergeChanges(prev: Step[] | undefined, next: Step[]): { changes: string[]; failed: Step[] } {
  if (!prev) return { changes: [], failed: [] }
  const before = new Map(prev.map(s => [s.key, s.state]))
  const failed = next.filter(s => s.phase === 'after merge' && s.state === 'failed' && before.get(s.key) !== 'failed')
  const changes = failed.map(s => `${s.name}: ${before.get(s.key) ?? 'new'} → fail`)
  const after = next.filter(s => s.phase === 'after merge' && !s.expected)
  const wasDone = prev.filter(s => s.phase === 'after merge' && !s.expected).every(s => s.state === 'done' || s.state === 'skipped')
  if (after.length && !wasDone && after.every(s => s.state === 'done' || s.state === 'skipped')) changes.push('after-merge runs: all green')
  return { changes, failed }
}

// the row's progress text: "step 3/12 · 25% · validate"
export function stepLabel(p: Progress): string {
  if (!p.n) return ''
  return `step ${p.k}/${p.n} · ${p.pct}%${p.current ? ` · ${p.current.name}` : ''}`
}
export const STEP_ICON: Record<StepState, [string, string]> = { done: ['✓', 'green'], running: ['●', 'yellow'], waiting: ['○', 'gray'], failed: ['✗', 'red'], skipped: ['–', 'gray'] }
export const fmtDuration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
