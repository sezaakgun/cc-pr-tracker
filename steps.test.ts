import { expect, test } from 'claude-code/testing'
import { AFTER_MERGE_GRACE_MS, afterMergeChanges, afterMergeNames, discoverSteps, median, progress, recordDurations, runState, stepLabel } from './hooks/steps'
import type { HeadContext, Step, StepInput, Suite } from './hooks/steps'

// a PR's steps mirror what GitHub reports for it, one fixture per repo shape

const T = (min: number) => new Date(Date.UTC(2026, 10, 4, 12, min)).toISOString()
const check = (name: string, conclusion: string | null, started: number | null, isRequired = true, wf = 'ci'): HeadContext => ({
  __typename: 'CheckRun', name, isRequired, status: conclusion ? 'COMPLETED' : started === null ? 'QUEUED' : 'IN_PROGRESS', conclusion,
  startedAt: started === null ? null : T(started), completedAt: conclusion && started !== null ? T(started + 2) : null,
  detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name}`, checkSuite: { app: { slug: 'github-actions' }, workflowRun: { event: 'pull_request', workflow: { name: wf } } },
})
const suite = (workflow: string, jobs: [string, string | null, number | null][]): Suite => ({
  app: { slug: 'github-actions' }, workflowRun: { event: 'push', workflow: { name: workflow } },
  checkRuns: { nodes: jobs.map(([name, conclusion, started]) => ({ name, status: conclusion ? 'COMPLETED' : started === null ? 'QUEUED' : 'IN_PROGRESS', conclusion, startedAt: started === null ? null : T(started), completedAt: conclusion && started !== null ? T(started + 1) : null })) },
})
const base = (over: Partial<StepInput> = {}): StepInput => ({ state: 'OPEN', head: [], ...over })
const names = (steps: Step[]) => steps.map(s => `${s.phase}:${s.name}:${s.state}`)
const NOW = Date.parse(T(30))

test('runState: GitHub run status and conclusion to a step state', () => {
  expect(runState('QUEUED', null, null)).toBe('waiting')
  expect(runState('IN_PROGRESS', null, T(1))).toBe('running')
  expect(runState('COMPLETED', 'SUCCESS')).toBe('done')
  expect(runState('COMPLETED', 'NEUTRAL')).toBe('done')
  expect(runState('COMPLETED', 'SKIPPED')).toBe('skipped')
  expect(runState('COMPLETED', 'FAILURE')).toBe('failed')
  expect(runState('COMPLETED', 'CANCELLED')).toBe('failed')
})

test('shape: checks only (no review rule, no queue, no deploy): the steps end at merge', () => {
  const steps = discoverSteps(base({ head: [check('unit', 'SUCCESS', 2), check('lint', null, 1)] }))
  // in the order they started; no review step, no queue step, nothing after the merge
  expect(names(steps)).toEqual(['checks:lint:running', 'checks:unit:done', 'merge:merge:waiting'])
  const p = progress(steps, NOW)
  expect([p.k, p.n, p.current?.name]).toEqual([1, 3, 'lint'])
  expect(stepLabel(p)).toBe('step 1/3 · 33% · lint')
})

test('shape: a required review appears only when GitHub reports one', () => {
  expect(discoverSteps(base({ reviewDecision: 'REVIEW_REQUIRED' })).map(s => s.key)).toEqual(['review', 'merge'])
  expect(discoverSteps(base({ reviewRequests: 1 })).map(s => s.key)).toEqual(['review', 'merge'])
  expect(discoverSteps(base({ reviewDecision: null, reviewRequests: 0 })).map(s => s.key)).toEqual(['merge'])
  expect(discoverSteps(base({ reviewDecision: 'APPROVED' }))[0].state).toBe('done')
  const changes = discoverSteps(base({ reviewDecision: 'CHANGES_REQUESTED' }))[0]
  expect([changes.state, changes.name]).toEqual(['failed', 'review: changes requested'])
  // a merged PR's review is done whatever the decision says
  expect(discoverSteps(base({ state: 'MERGED', reviewDecision: 'REVIEW_REQUIRED' }))[0].state).toBe('done')
})

test('shape: the merge queue appears while queued and stays once seen', () => {
  const queued = discoverSteps(base({ queue: { position: 2, state: 'QUEUED' } }))
  expect(names(queued)).toEqual(['queue:merge queue #2:running', 'merge:merge:waiting'])
  // GitHub drops the entry at the merge; the tracker remembers it was queued
  expect(names(discoverSteps(base({ state: 'MERGED', sawQueue: true })))).toEqual(['queue:merge queue:done', 'merge:merge:done'])
  expect(discoverSteps(base({})).some(s => s.phase === 'queue')).toBe(false)
})

test('shape: a deploy workflow on the merge commit adds one step per job, named by workflow and job', () => {
  const steps = discoverSteps(base({
    state: 'MERGED', mergedAt: T(10), head: [check('validate', 'SUCCESS', 1)],
    suites: [suite('Publish to GitHub Packages', [['publish', null, 11]]), suite('Validate library', [['validate', 'SUCCESS', 11], ['plugin-cli', 'SUCCESS', 11]])],
  }))
  expect(steps.filter(s => s.phase === 'after merge').map(s => s.name).sort()).toEqual(['Publish to GitHub Packages: publish', 'Validate library: plugin-cli', 'Validate library: validate'])
  const p = progress(steps, NOW)
  expect([p.k, p.n, p.current?.name, p.settled]).toEqual([4, 5, 'Publish to GitHub Packages: publish', false])
})

test('shape: GitHub Deployments are steps too, by environment and latest status', () => {
  const steps = discoverSteps(base({
    state: 'MERGED', mergedAt: T(10),
    deployments: [{ environment: 'production', createdAt: T(12), latestStatus: { state: 'IN_PROGRESS' } }, { environment: 'preview', createdAt: T(11), latestStatus: { state: 'SUCCESS', createdAt: T(12) } }],
  }))
  expect(names(steps.filter(s => s.phase === 'after merge'))).toEqual(['after merge:deploy preview:done', 'after merge:deploy production:running'])
  const failed = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), deployments: [{ environment: 'production', createdAt: T(12), latestStatus: { state: 'FAILURE', createdAt: T(14) } }] }))
  const p = progress(failed, NOW)
  expect([p.afterMergeFailed, p.settled, p.failed?.name]).toEqual([true, false, 'deploy production'])
})

test('shape: a workflow job named like its workflow is not named twice', () => {
  const steps = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('publish', [['publish', 'SUCCESS', 11]])] }))
  expect(steps.at(-1)?.name).toBe('publish')
})

test('before the merge, the last merge\'s after-merge steps stand in, marked expected', () => {
  const expectedAfter = ['Publish: publish', 'Validate: validate']
  const open = discoverSteps(base({ head: [check('validate', 'SUCCESS', 1)], expectedAfter }))
  expect(names(open)).toEqual(['checks:validate:done', 'merge:merge:waiting', 'after merge:Publish: publish:waiting', 'after merge:Validate: validate:waiting'])
  expect(open.filter(s => s.expected).length).toBe(2)
  expect(stepLabel(progress(open, NOW))).toBe('step 1/4 · 25% · merge')
  // just merged, GitHub has not registered the runs yet: the stand-ins hold, not settled
  const justMerged = discoverSteps(base({ state: 'MERGED', mergedAt: T(29), expectedAfter }))
  expect(progress(justMerged, NOW, {}, T(29)).settled).toBe(false)
  // the real runs replace the stand-ins as soon as they appear
  const real = discoverSteps(base({ state: 'MERGED', mergedAt: T(29), expectedAfter, suites: [suite('Publish', [['publish', null, 29]])] }))
  expect(real.filter(s => s.expected)).toEqual([])
})

test('skipped steps are listed but never counted; a failing optional check neither counts nor halts', () => {
  const steps = discoverSteps(base({ head: [check('unit', 'SUCCESS', 1), check('e2e', 'SKIPPED', 1), check('docs', 'FAILURE', 1, false), check('lint', null, 2)] }))
  expect(steps.find(s => s.name === 'e2e')?.state).toBe('skipped')
  expect(steps.find(s => s.name === 'docs')?.optional).toBe(true)
  const p = progress(steps, NOW)
  expect([p.k, p.n, p.failed, p.current?.name]).toEqual([1, 3, undefined, 'lint'])
})

test('a failed required step halts the percent and becomes the current step', () => {
  const steps = discoverSteps(base({ head: [check('unit', 'SUCCESS', 1), check('lint', 'FAILURE', 2), check('e2e', null, 3)] }))
  const p = progress(steps, NOW, { e2e: [60_000] })
  // e2e's elapsed time would add to the percent, but a failure freezes it at the steps done
  expect([p.k, p.n, p.pct, p.current?.name, p.failed?.name]).toEqual([1, 4, 25, 'lint', 'lint'])
})

test('a running step adds elapsed over its median, capped below the next whole step', () => {
  const steps = discoverSteps(base({ head: [check('unit', 'SUCCESS', 1), check('e2e', null, 28)] }))
  // e2e started 2 minutes before NOW; its median is 4 minutes: half a step
  expect(progress(steps, NOW, { e2e: [240_000] }).pct).toBe(50) // (1 + 0.5) / 3
  // past its median it stops at 99% of a step
  expect(progress(steps, NOW, { e2e: [30_000] }).pct).toBe(66) // (1 + 0.99) / 3
  // no history: whole steps only
  expect(progress(steps, NOW).pct).toBe(33)
})

test('done rule: closed is settled; merged settles only when every after-merge step finished green', () => {
  expect(progress(discoverSteps(base({ state: 'CLOSED' })), NOW).settled).toBe(true)
  const green = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'SUCCESS', 11]])] }))
  expect(progress(green, NOW, {}, T(10))).toMatchObject({ settled: true, pct: 100, afterMergeFailed: false })
  const red = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'FAILURE', 11]])] }))
  expect(progress(red, NOW, {}, T(10))).toMatchObject({ settled: false, afterMergeFailed: true })
  // a re-run that goes green settles it
  const rerun = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'SUCCESS', 20]])] }))
  expect(progress(rerun, NOW, {}, T(10)).settled).toBe(true)
  // a repo with nothing after the merge settles once the grace window has passed
  const none = discoverSteps(base({ state: 'MERGED', mergedAt: T(29) }))
  expect(progress(none, NOW, {}, T(29)).settled).toBe(false)
  expect(progress(none, Date.parse(T(29)) + AFTER_MERGE_GRACE_MS, {}, T(29)).settled).toBe(true)
})

test('recordDurations: one entry per step finishing, last 20 per name, at most 200 names', () => {
  const prev = discoverSteps(base({ head: [check('unit', null, 1)] }))
  const next = discoverSteps(base({ head: [check('unit', 'SUCCESS', 1)] }))
  const h1 = recordDurations({}, prev, next)
  expect(h1).toEqual({ unit: [120_000] })
  // the same finished step on the next poll is not counted again
  expect(recordDurations(h1, next, next)).toEqual(h1)
  // bounded per name
  const long = recordDurations({ unit: Array(20).fill(1) }, prev, next)
  expect([long.unit.length, long.unit.at(-1)]).toEqual([20, 120_000])
  // bounded per repo
  const many: Record<string, number[]> = {}
  for (let i = 0; i < 205; i++) many[`s${i}`] = [1]
  expect(Object.keys(recordDurations(many, prev, next)).length).toBe(200)
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 2, 3])).toBe(2.5)
  expect(median([])).toBe(undefined)
})

test('afterMergeNames: only a settled, green merge\'s real runs are remembered for the next PR', () => {
  const green = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'SUCCESS', 11]])] }))
  expect(afterMergeNames(green, progress(green, NOW, {}, T(10)))).toEqual(['Publish: publish'])
  const running = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', null, 11]])] }))
  expect(afterMergeNames(running, progress(running, NOW, {}, T(10)))).toBeUndefined()
  const red = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'FAILURE', 11]])] }))
  expect(afterMergeNames(red, progress(red, NOW, {}, T(10)))).toBeUndefined()
})

test('afterMergeChanges: a failed after-merge job alerts once; all green alerts once', () => {
  const running = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', null, 11]])] }))
  const red = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'FAILURE', 11]])] }))
  const green = discoverSteps(base({ state: 'MERGED', mergedAt: T(10), suites: [suite('Publish', [['publish', 'SUCCESS', 11]])] }))
  expect(afterMergeChanges(undefined, red)).toEqual({ changes: [], failed: [] })
  const r = afterMergeChanges(running, red)
  expect([r.changes, r.failed.map(s => s.name)]).toEqual([['Publish: publish: running → fail'], ['Publish: publish']])
  expect(afterMergeChanges(red, red).changes).toEqual([])
  expect(afterMergeChanges(running, green).changes).toEqual(['after-merge runs: all green'])
  expect(afterMergeChanges(green, green).changes).toEqual([])
})
