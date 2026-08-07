# Using Pi Fusion

## First run

1. Install the package.
2. Ensure `NINE_ROUTER_API_KEY` is available to Pi.
3. Run:

```text
/fusion-setup
```

A successful setup reports:

```text
fusion setup: complete · 7/7 profiles passed · automatic routing active
```

That is the entire normal setup.

## Daily use

Prompt Pi normally. Fusion routes automatically and displays the selected phase, semantic profile, and 9Router group in the footer.

Examples:

- “Find where inventory rows are rendered.” → `fast`
- “Plan the inventory-page redesign.” → `reason` or `design`
- “Implement the approved change.” → `code`
- “Review this diff for regressions.” → `review`
- A prompt with an image → `vision` or `design`

Fusion does not block tools, create plans, or advance stages. Flicker skills continue to handle workflow in Flicker repositories.

## Custom group names

Pass only the mappings that differ:

```text
/fusion-setup code=my-code-group review=my-review-group
```

Setup re-runs all seven probes and returns to active mode only if every profile passes.

## Live agents widget

In the TUI, a widget above the editor shows how many Fusion agents are active. Press **ctrl+alt+f** to expand it; rows update every ~2 seconds with each agent's current model and why it switched:

```text
fusion: 2 agents routing · ctrl+alt+f for details   (collapsed)

fusion workers (2) · ctrl+alt+f to collapse
  main        fusion-sidekick · writing code
  reviewer    fusion-reviewer · reviewing the work
```

`/fusion-agents` prints the same summary in any mode.

## Status and troubleshooting

```text
/fusion-status
/fusion-explain
/fusion-config
/fusion-setup-status
/fusion-routing
/fusion-agents
```

`/fusion-routing` shows, per session (main agent and each subagent), the current model and why it was selected:

```text
switched to fusion-sidekick because writing code
switched to fusion-explore because exploring the codebase
switched to fusion-reviewer because reviewing the work
```

If the footer says:

- `setup required` — run `/fusion-setup`.
- `setup blocked` — inspect `/fusion-setup-status` and fix the named mapping/group.
- `retained current` — confidence was low or the recommended group was unavailable.
- `manual model` — you selected a model; run `/fusion-mode active` to resume automation.
- `restore failed` — inspect `/fusion-status`, then select the desired model manually.

## Disable temporarily

```text
/fusion-mode shadow
/fusion-mode off
/fusion-mode active
```

No workflow, tuning, delegation, approval, or dashboard commands are part of Fusion. Those concerns belong to Pi and Flicker.
