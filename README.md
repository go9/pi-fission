# pi-fusion

`pi-fusion` is a standalone Pi package that observes a parent Pi session and recommends a semantic 9Router profile. It remains **shadow mode by default**. The only active path is an explicit, in-memory `/fusion-route-once` arm for exactly the next eligible task; after that full agent run settles, Pi Fusion restores the exact model that was active before the test. It never changes thinking level, delegates work, changes prompts or tool results, edits project files, or changes workflow/release state.

Canonical profiles are `pi-fast`, `pi-code`, `pi-reason`, `pi-review`, `pi-research`, and `pi-vision`. Configurable aliases let a 9Router catalogue expose names such as `plan`, `sidekick`, `explore`, or `small-model` while policy remains canonical and capability checked.

## Package layout

- `extensions/pi-fusion.ts` — the single Pi extension entry point.
- `src/classifier.ts` — pure deterministic task/phase/risk/capability classification.
- `src/policy.ts` — pure stable routing policy and capability-floor enforcement.
- `src/router.ts` — OpenAI-compatible `/models` discovery with bounded failures.
- `src/extension.ts` — Pi lifecycle observer, provider registration, commands, and bounded one-shot model selection/restoration.
- `src/telemetry.ts` — bounded content-free JSONL records.
- `src/presentation.ts` — compact shadow-labelled status and explanations.

## Local setup

This repository does not modify Pi settings. After reviewing the package, reference the local package using Pi's normal package workflow, then create its configuration in the Pi **agent extension config area**:

```bash
mkdir -p ~/.pi/agent/extensions
cp examples/pi-fusion.config.example.json ~/.pi/agent/extensions/pi-fusion.json
```

The example targets the default keyless local 9Router endpoint at `http://127.0.0.1:20128/v1`. Omitting `provider.apiKey` is accepted only for loopback hosts (`127.0.0.1`, `localhost`, or `::1`); Pi receives a non-secret `local` sentinel because its provider registry requires a value, while catalogue discovery sends no Authorization header. For any non-loopback endpoint, set `provider.apiKey` to an environment-variable reference such as `$NINE_ROUTER_API_KEY` and export that variable before launching Pi. Literal credentials are always rejected, and a configured but missing environment variable is reported as an authentication error. `provider.id` must be `9router` or a `9router-*`/`9router_*`/`9router.*` namespace so the package cannot replace Pi's built-in providers.

The shipped mappings match the observed local combos `fusion-explore`, `fusion-plan`, `fusion-research`, `fusion-reviewer`, `fusion-sidekick`, and `fusion-small`. 9Router does not currently expose an observed vision combo, so `fusion-vision` is an explicit user-created placeholder. Until that combo is created and discovered, `/fusion-config` reports `pi-vision` unresolved and vision tasks produce `no-eligible-profile`; the extension does not pretend a text-only combo supports images.

To try a reviewed local checkout without installing globally:

```bash
pi -e /absolute/path/to/pi-fusion
```

No global install, package publication, or global Pi settings change is performed by this repository.

## Configuration

All six canonical profiles are required. Each maps to a logical 9Router model ID and explicitly declares:

- tool support;
- reasoning support;
- image support;
- structured-output support;
- context window.

A recommendation is eligible only when every required floor is met and the logical model was discovered. Explicit capability fields returned by 9Router constrain configured claims: known false modalities/features and known lower context limits win conservatively, while fields omitted by discovery retain the explicit configured floor. Unknown prompts retain the active Pi model at low confidence. A high-confidence request with no eligible profile is reported separately as `no-eligible-profile`. An unavailable or invalid catalogue is visible and non-fatal; structurally valid explicit model IDs are still registered as a provider catalogue fallback, but shadow recommendations remain unavailable until discovery succeeds.

Aliases are merged over the built-in examples and may point only to canonical profiles. Telemetry filenames are restricted to the same extension config directory.

## Pi UX

Every route surface distinguishes a recommendation from Pi's actual active model and labels the runtime as shadow, one-shot armed, applied, skipped, restored, restore-failed, or user-overrode:

- `/fusion-route-once` — explicitly arm at most the next non-command task; repeated calls never stack.
- `/fusion-status` — ready, low-confidence, unavailable, invalid-config, and current one-shot state.
- `/fusion-explain` — confidence, fixed reason codes, capability requirements, eligible/rejected profiles, and one-shot state.
- `/fusion-history` — bounded recent content-free records with allow-listed one-shot status, including an explicit empty state.
- `/fusion-config` — resolved path, shadow-default/one-shot availability, and diagnostics; credential values are never shown.
- TUI footer — compact shadow or one-shot state.

To perform one reversible active test in an interactive Pi session:

```text
/fusion-route-once
Plan a small, clearly scoped implementation.
/fusion-status
```

The arm is consumed before model lookup or selection, so an unavailable provider, low-confidence/no-eligible recommendation, registry miss, or selection failure cannot unexpectedly route a later prompt. A successful differing selection is held across all tool turns, retries, and queued continuations, then restored only at `agent_settled`. Selecting a model yourself during the active run cancels stale restoration so your choice wins. No configuration migration or persistent active toggle exists.

The extension uses no dialogs. In print/JSON modes it does not prompt or install a footer; explicit `/fusion-*` commands write safe status text to stderr so JSON stdout remains machine-readable. In RPC/TUI modes commands use Pi notifications.

## Privacy and telemetry

When enabled, telemetry is written with mode `0600` to `~/.pi/agent/extensions/pi-fusion.telemetry.jsonl` (or the configured filename) and bounded by `telemetry.maxEntries`. The schema is constructed from allow-listed fields only:

- timestamp;
- phase and recommended canonical profile;
- fixed reason codes and confidence;
- an allow-listed active-model category: canonical profile, `external`, or `unknown`;
- an allow-listed one-shot route status (never a raw model id or prompt-derived value);
- aggregate token/cost metadata when available;
- duration and success/error/unknown outcome.

Prompts, code, credentials, account identifiers, arbitrary model or private deployment identifiers, raw tool input/output, and provider response bodies have no telemetry fields and are never serialized. Existing telemetry files are forced to mode `0600`; symbolic-link and non-regular targets are rejected. The file can be deleted independently to roll back local evidence.

For isolated smoke tests without changing global Pi settings, set `PI_FUSION_CONFIG_PATH` to an absolute temporary config path before loading the package. This override changes only the config read location; it does not install or activate routing.

## Rollback

One-shot state is memory-only and disappears on Pi reload/restart. To stop a pending test, reload Pi before submitting the next task. To roll back the package, remove its local package entry with Pi's normal uninstall command or point that entry back to a reviewed shadow-only checkout; the extension has no project data or workflow state to migrate. Delete the telemetry JSONL independently if local routing evidence should be removed.

## Development

Use Node 24.6.0 for the verified toolchain:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run typecheck
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm test
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run test:integration
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm pack --dry-run
```

The tests use only Node's built-in test runner and local mock HTTP servers; they consume no live subscription allowance.
