# Pi Fusion — Setup & Usage Guide

Pi Fusion is a **Pi extension** that routes coding work to semantic 9Router profiles and drives a managed workflow (plan → approve → implement → review → test) from inside Pi.

---

## 1. Prerequisites

| Thing | Where | Status |
|---|---|---|
| 9Router running | `http://127.0.0.1:20128` (`~/.local/bin/9router`) | ✅ running |
| Pi 0.83 | `pi --version` | ✅ |
| 9Router API key in Keychain | service `pi-fusion-9router`, account `$USER` | ✅ present |
| `NINE_ROUTER_API_KEY` env | sourced from `~/.config/pi-fusion/env.zsh` via `~/.zshenv` | ✅ |
| Pi Fusion package | `~/.pi/agent/settings.json` → `../../Sites/pi-fusion-active-once` | ✅ installed |
| Config | `~/.pi/agent/extensions/pi-fusion.json` (v2) | ✅ |

If any are missing:

```bash
# Start 9Router
~/.local/bin/9router --host 127.0.0.1 --port 20128 --no-browser --skip-update &

# Store the 9Router API key (copy from the 9Router dashboard → API Keys)
/usr/bin/security add-generic-password -a "$USER" -s pi-fusion-9router -w '<KEY>'

# Env hook
mkdir -p ~/.config/pi-fusion
cat > ~/.config/pi-fusion/env.zsh <<'EOF'
_pi_fusion_9router_key="$(/usr/bin/security find-generic-password -w -a "$USER" -s pi-fusion-9router 2>/dev/null)"
[[ -n "$_pi_fusion_9router_key" ]] && export NINE_ROUTER_API_KEY="$_pi_fusion_9router_key"
unset _pi_fusion_9router_key
EOF
chmod 600 ~/.config/pi-fusion/env.zsh
grep -q 'pi-fusion/env.zsh' ~/.zshenv || printf '\n[[ -r "$HOME/.config/pi-fusion/env.zsh" ]] && source "$HOME/.config/pi-fusion/env.zsh"\n' >> ~/.zshenv

# Install the package (if not already)
pi install /Users/giovanniorlando/Sites/pi-fusion-active-once
```

**Restart Pi from a fresh terminal** after changing anything above — the env var and extension load at startup, not mid-session.

---

## 2. First-run setup (the gate)

Every command below works from the Pi prompt (TUI) or print mode:

```text
/fusion-config          → shows resolved config, profiles, discovery, auth mode
/fusion-setup-status    → per-profile probe state
/fusion-setup           → validates targets and runs a REAL minimal probe through every profile
/fusion-status          → overall health
```

`/fusion-setup` probes each of the seven profiles (`fast`, `code`, `reason`, `review`, `research`, `vision`, `design`) with a real `chat/completions` call that must return exactly `OK`.

**Current local state:** all seven semantic combos exist and pass real probes. `/fusion-setup-status` reports `complete · active ready`, and the persisted mode is `active`. Re-run `/fusion-setup` after changing a combo, profile mapping, credential, or project override; stale probe targets do not count as ready.

---

## 3. Modes

```text
/fusion-mode            → show current mode
/fusion-mode shadow     → observe + recommend only (never changes models)
/fusion-mode active     → full routing + workflows (blocked until setup passes)
/fusion-mode off        → inert
```

- **shadow** (default after migration): classifies every request, shows a recommendation in `/fusion-explain`, never touches your model.
- **active**: routes requests, and mutation requests become managed workflows.

---

## 4. Shadow mode

```text
/fusion-status          → mode, setup, workflow, recommendation
/fusion-explain         → why a profile was/wasn't recommended (capability floors, mutation intent)
/fusion-history         → recent content-free routing decisions
```

Also the footer in the TUI shows `fusion: <mode> · <phase> → <profile>`.

One-off real routing without active mode:

```text
/fusion-route-once      → arm the NEXT request to route through the recommendation
Submit a task…          → runs on the routed model
/fusion-status          → shows one-shot applied → restored after the run settles
```

The arm is consumed before selection, never stacks, and restores your exact prior model + thinking level when the run settles. Your own model/thinking choices always win.

---

## 5. Active mode (the managed workflow)

After `/fusion-setup` reports **complete**, enable active mode and drive a workflow:

```text
/fusion-mode active

Implement a small TypeScript helper          ← mutation request
/fusion-workflow        → shows: 5 nodes, awaiting-approval
                           plan → reason
                           plan-review → review
                           implement → code
                           review → review
                           regression → review
/fusion-plan            → approve: creates approval envelope v1, workflow → running
/fusion-status          → routing now follows the running node's profile
/fusion-workflow        → watch nodes advance (passed/failed → blocked on error)
/fusion-pause           → pause
/fusion-resume          → resume
/fusion-cancel          → cancel (syncs Flicker defer when adapter active)
```

Rules that hold:

- **No model routing happens before plan approval.** The first mutation prompt only creates the workflow; `/fusion-plan` unlocks routing.
- **Read-only questions** ("explain this", "what does X do") answer directly without a workflow.
- **One writer, bounded fanout, safe boundaries:** model switches happen only at request/node boundaries, never mid-stream.
- If a node fails (provider/tool error), the workflow goes **blocked** with the failing node marked `failed`.

---

## 6. Delegation (pi-subagents adapter)

```text
/fusion-delegate
```

Shows the backend decision for the current workflow node:

- **read-only specialists** (explore/research/review/plan-review) → `delegated` (fresh context, under the fanout cap)
- **writer work** (implement/regression) → `direct` (one writer)

In active mode with a running node it emits a V2 delegation request over Pi's event bus with ownership ids, explicit model, budgets, cancellation, timeout, and duplicate detection. Live delegated-child acceptance remains a release-evidence item.

---

## 7. Learning / tuning (permission-gated)

Fusion records content-free outcomes and can propose policy changes — **it never changes policy itself**:

```text
/fusion-tune-propose            → creates a proposal once enough evidence exists
/fusion-proposals               → list proposals (status, scope, evidence sample)
/fusion-tune-approve <id>       → approve (records rollback snapshot; policy wiring is a later slice)
/fusion-tune-deny <id>          → deny
/fusion-tune-rollback <id>      → roll back an applied proposal
```

---

## 8. Dashboard

```text
/fusion         → TUI widget (mode, setup, workflow, proposals) or text fallback
/fusion-dashboard-close
```

---

## 9. Privacy

- Telemetry/tuning files: `~/.pi/agent/extensions/pi-fusion.telemetry.jsonl`, `.tuning.jsonl` — mode `0600`, **no prompts, code, credentials, account ids, or raw tool output**.
- Workflow store: `~/.pi/agent/extensions/pi-fusion.workflows.json`.
- Config references `$NINE_ROUTER_API_KEY`; the value lives only in macOS Keychain.

---

## 10. Rollback / uninstall

```text
pi remove /Users/giovanniorlando/Sites/pi-fusion-active-once   # restore prior Pi behavior
rm ~/.pi/agent/extensions/pi-fusion.json                       # drop config (optional)
rm ~/.pi/agent/extensions/pi-fusion.{telemetry,tuning,workflows}.*  # drop local evidence (optional)
```

The extension never edits your repos or Flicker state without the workflow/plan gates.

---

## 11. Development (verified toolchain)

```bash
cd ~/Sites/pi-fusion-active-once
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run typecheck
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm test            # 89 tests
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run test:integration  # 29 tests
```

## Current limitations (honest)

1. Current-head non-Flicker and Flicker workflows pass plan approval, sandboxed changed-files commit, review, regression, marked Flicker projection, and no-remote behavior. Real pi-subagents execution reached `completed`; its negative structured acceptance correctly blocked advancement, while positive acceptance is protocol-tested.
2. Isolated install → legacy migration → reinstall/upgrade → broken-config fail-safe → rollback → uninstall passes.
3. The original full-product contract still has deferred surfaces: persistent pins, a separate fixed writer backend, enforced depth/tool/turn/token budgets, full authority provenance/dashboard states, operational tuning application, and complete Flicker review/regression/verdict/release projection. Parent #1485 remains open until those are implemented and independently passed.
