---
name: fission
description: Pi Fission — automatic semantic routing from Pi to seven models on any OpenAI-compatible endpoint. Use when routing, model selection, or the /fission* commands are involved; setup, modes, the live agents widget, the routing log, and provider configuration.
---

# Pi Fission

Pi Fission routes each prompt to one of seven semantic profiles (fission splits one flame into many — the main session is the source, subagents are the split flames). It does NOT manage workflow: planning, implementation, testing, and release belong to whatever tooling you already use.

## Setup (once)

```text
/fission-setup
```

- Discovers what the configured endpoint offers, runs one real inference probe per profile
- Activates automatic routing only when all 7 profiles pass
- Override group mappings: `/fission-setup code=my-group review=my-group`
- The key is an env-var reference in the config (`"apiKey": "$YOUR_ENV_VAR"`); loopback endpoints may omit it

## Normal use

Nothing to do — prompt normally. The footer shows the current decision:

```text
fission: active · implement → code · fission-sidekick
```

## Commands

There are three. The footer and the ctrl+e widget already answer "what is happening
now" continuously, so no command restates them.

| Command | What it does |
|---|---|
| `/fission-setup` | show the seven profile → group mappings **with** each one's probe result |
| `/fission-setup probe` | re-probe all seven and re-activate (seven real inference calls) |
| `/fission-setup code=my-group` | change a mapping, then probe |
| `/fission-routing` | lifetime totals, then recent sessions and why each switched |
| `/fission-mode off\|shadow\|active` | disable / observe-only / auto-route |

`/fission-setup` with no arguments only *shows* — it never probes, because probing costs
seven inference calls. A mapping that has not been probed reads `not probed`, never
`FAILED`.

## Live widget

In the TUI, a widget above the editor shows the agent count. Press **ctrl+e** to expand per-agent rows (main + subagents): current model and why it switched, updating every few seconds.

## Modes

- `active` — route every eligible prompt automatically (default after setup)
- `shadow` — classify and show what it *would* pick, never switch models
- `off` — fully disabled

A manual model selection pauses auto-routing; `/fission-mode active` resumes it. Session-start defaults and restore events are not treated as overrides.

## Provider

Any OpenAI-compatible endpoint: LiteLLM, Ollama, LM Studio, vLLM, OpenRouter, a vendor
directly. Only `GET {baseUrl}/models` and `POST {baseUrl}/chat/completions` are used.

Each profile maps to one name on that endpoint. If your endpoint supports groups or
fallback chains behind a single name (LiteLLM and OpenRouter both do), Fission sees only
the name — retries and failover stay the endpoint's job, not Fission's.

## Privacy

The routing log (`~/.pi/agent/extensions/pi-fission.routing.jsonl`) is content-free: session id/name, phase, profile, model transitions, reasons. No prompts, code, credentials, or tool output.

## Troubleshooting

- **After install/rename/upgrade, commands are missing** → restart Pi (extensions load at session start)
- **`fission setup blocked`** → run `/fission-setup`, fix the mapping whose row reads `FAILED`
- **`manual model` in footer** → you selected a model; `/fission-mode active` resumes routing
- **Routing log frozen** → the session is running stale code; restart
- **Provider errors (429/402/403)** → these come from your endpoint; check its auth, balance, and any fallback chain behind the mapped name
