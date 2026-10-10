Screenshots and the demo GIF referenced by ../README.md.

The images below are still the ones from the first commit, recorded on Claude Code 2.1.269 before hover
buttons, mute, copy, alerts to Claude, `pr_status`, `/config` and `/prs` existed. Each one listed under "To record"
replaces or adds the file of that name; the README already points at every name.

## How to record

- One real terminal session at 150x40, recorded with asciinema and rendered with agg, so every image has the same size
  (1373x800 at agg's defaults) and font. Stills are frames of a recording.
- Claude Code 2.1.289 or later, the plugin installed from the marketplace (not `--plugin-dir`), in a fresh
  directory so the banner shows no repo path worth hiding. Default `/config` values unless a scene says otherwise.
- Use public PRs, as before (microsoft/vscode works well: many required checks, PRs in every state). Pick them
  the same day so the states below are true while recording.
- Hover needs a terminal that reports the mouse; asciinema records the escape codes, so the hover shows in the
  replay.

## To record

- **demo.gif** (re-record). Paste three open PR URLs one at a time, each as the whole prompt; each line appears and
  fills in. Hover the third line so its buttons show, press `details`; the panel opens. Press `copy URL` in the
  panel so the `copied …` toast shows. About 20 seconds.
- **watch.png** (re-record). The first URL just pasted: the `Prompt dropped by a hook: watching owner/repo#N` line
  and the PR's line filled in above the prompt.
- **overview.png** (re-record). Five lines above the prompt, in this order: clean and approved; approved with checks
  still running (`●N`); `blocked` with a failing required check (`✗1`); any open PR muted from its `mute` button
  (ends in `· muted`); a merged PR (struck through, `merged` in magenta). Default `/config`, so **Stop watching merged or
  closed PRs** is off and the merged line stays.
- **hover.png** (new). The same five lines with the mouse over the third: `open copy mute details ×` at its end.
  Crop nothing; the other lines show no buttons, which is the point.
- **details.png** (re-record). The details panel open for the failing PR: title, `open · merge blocked (mergeable)
  · approved`, the `[ open in browser ] [ copy URL ] [ stop watching ]` row, the required checks with the one `✗`,
  and the `+ N optional checks · updated …` line.
- **alert.png** (new). The moment a required check changes: the white `● PR checks changed` strip above the lines and
  the toast, for example `vscode#335895 Linux / Electron: pending → fail`. Easiest with a PR of your own: push a
  commit that fails one required check and wait for it with the session open. The strip lasts one second, so take
  the frame from the recording.
- **pr-status.png** (new). Ask Claude "why is vscode#335895 red?" on the session above. The frame shows the
  `pr_status` tool call and Claude's answer naming the failing check with its log link.
- **config.png** (new). `/config` scrolled to the cc-pr-tracker rows, all twelve visible (scroll if they do not fit), with the cursor on
  **Mute all PR alerts** so its help text shows `Now watching 5 PRs, 1 muted one by one.`
- **web.png** (new). The same PRs followed from claude.ai/code in a browser, not the terminal (the plugin must be
  installed in that session's environment, and its repos added to the session). Run `/prs` so the list shows each
  line, its URL and the failing check's log link; then let a check change so the next transcript line, for example
  `cc-pr-tracker: repo#7 · blocked · review required · ✓1 ✗1 · …`, and the `PRs: …` status line show below it.
  A browser screenshot at about 1373x800, not an asciinema frame.
