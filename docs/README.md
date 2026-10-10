Screenshots and the demo GIF referenced by ../README.md, recorded on Claude Code 2.1.296 with the plugin
loaded through `--plugin-dir`.

## How they were made

- One real Claude Code session in tmux at 150x40, captured with `tmux capture-pane -e -p -N` and drawn to
  PNG by `record/render.py` (DejaVu Sans Mono, dark background); `record/mkgif.py` turns a folder of captures
  taken every 0.1 seconds into the GIF, one frame per change.
- The PRs are made up (`acme/storefront`, `acme/api`). `record/gh` stands in for the GitHub CLI on `PATH`
  and answers the plugin's GraphQL call from `record/state/*.json`, so a check can be turned from pending to
  failing by editing a file, without touching any real CI.
- Hover and clicks are SGR mouse sequences sent with `tmux send-keys -H`; the mouse pointer itself is not
  drawn.
- `pr-status.png` is a real model turn: the prompt names the tool ("ask pr_status") so the answer uses it.
- `web.png` is a terminal stand-in, not claude.ai/code in a browser: the same session with **Show PRs in the
  transcript** set to `always`, so `/prs`, the transcript alert line and the status line show next to the band
  that the web does not draw.

## The scenes

- **demo.gif**: paste three PR URLs one at a time; each line appears and fills in. Hover the third so its buttons
  show, press `details`, then `copy URL` in the panel so the `copied …` toast shows.
- **watch.png**: the first URL just pasted: `Prompt dropped by a hook: watching acme/storefront#412` and its line.
- **overview.png**: five lines: clean and approved; checks still running; a failing required check; one muted from
  its `mute` button (`· muted`); a merged one, struck through. Default `/config`, so the merged line stays.
- **hover.png**: the same five lines with the mouse over the third: `open copy mute details ×` at its end.
- **alert.png**: the moment `integration-tests` turns from pending to failing: the `● PR checks changed` strip and
  the toast `api#87 integration-tests: pending → fail`.
- **details.png**: the details panel for the failing PR, its buttons and every required check.
- **config.png**: `/config` with `cc-pr` typed in its search box, all twelve rows.
- **pr-status.png**: "why is api#87 red? ask pr_status": the tool call and Claude's answer with the log link.
- **web.png**: see above.

To record again: `PATH=$PWD/docs/record:$PATH claude --plugin-dir .` in tmux, paste
`https://github.com/acme/storefront/pull/412`, `…/storefront/pull/418`, `https://github.com/acme/api/pull/87`,
`…/api/pull/91` and `…/storefront/pull/405`, then flip `integration-tests` in `record/state/acme-api-87.json`
to `fail` for the alert. In a dropped prompt Claude Code 2.1.296 keeps the URL in the input; it was cleared
with backspaces before each capture.
