import { expect, mock, test } from 'claude-code/testing'

// The hooks against the engine: everything beneath the plugin is answered here, gh included.

const PR = 'https://github.com/org/repo/pull/7'
const TOOL = 'mcp__cc-pr-tracker__pr_status'

const run = (name: string, conclusion: string | null, isRequired = true) => ({
  __typename: 'CheckRun', name, isRequired,
  status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
  detailsUrl: `https://ci.example.com/${name}`, startedAt: '2026-10-05T10:00:00Z',
  checkSuite: { app: { slug: 'github-actions' }, workflowRun: { event: 'pull_request', workflow: { name: 'ci' } } },
})
const gql = (pr: Record<string, unknown> = {}, checks = [run('lint', null)]) => JSON.stringify({
  data: { repository: { pullRequest: {
    number: 7, title: 'Fix it', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
    ...pr,
  } } },
})

// the engine beneath the plugin; `w` records what the plugin did and `w.response` is what gh prints
// `old`: a build before 2.1.289, where $.session.root and $.ui.copy answer nothing
function world(on: any, store: Record<string, unknown> = {}, { old = false } = {}) {
  const w = { gh: 0, toasts: [] as string[], response: gql(), logs: [] as string[], opened: [] as string[], copied: [] as { text: string; surface?: string }[], copyResult: { isCopied: true } as Record<string, unknown>, ghError: '', bashStdout: '', runs: [] as string[][], notes: [] as string[], surfaces: ['terminal'] as string[], status: [] as (string | undefined)[], hold: undefined as Promise<void> | undefined, state: undefined as unknown, sessionId: 's1', respond: (argv: string[]) => w.response, refuse: (_argv: string[]) => '' }
  const clock = mock.clock(on)
  // $.store over `store` itself, so a test reads what the plugin wrote
  on('store.get', async (_$: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', async (_$: unknown, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', async (_$: unknown, e: any) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', async () => ({ value: Object.keys(store) }))
  mock.env(on, {})
  const ok = (value?: unknown) => async () => ({ value })
  for (const ev of ['session.start', 'session.end']) on(ev, async (_$: unknown, e: any) => e)
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer }))
  on('prompt.submit', async (_$: unknown, e: any) => ({ text: e.text }))
  on('config.set', async (_$: unknown, e: any) => ({ value: e.value }))
  on('fs.exists', ok(false))
  on('config.list', ok([]))
  on('config.describe', async (_$: unknown, e: any) => ({ label: e.label, description: e.description, isHidden: e.isHidden }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: w.bashStdout, stderr: '', interrupted: false } }))
  if (!old) {
    on('session.root', ok('/repo'))
    on('session.id', async () => ({ value: w.sessionId }))
    on('state.get', async () => ({ value: { value: w.state, version: 0 } }))
    on('state.set', async (_$: unknown, e: any) => { w.state = e.value; return { value: { isSet: true, version: 1 } } })
    on('session.surfaces', async () => ({ value: w.surfaces }))
    on('ui.status', async (_$: unknown, e: any) => { w.status.push(e.text); return { value: undefined } })
    on('command.register', async (_$: unknown, e: any) => ({ value: { command: e.name } }))
  }
  // a build that hands $.session.append to the test records the note here; 2.1.289 does not, and
  // the call fails beneath the plugin and is logged
  if (!old) on('session.append', async (_$: unknown, e: any, next: any) => { w.notes.push(e.message.content[0].text); return next(e) })
  on('tool.register', ok({ tool: TOOL }))
  on('process.run', async (_$: unknown, e: any) => {
    w.runs.push([...e.argv])
    if (e.argv[0] !== 'gh') return { value: { stdout: '', stderr: '', exitCode: 0 } }
    if (w.hold) await w.hold
    w.gh++
    const error = w.ghError || w.refuse(e.argv)
    return { value: error ? { stdout: '', stderr: error, exitCode: 1 } : { stdout: w.respond(e.argv), stderr: '', exitCode: 0 } }
  })
  on('ui.close', ok())
  on('ui.open', async (_$: unknown, e: any) => { w.opened.push(e.id); return { value: undefined } })
  if (!old) on('ui.copy', async (_$: unknown, e: any) => { w.copied.push({ text: e.text, surface: e.surface }); return { value: w.copyResult } })
  // the engine's own drawing beneath the plugin's: nothing
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.log', async (_$: unknown, e: any) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.toast', async (_$: unknown, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  return { w, clock }
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const status = async ($: any, pr?: string) => ((await $.tool.call({ tool: TOOL, ...(pr ? { pr } : {}) })) as any).result as string

test('a prompt that is only a PR URL toggles the watch without a turn', async ($, on) => {
  const { w } = world(on)
  await start($)
  expect(await $.prompt.submit({ text: PR, wait: false })).toEqual({ drop: 'watching org/repo#7' })
  expect(w.gh).toBe(1)
  expect(await status($)).toContain('org/repo#7')
  expect(await $.prompt.submit({ text: ` ${PR} `, wait: false })).toEqual({ drop: 'stopped watching org/repo#7' })
  expect(await status($)).toContain('No PRs are watched')
})

test('a required check failing alerts and tells Claude, with the log link', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  expect(w.toasts).toEqual([]) // the first load never alerts
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['repo#7 lint: pending → fail'])
  // the note itself: claude plugin test on 2.1.289 never hands $.session.append to a test's hook, so
  // there the call fails beneath the plugin and is logged; its text is changeNote's, tested in register.test.ts
  expect(w.notes.some(n => n.includes('"lint" https://ci.example.com/lint')) || w.logs.some(l => l.includes('$.session.append'))).toBe(true)
  // a terminal draws the band, so the transcript and the status line stay clear
  expect(w.logs.filter(l => l.includes('repo#7'))).toEqual([])
  expect(w.status.filter(Boolean)).toEqual([])
})

test('Tell Claude about changes off: the toast stays, the note goes', { options: { notifyClaude: false } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.toasts.length).toBe(1)
  expect(w.notes).toEqual([])
  expect(w.logs.some(l => l.includes('$.session.append'))).toBe(false)
  expect(w.notes).toEqual([])
})

test('Alert on "failures only": a check passing does not alert', { options: { alertOn: 'failures only' } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({}, [run('lint', 'SUCCESS')])
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
  expect(await status($)).toContain('pass lint')
})

test('Poll every: the timer follows the setting', { options: { pollSeconds: 300 } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await clock.advance(60_000)
  expect(w.gh).toBe(1)
  await clock.advance(240_000)
  expect(w.gh).toBe(2)
})

test('Poll every below 30 seconds polls every 30', { options: { pollSeconds: 5 } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await clock.advance(29_000)
  expect(w.gh).toBe(1)
  await clock.advance(1_000)
  expect(w.gh).toBe(2)
})

test('pr_status polls GitHub when called', async ($, on) => {
  const { w } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }, [run('lint', 'SUCCESS')])
  const text = await status($, 'org/repo#7')
  expect(w.gh).toBe(2)
  expect(text).toContain('merge clean')
  expect(text).toContain('pass lint https://ci.example.com/lint')
  expect(await status($, 'org/other#1')).toBe('org/other#1 is not watched. Watched: org/repo#7.')
})

test('a resumed session watches its stored PRs, minus merged ones', async ($, on) => {
  const merged = 'https://github.com/org/repo/pull/8'
  const { w } = world(on, { 'session:s1': { at: 0, prs: [{ url: PR, auto: false }, { url: merged, auto: false }] } })
  w.respond = argv => argv.includes('n=8') ? gql({ number: 8, state: 'MERGED' }) : w.response
  await start($)
  const text = await status($)
  expect(text).toContain('org/repo#7')
  expect(text).not.toContain('org/repo#8')
})

test('a new session in the same project starts empty, and stale sessions are pruned', async ($, on) => {
  const store: Record<string, unknown> = { 'session:old': { at: 0, prs: [{ url: PR }] }, 'session:recent': { at: 30 * 24 * 3600_000, prs: [{ url: PR }] }, 'watched:/repo': [{ url: PR }] }
  const { w, clock } = world(on, store)
  w.sessionId = 's2'
  await clock.advance(31 * 24 * 3600_000)
  await start($)
  expect(await status($)).toContain('No PRs are watched')
  expect(store['session:old']).toBeUndefined()
  expect(store['session:recent']).toBeDefined()
  await $.prompt.submit({ text: PR, wait: false })
  await status($)
  expect((store['session:s2'] as any).prs).toEqual([{ url: PR, auto: false }])
})

test('Remember "this project": a new session watches the project\'s PRs, stored before 0.4 too', { options: { remember: 'this project' } }, async ($, on) => {
  const { w } = world(on, { 'watched:/repo': [{ url: PR, auto: false }] })
  w.sessionId = 's2'
  await start($)
  expect(await status($)).toContain('org/repo#7')
})

test('switching Remember to "this project" in /config stores the list for the project at once', async ($, on) => {
  const store: Record<string, unknown> = {}
  world(on, store)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await status($)
  await $.config.set({ key: 'cc-pr-tracker.remember', value: 'this project' } as any)
  expect((store['watched:/repo'] as any).prs.map((p: any) => p.url)).toEqual([PR])
})

test('/clear moves the list to the new session id, leaving the old one for a resume', async ($, on) => {
  const store: Record<string, unknown> = {}
  const { w } = world(on, store)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await $.turn.complete({ answer: 'Opened https://github.com/org/repo/pull/9 for you.' } as any)
  w.sessionId = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  expect((store['session:s1'] as any).prs.length).toBe(2)
  expect((store['session:s2'] as any).prs.map((p: any) => p.url)).toEqual([PR])
})

test('/clear drops the PRs Claude brought in and keeps the pasted ones', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await $.turn.complete({ answer: 'Opened https://github.com/org/repo/pull/9 for you.' } as any)
  expect(await status($)).toContain('org/repo#9')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  const text = await status($)
  expect(text).toContain('org/repo#7')
  expect(text).not.toContain('org/repo#9')
})

test('Auto-watch off: a PR in Claude\'s answer is not watched', { options: { autoWatch: 'off' } }, async ($, on) => {
  world(on)
  await start($)
  await $.turn.complete({ answer: 'See https://github.com/org/repo/pull/9' } as any)
  expect(await status($)).toContain('No PRs are watched')
})

test('gh failing keeps the last values, marks the line and never alerts', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.ghError = 'HTTP 502: Bad Gateway'
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
  const ui = await band($, 'terminal')
  expect(await texts(ui)).toContain('refresh failed')
  expect(await texts(ui)).toContain('blocked')
  // back with nothing changed since the last good poll: still no alert
  w.ghError = ''
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
  expect(await texts(ui)).not.toContain('refresh failed')
})

const ghPrCreate = ($: any) => $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

test('the PR `gh pr create` prints is watched', async ($, on) => {
  const { w } = world(on)
  await start($)
  w.bashStdout = 'https://github.com/org/repo/pull/9\n'
  await ghPrCreate($)
  expect(await status($)).toContain('org/repo#9')
})

test('Auto-watch "gh pr create only": the created PR is watched, one in an answer is not', { options: { autoWatch: 'gh pr create only' } }, async ($, on) => {
  const { w } = world(on)
  await start($)
  await $.turn.complete({ answer: 'See https://github.com/org/repo/pull/8' } as any)
  w.bashStdout = 'https://github.com/org/repo/pull/9\n'
  await ghPrCreate($)
  const text = await status($)
  expect(text).toContain('org/repo#9')
  expect(text).not.toContain('org/repo#8')
})

test('Auto-watch off: not even the created PR is watched', { options: { autoWatch: 'off' } }, async ($, on) => {
  const { w } = world(on)
  await start($)
  w.bashStdout = 'https://github.com/org/repo/pull/9\n'
  await ghPrCreate($)
  expect(await status($)).toContain('No PRs are watched')
})

test('a merged PR Claude only mentions is not watched', async ($, on) => {
  const { w } = world(on)
  w.respond = argv => gql({ number: 9, state: argv.includes('n=9') ? 'MERGED' : 'OPEN' })
  await start($)
  await $.turn.complete({ answer: 'That was https://github.com/org/repo/pull/9' } as any)
  expect(await status($)).toContain('No PRs are watched')
})

test('Mute all, turned on in /config, mutes every line at once', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await $.config.set({ key: 'cc-pr-tracker.muteAll', value: true, previous: false, provider: { plugin: 'cc-pr-tracker', tier: 'user' }, origin: { kind: 'composer' } } as any)
  expect(await texts(await band($, 'terminal'))).toContain('· muted')
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
})

test('the Mute all row says how many PRs are watched and muted', async ($, on) => {
  world(on)
  const describe = async () => ((await $.config.describe({ key: 'cc-pr-tracker.muteAll', label: 'Mute all PR alerts', description: 'Silences alerts.', isHidden: false, provider: { plugin: 'cc-pr-tracker', tier: 'user' } } as any)) as any).description
  await start($)
  expect(await describe()).toBe('Silences alerts. No PRs are watched now.')
  await $.prompt.submit({ text: `${PR} https://github.com/org/repo/pull/8`, wait: false })
  await (await band($, 'terminal')).press({ key: 'mute:pr-repo-8' })
  expect(await describe()).toBe('Silences alerts. Now watching 2 PRs, 1 muted one by one.')
})

test('a hot reload draws the list kept in $.state, without waiting for gh', async ($, on) => {
  const { w } = world(on)
  w.state = [{
    url: PR, id: 'org/repo#7', label: 'repo#7', pane: 'pr-repo-7', required: [], others: [], updated: 0,
    view: { number: 7, title: 'Kept title', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' },
  }]
  await start($)
  const shown = await texts(await band($, 'terminal'))
  expect(shown).toContain('Kept title')
  expect(shown).toContain('clean')
  expect(w.gh).toBe(0)
})

test('on a build before 2.1.289 it watches and alerts as before, in memory', async ($, on) => {
  const { w, clock } = world(on, {}, { old: true })
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['repo#7 lint: pending → fail'])
  const ui = await band($, 'terminal')
  await ui.press({ key: 'copy:pr-repo-7' })
  expect(w.toasts[1]).toBe('could not copy: needs Claude Code 2.1.289 or later')
  // each missing call logged once, however often it was tried
  const missing = w.logs.filter(l => l.includes('unavailable'))
  expect(missing.length).toBe(new Set(missing.map(l => l.split(' unavailable')[0])).size)
  // ($.state is the test engine's own, so it never goes missing here; newer test engines answer
  // $.session.append themselves, so it goes missing only on some)
  // (/prs and the surfaces are missing too: such a build draws the band and nothing else)
  expect(missing.map(l => l.split(' unavailable')[0]).filter(name => !name.endsWith('$.session.append')).sort()).toEqual(['cc-pr-tracker: $.command.register', 'cc-pr-tracker: $.session.id', 'cc-pr-tracker: $.session.surfaces', 'cc-pr-tracker: $.ui.copy'])
})

test('a PR URL inside a normal prompt is watched and the prompt still runs', async ($, on) => {
  world(on)
  await start($)
  const text = `why is ${PR} red?`
  expect(await $.prompt.submit({ text, wait: false })).toEqual({ text })
  expect(await status($)).toContain('org/repo#7')
})

test('the line says loading until the first poll answers, and gh failed when it fails', async ($, on) => {
  const { w } = world(on)
  let answer = () => {}
  w.hold = new Promise<void>(resolve => { answer = resolve })
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  const ui = await band($, 'terminal')
  expect(await texts(ui)).toContain('repo#7 loading…')
  w.ghError = 'HTTP 401: Bad credentials'
  answer()
  w.hold = undefined
  await $.tool.call({ tool: TOOL }) // waits for the held poll, then polls again
  expect(await texts(ui)).toContain('repo#7 gh failed: HTTP 401: Bad credentials')
})

test('a change flashes the strip above the lines for a second', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  const ui = await band($, 'terminal')
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(await texts(ui)).toContain('● PR checks changed')
  await clock.advance(1_000)
  expect(await texts(ui)).not.toContain('PR checks changed')
})

test('the lines step aside while a survey is shown', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  const ui = await $.ui.mount({ plugin: 'cc-pr-tracker', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: true, isWorking: false, maxRows: 20, bodyColumns: 120 } as any, viewport: { columns: 120, rows: 40 } })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('a draft PR says draft', async ($, on) => {
  const { w } = world(on)
  w.response = gql({ isDraft: true, mergeStateStatus: 'DRAFT' })
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  expect(await texts(await band($, 'terminal'))).toContain(' draft · ')
})

test('Stop watching merged or closed PRs: a PR that merges leaves the list', { options: { stopWhenDone: true } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({ state: 'MERGED', mergeStateStatus: 'UNKNOWN' })
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['repo#7 merged · stopped watching'])
  expect(await status($)).toContain('No PRs are watched')
})

test('a merged PR keeps its line by default', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({ state: 'MERGED', mergeStateStatus: 'UNKNOWN' })
  await clock.advance(60_000)
  expect(await status($)).toContain('state merged')
})

test('turning Stop watching merged or closed PRs on drops the ones already done', async ($, on) => {
  const { w } = world(on)
  w.response = gql({ state: 'CLOSED', mergeStateStatus: 'UNKNOWN' })
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  expect(await status($)).toContain('state closed')
  await $.config.set({ key: 'cc-pr-tracker.stopWhenDone', value: true } as any)
  expect(await status($)).toContain('No PRs are watched')
})

test('Count all checks: an optional check failing counts and alerts', { options: { allChecks: true } }, async ($, on) => {
  const { w, clock } = world(on)
  w.response = gql({}, [run('lint', 'SUCCESS'), run('docs', null, false)])
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({}, [run('lint', 'SUCCESS'), run('docs', 'FAILURE', false)])
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['repo#7 docs: pending → fail'])
  const shown = await texts(await band($, 'terminal'))
  expect(shown).toContain('✓1')
  expect(shown).toContain('✗1')
  expect(shown).not.toContain('optional ✗')
  expect(await status($)).toContain('optional checks (1):\n    fail docs')
})

test('by default an optional check failing does not alert', async ($, on) => {
  const { w, clock } = world(on)
  w.response = gql({}, [run('lint', 'SUCCESS'), run('docs', null, false)])
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({}, [run('lint', 'SUCCESS'), run('docs', 'FAILURE', false)])
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
  expect(await texts(await band($, 'terminal'))).toContain('(+1 optional ✗)')
})

test('Alert on review changes: an approval alerts, even under "failures only"', { options: { alertOnReview: true, alertOn: 'failures only' } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({ reviewDecision: 'APPROVED' })
  await clock.advance(60_000)
  expect(w.toasts).toEqual(['repo#7 review: review required → approved'])
})

test('a review change does not alert by default', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  w.response = gql({ reviewDecision: 'APPROVED' })
  await clock.advance(60_000)
  expect(w.toasts).toEqual([])
})

test('Flash strip off: an alert toasts without the strip', { options: { flash: false } }, async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  const ui = await band($, 'terminal')
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.toasts.length).toBe(1)
  expect(await texts(ui)).not.toContain('PR checks changed')
})

// ---- where no band is drawn: claude.ai/code on the web, the mobile app

const prs = async ($: any, args = '') => ((await $.command.run({ command: 'prs', args })) as any).text as string

test('/prs prints each PR with its failing and pending checks, and toggles the URLs given', async ($, on) => {
  const { w } = world(on)
  w.response = gql({}, [run('lint', 'FAILURE'), run('e2e', null), run('unit', 'SUCCESS'), run('docs', 'FAILURE', false)])
  await start($)
  expect(await prs($)).toBe('No PRs are watched. Paste a PR URL as the whole prompt, or run /prs <PR URL>.')
  const text = await prs($, PR)
  expect(text).toBe([
    'watching org/repo#7',
    'repo#7 · blocked · review required · ✓1 ✗1 ●1 (+1 optional ✗) · Fix it',
    `  ${PR}`,
    '  ✗ lint https://ci.example.com/lint',
    '  ● e2e https://ci.example.com/e2e',
    '  ✗ docs (optional) https://ci.example.com/docs',
  ].join('\n'))
  expect((await prs($, PR)).split('\n')[0]).toBe('stopped watching org/repo#7')
  expect(await status($)).toContain('No PRs are watched')
})

test('mobile: each PR\'s first status and every alert are transcript lines, summed up in the status line', async ($, on) => {
  const { w, clock } = world(on)
  w.surfaces = ['mobile']
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await status($)
  expect(w.logs).toContain('repo#7 · blocked · review required · ✓0 ●1 · Fix it')
  expect(w.status.at(-1)).toBe('PRs: repo#7 blocked ●1')
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.logs).toContain('repo#7 lint: pending → fail · ✗ lint https://ci.example.com/lint')
  expect(w.status.at(-1)).toBe('PRs: repo#7 blocked ✗1')
  await prs($, PR)
  expect(w.status.at(-1)).toBeUndefined()
})

test('desktop: the transcript lines stop once the band is drawn there', async ($, on) => {
  const { w, clock } = world(on)
  w.surfaces = ['desktop']
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await status($)
  expect(w.status.at(-1)).toBe('PRs: repo#7 blocked ●1')
  await band($, 'desktop')
  expect(w.status.at(-1)).toBeUndefined()
  w.response = gql({}, [run('lint', 'FAILURE')])
  await clock.advance(60_000)
  expect(w.logs.filter(l => l.includes('lint: pending → fail'))).toEqual([])
})

test('Show PRs in the transcript "never": a phone gets no lines', { options: { transcript: 'never' } }, async ($, on) => {
  const { w } = world(on)
  w.surfaces = ['mobile']
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  await status($)
  expect(w.logs.filter(l => l.includes('repo#7'))).toEqual([])
  expect(w.status.filter(Boolean)).toEqual([])
})

test('GitHub refusing GraphQL: polls go over REST, required checks from the branch protection', async ($, on) => {
  const { w } = world(on)
  const REST: Record<string, unknown> = {
    'repos/org/repo/pulls/7': { number: 7, title: 'Fix it', state: 'open', draft: false, merged_at: null, mergeable: true, mergeable_state: 'blocked', base: { ref: 'main' }, head: { sha: 'abc' }, requested_reviewers: [], requested_teams: [] },
    'repos/org/repo/commits/abc/check-runs?per_page=100': { check_runs: [
      { name: 'lint', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example.com/lint', started_at: '2026-10-05T10:00:00Z', app: { slug: 'github-actions' } },
      { name: 'docs', status: 'in_progress', conclusion: null, html_url: 'https://github.com/org/repo/runs/2', started_at: '2026-10-05T10:00:00Z', app: { slug: 'github-actions' } },
    ] },
    'repos/org/repo/commits/abc/status?per_page=100': { statuses: [{ context: 'ci/legacy', state: 'success', target_url: 'https://ci.example.com/legacy', created_at: '2026-10-05T10:00:00Z' }] },
    'repos/org/repo/pulls/7/reviews?per_page=100': [{ state: 'CHANGES_REQUESTED', user: { login: 'a' } }, { state: 'APPROVED', user: { login: 'a' } }],
    'repos/org/repo/branches/main': { protection: { required_status_checks: { contexts: ['ci/legacy'], checks: [] } } },
    'repos/org/repo/rules/branches/main': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }],
  }
  w.refuse = argv => argv[2] === 'graphql' ? 'gh: GitHub GraphQL is not available from Claude Code sessions; use the REST API (HTTP 403)' : ''
  w.respond = argv => JSON.stringify(REST[argv[2]])
  await start($)
  await $.prompt.submit({ text: PR, wait: false })
  const text = await status($)
  expect(text).toContain('merge blocked (mergeable) · approved')
  expect(text).toContain('required checks (2):')
  expect(text).toContain('fail lint https://ci.example.com/lint')
  expect(text).toContain('pass ci/legacy https://ci.example.com/legacy')
  expect(text).toContain('1 optional checks in all')
  expect(w.logs).toContain('GitHub refused GraphQL; polling over the REST API from now on')
  // GraphQL is asked once, then never again
  await status($)
  expect(w.runs.filter(argv => argv[2] === 'graphql').length).toBe(1)
})

// ---- what is drawn, on each surface that draws the band and panes

const SURFACES = ['terminal', 'desktop'] as const
const band = ($: any, surface: string) => $.ui.mount({ plugin: 'cc-pr-tracker', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 }, viewport: { columns: 120, rows: 40 } })
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('|')

for (const surface of SURFACES) {
  test(`${surface}: the band shows an open PR's state, review and required checks`, async ($, on) => {
    const { w } = world(on)
    w.response = gql({}, [run('lint', 'SUCCESS'), run('e2e', null), run('docs', 'FAILURE', false)])
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    const ui = await band($, surface)
    expect((await ui.find({ type: 'Link' }))?.text).toBe('repo#7')
    const shown = await texts(ui)
    for (const part of ['blocked', 'review required', '✓1', '●1', '(+1 optional ✗)', 'Fix it']) expect(shown).toContain(part)
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key)).toEqual(['open:pr-repo-7', 'copy:pr-repo-7', 'mute:pr-repo-7', 'details:pr-repo-7', 'stop:pr-repo-7'])
  })

  test(`${surface}: a merged PR is one struck-through line`, async ($, on) => {
    const { w } = world(on)
    w.response = gql({ state: 'MERGED', mergeStateStatus: 'UNKNOWN' })
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    const ui = await band($, surface)
    const struck = (await ui.findAll({ type: 'Text' })).filter((t: any) => t.props.strikethrough).map((t: any) => t.text)
    expect(struck.join('|')).toContain('repo#7')
    expect(struck.join('|')).toContain('merged')
    expect(struck.join('|')).toContain('Fix it')
    expect(await texts(ui)).not.toContain('review required')
  })

  test(`${surface}: copy puts the PR URL on that surface's clipboard`, async ($, on) => {
    const { w } = world(on)
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    const ui = await band($, surface)
    await ui.press({ key: 'copy:pr-repo-7' })
    expect(w.copied).toEqual([{ text: PR, surface }])
    expect(w.toasts).toEqual([`copied ${PR}`])
    w.copyResult = { isCopied: false, reason: 'no-clipboard' }
    await ui.press({ key: 'copy:pr-repo-7' })
    expect(w.toasts[1]).toBe('could not copy: no-clipboard')
  })

  test(`${surface}: mute marks the line and silences its alerts`, async ($, on) => {
    const { w, clock } = world(on)
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    const ui = await band($, surface)
    await ui.press({ key: 'mute:pr-repo-7' })
    expect(await texts(ui)).toContain('· muted')
    expect((await ui.find({ key: 'mute:pr-repo-7' }))?.text).toBe('unmute')
    w.response = gql({}, [run('lint', 'FAILURE')])
    await clock.advance(60_000)
    expect(w.toasts).toEqual([])
    expect(await texts(ui)).toContain('✗1')
  })

  test(`${surface}: open opens the PR in the browser, from the line and from the panel`, async ($, on) => {
    const { w } = world(on)
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    await (await band($, surface)).press({ key: 'open:pr-repo-7' })
    const pane = await $.ui.mount({ plugin: 'cc-pr-tracker', surface, component: 'Pane', requestId: 'pr-repo-7', props: { title: 'org/repo#7', isFocused: true, bodyColumns: 80 } as any, viewport: { columns: 80, rows: 30 } })
    await pane.press({ key: 'pane-open:pr-repo-7' })
    expect(w.runs.filter(argv => argv[0] === 'open')).toEqual([['open', PR], ['open', PR]])
  })

  test(`${surface}: × stops watching and removes the line`, async ($, on) => {
    world(on)
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    const ui = await band($, surface)
    await ui.press({ key: 'stop:pr-repo-7' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await status($)).toContain('No PRs are watched')
  })

  test(`${surface}: details opens the PR's pane, listing every required check and failing optional one`, async ($, on) => {
    const { w } = world(on)
    w.response = gql({}, [run('lint', 'FAILURE'), run('unit', 'SUCCESS'), run('docs', 'FAILURE', false), run('style', 'SUCCESS', false)])
    await start($)
    await $.prompt.submit({ text: PR, wait: false })
    await (await band($, surface)).press({ key: 'details:pr-repo-7' })
    expect(w.opened).toEqual(['pr-repo-7'])
    const pane = await $.ui.mount({ plugin: 'cc-pr-tracker', surface, component: 'Pane', requestId: 'pr-repo-7', props: { title: 'org/repo#7', isFocused: true, bodyColumns: 80 } as any, viewport: { columns: 80, rows: 30 } })
    const shown = await texts(pane)
    for (const part of ['Fix it', 'Required checks (2)', '(optional)', '+ 2 optional checks']) expect(shown).toContain(part)
    expect((await pane.findAll({ type: 'Link' })).map((l: any) => l.text)).toEqual(['lint', 'unit', 'docs'])
    await pane.press({ key: 'pane-copy:pr-repo-7' })
    expect(w.copied).toEqual([{ text: PR, surface }])
  })
}
