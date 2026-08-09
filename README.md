# Pi Fission

Automatic semantic routing from Pi to seven configurable 9Router model groups.

Set it up once, then prompt normally. Fission classifies each request, selects the appropriate 9Router group, and shows the decision in Pi's footer. It does not manage tickets, plans, tools, worktrees, subagents, tests, or releases; Pi and Flicker already do those jobs.

## Install and set up

```bash
pi install /path/to/pi-fission
```

Make the 9Router key available as `NINE_ROUTER_API_KEY`, then run once in Pi:

```text
/fission-setup
```

The default mappings are:

| Profile | 9Router group |
|---|---|
| `fast` | `fission-explore` |
| `code` | `fission-sidekick` |
| `reason` | `fission-plan` |
| `review` | `fission-reviewer` |
| `research` | `fission-research` |
| `vision` | `fission-vision` |
| `design` | `fission-design` |

Setup discovers the groups, runs one real inference probe through each, and enables automatic routing only when all seven pass.

Override mappings during setup when your group names differ:

```text
/fission-setup fast=my-fast code=my-code reason=my-reason review=my-review research=my-research vision=my-vision design=my-design
```

## Use

Just use Pi normally:

```text
Inspect the inventory pages and improve their usability.
```

The footer shows the latest decision:

```text
fission: active · design → design · fission-design
```

Low-confidence, unavailable, manually overridden, setup-blocked, and restoration-failure states are shown explicitly. Fission never intercepts tools or creates an approval workflow.

## See what models are in use (main agent and subagents)

The Pi TUI shows a live **fission agents widget** above the editor:

```text
fission: 3 agents routing · main fission-sidekick · ctrl+e for details
```

Press **ctrl+e** to expand it into per-agent rows, updating live every 5 seconds:

```text
fission workers (3) · ctrl+e to collapse
  main · fission-sidekick · writing code
  reviewer · fission-reviewer · reviewing the work
  worker 3f1a9c2b · fission-explore · exploring the codebase
```

Each row shows the agent (main, a named subagent, its phase, or `worker <short id>` when the session has no stable name), the model it is currently using, and why it switched. The same view is available in any Pi mode as a command:

```text
/fission-agents
```

The raw log lives at `~/.pi/agent/extensions/pi-fission.routing.jsonl`; `/fission-routing` shows the grouped history for the ten most recently active sessions. Entries contain only session id/name, working directory, phase, profile, model transitions, and reason codes — never prompts, code, or tool output. The file is self-pruning: once it passes 1 MB it is rewritten with the most recent 1,000 entries.

## Diagnostics

```text
/fission
/fission-status
/fission-explain
/fission-config
/fission-setup-status
/fission-routing
/fission-agents
/fission-mode active|shadow|off
```

These commands are optional. Normal use requires no Fission command after setup.

- `active`: route every eligible request automatically.
- `shadow`: classify and display recommendations without switching models.
- `off`: disable routing.

Selecting a model manually pauses automatic routing so Fission cannot fight the user. Run `/fission-mode active` to resume automatic routing.

## Flicker

Flicker remains authoritative for planning, worktrees, implementation, testing, evidence, and release authority. Use the ordinary Flicker skills when relevant; Fission stays out of their way.

## Development

```bash
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```
