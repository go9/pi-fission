# Using Pi Fission

## First run

1. Install the package.
2. Point `provider.baseUrl` at your OpenAI-compatible endpoint, and export the env var named by `provider.apiKey` if it is not loopback.
3. Run:

```text
/fission-setup
```

A successful setup reports:

```text
fission setup: complete · 7/7 profiles passed · automatic routing active
```

That is the entire normal setup.

## Daily use

Prompt Pi normally. Fission routes automatically and displays the selected phase, semantic profile, and model in the footer.

Examples:

- “Find where inventory rows are rendered.” → `fast`
- “Plan the inventory-page redesign.” → `reason` or `design`
- “Implement the approved change.” → `code`
- “Review this diff for regressions.” → `review`
- A prompt with an image → `vision` or `design`

Fission does not block tools, create plans, or advance stages. Workflow stays with whatever tooling you already use.

## Custom group names

Pass only the mappings that differ:

```text
/fission-setup code=my-code-group review=my-review-group
```

Setup re-runs all seven probes and returns to active mode only if every profile passes.

## Live agents widget

In the TUI, a widget above the editor shows how many Fission agents are active. Press **ctrl+e** to expand it; rows update every 5 seconds with each agent's current model and why it switched:

```text
fission: 2 agents routing · main fission-sidekick · ctrl+e for details   (collapsed)

fission workers (2) · ctrl+e to collapse
  main · fission-sidekick · writing code
  reviewer · fission-reviewer · reviewing the work
```

Outside the TUI, `/fission-routing` leads each session block with the same `now:` line.

## Status and troubleshooting

```text
/fission-setup      the seven mappings, each beside its probe result
/fission-routing    lifetime totals, then recent sessions and why each switched
```

`/fission-routing` shows, per session (main agent and each subagent), the current model and why it was selected:

```text
fission: 377 prompts · 105 routed (28%) · 65 sessions · since 2026-08-07
  fast 30 · code 23 · reason 22 · review 21 · research 7 · vision 2
  you overrode 7 routes (most often review, 4)

  session 3f1a9c2b-... · /Users/you/Sites/app
    now: fission-sidekick (code)
    switched to fission-explore because exploring the codebase · 74%
    switched to fission-sidekick because writing code · 91%
```

Only the three most recent real switches are listed per session, and only the ten most recently active sessions are rendered; anything beyond that is summarized as a count.

If the footer says:

- `setup required` — run `/fission-setup`.
- `setup blocked` — run `/fission-setup` and fix the mapping whose row reads `FAILED`.
- `retained current` — confidence was low or the recommended group was unavailable.
- `manual model` — you selected a model; run `/fission-mode active` to resume automation.
- `restore failed` — select the desired model manually.

## Disable temporarily

```text
/fission-mode shadow
/fission-mode off
/fission-mode active
```

No workflow, tuning, delegation, approval, or dashboard commands are part of Fission. Those concerns belong to Pi and your own tooling.
