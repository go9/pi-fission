# pi-fusion

`pi-fusion` is a standalone Pi package implementing the **full-product control plane**: it classifies coding work, routes each request and workflow phase to a semantic 9Router profile, orchestrates the software-delivery lifecycle, delegates only when fresh context or independent/parallel work is valuable, and learns from outcomes through permission-gated tuning proposals.

**Status: in development.** This checkout implements the setup gate, persistent active routing, typed workflows with plan approval and session ownership, Flicker projection, pi-subagents delegation requests, dashboard surfaces, and permission-gated tuning proposals. All seven profiles currently pass real local 9Router probes. Live delegated-child execution and the complete Flicker/non-Flicker acceptance runs remain before Flicker ticket #1485 can be declared complete.

## Package layout

- `extensions/pi-fusion.ts` — the single Pi extension entry point.
- `src/classifier.ts` — pure deterministic task/phase/risk/capability/mutation-intent classification.
- `src/policy.ts` — pure stable routing policy and capability-floor enforcement.
- `src/router.ts` — OpenAI-compatible `/models` discovery with bounded failures.
- `src/setup.ts` — seven-profile mapping diagnostics, real minimal inference probes, active-readiness gating.
- `src/workflow.ts` — typed coding-workflow planner/runtime, approval envelope, session store, ownership warnings.
- `src/tuning.ts` — content-free outcome records, evidence-gated proposals, permissioned future-only application and rollback.
- `src/flicker-adapter.ts` — Flicker project resolution, ticket/document/status projection.
- `src/execution.ts` — deterministic direct/delegated policy and ownership-tagged pi-subagents V2 request producer.
- `src/extension.ts` — Pi lifecycle integration, provider registration, workflow commands, dashboard, and bounded model selection/restoration.
- `src/telemetry.ts` — bounded content-free JSONL records.
- `src/presentation.ts` — compact mode/status/explain/history/setup/workflow surfaces.

## Local setup

This repository does not modify Pi settings. After reviewing the package, reference the local package using Pi's normal package workflow, then create its configuration in the Pi **agent extension config area**:

```bash
mkdir -p ~/.pi/agent/extensions
cp examples/pi-fusion.config.example.json ~/.pi/agent/extensions/pi-fusion.json
```

The example targets the default keyless local 9Router endpoint at `http://127.0.0.1:20128/v1`. Omitting `provider.apiKey` is accepted only for loopback hosts (`127.0.0.1`, `localhost`, or `::1`); Pi receives a non-secret `local` sentinel because its provider registry requires a value, while catalogue discovery sends no Authorization header. For any non-loopback endpoint, set `provider.apiKey` to an environment-variable reference such as `$NINE_ROUTER_API_KEY` and export that variable before launching Pi. Literal credentials are always rejected, and a configured but missing environment variable is reported as an authentication error. `provider.id` must be `9router` or a `9router-*`/`9router_*`/`9router.*` namespace so the package cannot replace Pi's built-in providers.

The shipped mappings use the seven local combos `fusion-explore`, `fusion-sidekick`, `fusion-plan`, `fusion-reviewer`, `fusion-research`, `fusion-vision`, and `fusion-design`. 9Router owns each combo's provider/account fallback; Fusion only selects the semantic target.

## Configuration (v2)

The seven canonical profiles are `fast`, `code`, `reason`, `review`, `research`, `vision`, and `design`. Each maps to a logical Pi model ID (typically a 9Router combo) and explicitly declares tools, reasoning, image, structured-output, and context-window floors. Global mappings plus per-repository `projectOverrides` are supported; multiple profiles may share one model/combo.

`version: 1` configurations are migrated automatically to v2 with a `shadow` default and a conservative `design` entry; active mode is never inferred from a legacy config. `mode` is `off`, `shadow`, or `active`:

- `off` — Pi Fusion is inert.
- `shadow` — observe, classify, and recommend; never change models or workflow state.
- `active` — after setup readiness, route requests and drive managed workflows.

Active mode requires setup readiness: all seven profiles mapped, capability-compatible, authenticated (or valid keyless loopback), and successfully probed. Any probe failure blocks active with exact remediation; partial setup is never ready.

## Commands

- `/fusion-setup` — validate profile targets and run a real minimal inference probe through every profile; gates active readiness.
- `/fusion-setup-status` — setup state and per-profile probe results.
- `/fusion-mode [off|shadow|active]` — show or set the mode; active is blocked until setup passes.
- `/fusion-plan` — approve the current workflow plan (creates the versioned approval envelope and enables mutation execution).
- `/fusion-workflow` — show the active workflow graph, node statuses, envelope, and ownership.
- `/fusion-pause` / `/fusion-resume` / `/fusion-cancel` — workflow controls.
- `/fusion-route-once` — explicitly arm at most the next non-command task; repeated calls never stack.
- `/fusion-status` — mode, setup, workflow, and routing health.
- `/fusion-explain` — confidence, reason codes, capability requirements, eligible/rejected profiles, mutation intent.
- `/fusion-history` — bounded recent content-free records.
- `/fusion-config` — resolved path, mode, profile/alias counts, discovery, authentication type, override count; credential values are never shown.
- `/fusion-tune-propose` — build an evidence-gated tuning proposal (never applies anything).
- `/fusion-tune-approve` / `/fusion-tune-deny` / `/fusion-tune-rollback` — explicit human permission surface for future-only, atomic, reversible policy changes.
- `/fusion-proposals` — list proposals with status, scope, evidence sample.
- TUI footer — compact mode, workflow status, route, and ownership warning.

## Privacy and telemetry

Fusion telemetry and tuning datasets are content-free: timestamps, phase, recommended profile, allow-listed reason codes, confidence, an allow-listed active-model category, one-shot status, aggregate usage metadata, duration, and outcome. Prompts, code, credentials, account identifiers, arbitrary model or private deployment identifiers, raw tool input/output, and provider response bodies have no fields and are never serialized. Telemetry files are forced to mode `0600`; symbolic-link and non-regular targets are rejected. Flicker evidence documents, where produced, follow the authoritative Flicker evidence contract and may include changed files and commands.

## Rollback

Keep the last-good profile config, setup state, workflow store, and tuning proposals; every migration and tuning application is atomic and reversible. Normal Pi reload/shutdown awaits best-effort restoration. Remove the package with Pi's normal uninstall command; the extension has no project data to migrate. Delete telemetry/tuning files independently if local evidence should be removed.

## Development

Use Node 24.6.0 for the verified toolchain:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run typecheck
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm test
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run test:integration
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm pack --dry-run
```

The tests use only Node's built-in test runner and local mock HTTP servers; they consume no live subscription allowance except the explicitly authorized setup probe protocol.
