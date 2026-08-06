# pi-fusion

`pi-fusion` is a standalone Pi package that observes a parent Pi session and recommends a semantic 9Router profile. Version 0.1 is **strictly shadow mode**: it never selects a model or thinking level, delegates work, changes prompts or tool results, edits project files, or changes workflow/release state.

Canonical profiles are `pi-fast`, `pi-code`, `pi-reason`, `pi-review`, `pi-research`, and `pi-vision`. Configurable aliases let a 9Router catalogue expose names such as `plan`, `sidekick`, `explore`, or `small-model` while policy remains canonical and capability checked.

## Package layout

- `extensions/pi-fusion.ts` — the single Pi extension entry point.
- `src/classifier.ts` — pure deterministic task/phase/risk/capability classification.
- `src/policy.ts` — pure stable routing policy and capability-floor enforcement.
- `src/router.ts` — OpenAI-compatible `/models` discovery with bounded failures.
- `src/extension.ts` — read-only Pi lifecycle observer, provider registration, and commands.
- `src/telemetry.ts` — bounded content-free JSONL records.
- `src/presentation.ts` — compact shadow-labelled status and explanations.

## Local setup

This repository does not modify Pi settings. After reviewing the package, reference the local package using Pi's normal package workflow, then create its configuration in the Pi **agent extension config area**:

```bash
mkdir -p ~/.pi/agent/extensions
cp examples/pi-fusion.config.example.json ~/.pi/agent/extensions/pi-fusion.json
export NINE_ROUTER_API_KEY='your-local-9router-key'
```

The example targets `http://127.0.0.1:20128/v1`; adjust `provider.baseUrl` for the local 9Router OpenAI-compatible base URL. `provider.id` must be `9router` or a `9router-*`/`9router_*`/`9router.*` namespace so the package cannot replace Pi's built-in providers. `provider.apiKey` must remain an environment-variable reference such as `$NINE_ROUTER_API_KEY`. Literal credentials are rejected. The extension passes that reference to Pi's provider registry and resolves it only in memory for catalogue discovery.

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

Every route surface distinguishes a recommendation from Pi's actual active model and includes the word `shadow`:

- `/fusion-status` — ready, low-confidence, unavailable, or invalid-config health.
- `/fusion-explain` — confidence, fixed reason codes, capability requirements, and eligible/rejected profiles.
- `/fusion-history` — bounded recent content-free records, including an explicit empty state.
- `/fusion-config` — resolved path and diagnostics; credential values are never shown.
- TUI footer — `fusion: shadow · <phase> → <profile>`.

The extension uses no dialogs. In print/JSON modes it does not prompt or install a footer; explicit `/fusion-*` commands write safe shadow status text to stderr so JSON stdout remains machine-readable. In RPC/TUI modes commands use Pi notifications.

## Privacy and telemetry

When enabled, telemetry is written with mode `0600` to `~/.pi/agent/extensions/pi-fusion.telemetry.jsonl` (or the configured filename) and bounded by `telemetry.maxEntries`. The schema is constructed from allow-listed fields only:

- timestamp;
- phase and recommended canonical profile;
- fixed reason codes and confidence;
- an allow-listed active-model category: canonical profile, `external`, or `unknown`;
- aggregate token/cost metadata when available;
- duration and success/error/unknown outcome.

Prompts, code, credentials, account identifiers, arbitrary model or private deployment identifiers, raw tool input/output, and provider response bodies have no telemetry fields and are never serialized. Existing telemetry files are forced to mode `0600`; symbolic-link and non-regular targets are rejected. The file can be deleted independently to roll back local evidence.

For isolated smoke tests without changing global Pi settings, set `PI_FUSION_CONFIG_PATH` to an absolute temporary config path before loading the package. This override changes only the config read location; it does not install or activate routing.

## Development

Use Node 24.6.0 for the verified toolchain:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run typecheck
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm test
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm run test:integration
PATH="$HOME/.local/share/mise/installs/node/24.6.0/bin:$PATH" npm pack --dry-run
```

The tests use only Node's built-in test runner and local mock HTTP servers; they consume no live subscription allowance.
