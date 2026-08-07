# Pi Fusion

Automatic semantic routing from Pi to seven configurable 9Router model groups.

Set it up once, then prompt normally. Fusion classifies each request, selects the appropriate 9Router group, and shows the decision in Pi's footer. It does not manage tickets, plans, tools, worktrees, subagents, tests, or releases; Pi and Flicker already do those jobs.

## Install and set up

```bash
pi install /path/to/pi-fusion
```

Make the 9Router key available as `NINE_ROUTER_API_KEY`, then run once in Pi:

```text
/fusion-setup
```

The default mappings are:

| Profile | 9Router group |
|---|---|
| `fast` | `fusion-explore` |
| `code` | `fusion-sidekick` |
| `reason` | `fusion-plan` |
| `review` | `fusion-reviewer` |
| `research` | `fusion-research` |
| `vision` | `fusion-vision` |
| `design` | `fusion-design` |

Setup discovers the groups, runs one real inference probe through each, and enables automatic routing only when all seven pass.

Override mappings during setup when your group names differ:

```text
/fusion-setup fast=my-fast code=my-code reason=my-reason review=my-review research=my-research vision=my-vision design=my-design
```

## Use

Just use Pi normally:

```text
Inspect the inventory pages and improve their usability.
```

The footer shows the latest decision:

```text
fusion: active · plan → design · fusion-design
```

Low-confidence, unavailable, manually overridden, setup-blocked, and restoration-failure states are shown explicitly. Fusion never intercepts tools or creates an approval workflow.

## See what models are in use (main agent and subagents)

```text
/fusion-routing
```

Every session (the main agent and each subagent, which is its own Pi session) appends a content-free entry for each routing decision. The command groups them by session and shows, for each agent/subagent, the current model and why it switched:

```text
fusion routing:
  session 3f1a…
    now: fusion-sidekick (code)
    switched to fusion-sidekick because writing code · 92%
    switched to fusion-explore because exploring the codebase · 87%
  session 8b2c…
    now: fusion-reviewer (review)
    switched to fusion-reviewer because reviewing the work · 90%
```

The raw log lives at `~/.pi/agent/extensions/pi-fusion.routing.jsonl`. Entries contain only session id, working directory, phase, profile, model transitions, and reason codes — never prompts, code, or tool output.

## Diagnostics

```text
/fusion
/fusion-status
/fusion-explain
/fusion-config
/fusion-setup-status
/fusion-routing
/fusion-mode active|shadow|off
```

These commands are optional. Normal use requires no Fusion command after setup.

- `active`: route every eligible request automatically.
- `shadow`: classify and display recommendations without switching models.
- `off`: disable routing.

Selecting a model manually pauses automatic routing so Fusion cannot fight the user. Run `/fusion-mode active` to resume automatic routing.

## Flicker

Flicker remains authoritative for planning, worktrees, implementation, testing, evidence, and release authority. Use the ordinary Flicker skills when relevant; Fusion stays out of their way.

## Development

```bash
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```
