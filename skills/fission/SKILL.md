---
name: fission
description: Pi Fission — automatic semantic routing from Pi to 9Router model groups. Use when routing, model selection, or the /fission* commands are involved; setup, modes, the live agents widget, the routing log, and model group configuration.
---

# Pi Fission

Pi Fission routes each prompt to a semantic 9Router group (fission splits one flame into many — the main session is the source, subagents are the split flames). It does NOT manage workflow: Flicker skills own planning, implementation, testing, and release.

## Setup (once)

```text
/fission-setup
```

- Discovers the 9Router groups, runs one real inference probe per profile
- Activates automatic routing only when all 7 profiles pass
- Override group mappings: `/fission-setup code=my-group review=my-group`
- The key comes from `$NINE_ROUTER_API_KEY` (keychain: `pi-fission-9router`)

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

## 9Router groups

Task groups map 1:1 to profiles; combos are ordered fallback chains. Current ordering: **sol > grok > deepseek > luna**, with `pool-deepseek` (round-robin: oc/deepseek-v4-flash-free, ocg/deepseek-v4-flash, kr/deepseek-3.2) as the free fallback tail. Gemini appears only in `fission-vision`.

## Privacy

The routing log (`~/.pi/agent/extensions/pi-fission.routing.jsonl`) is content-free: session id/name, phase, profile, model transitions, reasons. No prompts, code, credentials, or tool output.

## Troubleshooting

- **After install/rename/upgrade, commands are missing** → restart Pi (extensions load at session start)
- **`fission setup blocked`** → run `/fission-setup`, fix the mapping whose row reads `FAILED`
- **`manual model` in footer** → you selected a model; `/fission-mode active` resumes routing
- **Routing log frozen** → the session is running stale code; restart
- **Provider errors (429/402/403)** → group fallbacks handle them; check the 9Router provider's auth/balance
