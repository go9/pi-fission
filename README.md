# Pi Fission

Automatic semantic routing from Pi to seven models you choose, on any OpenAI-compatible endpoint.

Set it up once, then prompt normally. Fission classifies each request, selects the model you mapped to that kind of work, and shows the decision in Pi's footer. It does not manage tickets, plans, tools, worktrees, subagents, tests, or releases.

## Requirements

Any endpoint that speaks the OpenAI API. Fission makes exactly two kinds of call — `GET {baseUrl}/models` to discover what is available and `POST {baseUrl}/chat/completions` to route — so a proxy, a router, a local server, or a vendor all work the same way:

| Endpoint | Typical `baseUrl` |
|---|---|
| LiteLLM proxy | `http://127.0.0.1:4000/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM | `http://127.0.0.1:8000/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

## Install and set up

```bash
pi install /path/to/pi-fission
```

Edit `provider` in the config (`examples/pi-fission.config.example.json` is a complete one) to point at your endpoint. The default is loopback and keyless; a hosted endpoint needs a key, given as an environment-variable *reference* so no credential is ever written to the config file:

```json
"provider": {
  "id": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "$OPENROUTER_API_KEY",
  "timeoutMs": 15000
}
```

Then run once in Pi:

```text
/fission-setup
```

Seven profiles cover the kinds of work Fission distinguishes. The default names are placeholders — either create models or groups with these names on your endpoint, or map the profiles to names you already have:

| Profile | Used for | Default name |
|---|---|---|
| `fast` | exploring, listing, quick questions | `fission-explore` |
| `code` | implementation | `fission-sidekick` |
| `reason` | planning, architecture, anything risky | `fission-plan` |
| `review` | review, audit, regression | `fission-reviewer` |
| `research` | investigation, comparison, docs | `fission-research` |
| `vision` | images and screenshots | `fission-vision` |
| `design` | UI and product surface work | `fission-design` |

Setup discovers what your endpoint offers, runs one real inference probe through each profile, and enables automatic routing only when all seven pass.

Remap any of them at setup time:

```text
/fission-setup fast=gpt-4o-mini code=claude-sonnet-4 reason=o3 review=o3
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

## How it decides, and why it is not a model

The classifier is a set of ordered regular expressions over the prompt text ([`src/classifier.ts`](src/classifier.ts)), not an LLM call. That is a deliberate trade, and the reasons are specific:

- **A model router cannot afford a model call.** Classifying with an LLM adds a network round trip and a token cost to *every* prompt, in front of the request the user actually wants. The saving this tool exists to produce would be spent on deciding to produce it.
- **It would need a model to pick a model.** Whatever classifies is itself a routing decision, and there is no non-arbitrary place to stop.
- **Routing must be inspectable.** Every decision carries reason codes (`phase.implement`, `risk.protected`, `policy.capability-fallback`), so `/fission-routing` can say *why* in terms you can check against the rules. A model's answer would have to be taken on faith, per prompt.
- **Same prompt, same route.** Determinism is what makes the routing log a debuggable artifact instead of an anecdote.

What that buys is bounded, and the limits are real: it keys on English, and it reads vocabulary rather than meaning, so a prompt that describes risky work without using risky words is classified on what it says. Two things keep that honest rather than silently wrong:

- **Confidence is a first-class output, and the policy has a floor.** Below `0.5`, or on `unknown`, Fission routes nothing and leaves the current model alone ([`src/policy.ts`](src/policy.ts)). Not knowing is a supported answer.
- **Ambiguous follow-ups inherit, but not forever.** "ok do that" carries no phase vocabulary, so it continues the phase already established — at reduced confidence that decays each turn, until it crosses the floor and routing stops assuming. A phase is never pinned past its evidence.

If you would rather it were a model, the seam is small: `classify()` takes text and returns a `Classification`. Nothing above it knows how that was produced.

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

Each row shows the agent (main, a named subagent, its phase, or `worker <short id>` when the session has no stable name), the model it is currently using, and why it switched. Outside the TUI, `/fission-routing` leads each session block with the same `now:` line.

The raw log lives at `~/.pi/agent/extensions/pi-fission.routing.jsonl`; `/fission-routing` shows the grouped history for the ten most recently active sessions. Entries contain only session id/name, working directory, phase, profile, model transitions, and reason codes — never prompts, code, or tool output. The file is self-pruning: once it passes 1 MB it is rewritten with the most recent 1,000 entries.

## Diagnostics

```text
/fission-setup                 show the seven mappings and each one's probe result
/fission-setup probe           re-probe all seven and re-activate
/fission-routing               lifetime totals, then recent sessions and why each switched
/fission-mode active|shadow|off
```

These commands are optional. Normal use requires no Fission command after setup — the
footer and the ctrl+e widget carry the live picture.

- `active`: route every eligible request automatically.
- `shadow`: classify and display recommendations without switching models.
- `off`: disable routing.

Selecting a model manually pauses automatic routing so Fission cannot fight the user. Run `/fission-mode active` to resume automatic routing.

## Scope

Fission routes, and stops there. It does not intercept tool calls, gate approvals, manage worktrees or branches, orchestrate subagents, or run tests — Pi and whatever workflow tooling you already use own those, and a router that quietly took them over would be much harder to trust with the one job it does have.

The one place it deliberately yields is manual control: selecting a model yourself pauses automatic routing, and it stays paused until you run `/fission-mode active`. Fission never fights the user for the model.

## Development

```bash
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```
