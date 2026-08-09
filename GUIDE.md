# Using Pi Fission

## First run

1. Install the package.
2. Ensure `NINE_ROUTER_API_KEY` is available to Pi.
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

Prompt Pi normally. Fission routes automatically and displays the selected phase, semantic profile, and 9Router group in the footer.

Examples:

- “Find where inventory rows are rendered.” → `fast`
- “Plan the inventory-page redesign.” → `reason` or `design`
- “Implement the approved change.” → `code`
- “Review this diff for regressions.” → `review`
- A prompt with an image → `vision` or `design`

Fission does not block tools, create plans, or advance stages. Flicker skills continue to handle workflow in Flicker repositories.

## Custom group names

Pass only the mappings that differ:

```text
/fission-setup code=my-code-group review=my-review-group
```

Setup re-runs all seven probes and returns to active mode only if every profile passes.

## Live agents widget

In the TUI, a widget above the editor shows how many Fission agents are active. Press **ctrl+e** to expand it; rows update every ~2 seconds with each agent's current model and why it switched:

```text
fission: 2 agents routing · ctrl+e for details   (collapsed)

fission workers (2) · ctrl+e to collapse
  main        fission-sidekick · writing code
  reviewer    fission-reviewer · reviewing the work
```

`/fission-agents` prints the same summary in any mode.

## Status and troubleshooting

```text
/fission-status
/fission-explain
/fission-config
/fission-setup-status
/fission-routing
/fission-agents
```

`/fission-routing` shows, per session (main agent and each subagent), the current model and why it was selected:

```text
switched to fission-sidekick because writing code
switched to fission-explore because exploring the codebase
switched to fission-reviewer because reviewing the work
```

If the footer says:

- `setup required` — run `/fission-setup`.
- `setup blocked` — inspect `/fission-setup-status` and fix the named mapping/group.
- `retained current` — confidence was low or the recommended group was unavailable.
- `manual model` — you selected a model; run `/fission-mode active` to resume automation.
- `restore failed` — inspect `/fission-status`, then select the desired model manually.

## Disable temporarily

```text
/fission-mode shadow
/fission-mode off
/fission-mode active
```

No workflow, tuning, delegation, approval, or dashboard commands are part of Fission. Those concerns belong to Pi and Flicker.
