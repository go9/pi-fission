import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig, type ConfigResult } from "../src/config.ts";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { formatConfig, formatExplain, formatHistory, formatStatus, type FusionView } from "../src/presentation.ts";
import type { CanonicalProfile } from "../src/types.ts";
import { validConfig } from "../test-support/helpers.ts";

const readyConfig = (): ConfigResult => ({ status: "ready", path: "/safe/pi-fusion.json", config: validConfig(), diagnostics: [] });
const allModels = Object.fromEntries(["pi-fast", "pi-code", "pi-reason", "pi-review", "pi-research", "pi-vision"].map((id) => [id, id])) as Record<CanonicalProfile, string>;

describe("config diagnostics", () => {
  it("malformed capability config is visible and never echoes a credential", () => {
    const raw = structuredClone(validConfig()) as unknown as Record<string, any>;
    raw.provider.apiKey = "super-secret-value";
    raw.profiles["pi-vision"].capabilities.image = "yes";
    const result = parseConfig(raw);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("provider.apiKey")));
    assert.ok(result.diagnostics.some((item) => item.includes("pi-vision.capabilities.image")));
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /super-secret-value/);
  });
});

describe("explain and command state formatting", () => {
  it("commands expose explicit invalid-config, unavailable, empty, low-confidence, and ready states", () => {
    const invalid: FusionView = {
      config: { status: "invalid-config", path: "/safe/config", config: null, diagnostics: ["bad field"] },
      discovery: null, classification: null, recommendation: null, activeModel: "actual-model",
    };
    assert.match(formatStatus(invalid), /shadow · invalid-config/);
    assert.match(formatConfig(invalid), /invalid-config/);

    const unavailable: FusionView = {
      config: readyConfig(),
      discovery: { status: "timeout", models: [], resolvedProfiles: {}, diagnostic: "model discovery timed out" },
      classification: null, recommendation: null, activeModel: "actual-model",
    };
    assert.match(formatStatus(unavailable), /shadow · unavailable/);
    assert.match(formatExplain(unavailable), /unavailable/);
    assert.match(formatHistory([]), /shadow · empty/);

    const discovery = { status: "ready", models: [], resolvedProfiles: allModels, diagnostic: "ready" } satisfies import("../src/router.ts").DiscoveryResult;
    const ambiguous = classify({ text: "maybe" });
    const lowRoute = recommend({ classification: ambiguous, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.match(formatStatus({ config: readyConfig(), discovery, classification: ambiguous, recommendation: lowRoute, activeModel: "actual-model" }), /low-confidence/);

    const code = classify({ text: "implement a code fix" });
    const route = recommend({ classification: code, config: validConfig(), resolvedModels: allModels, providerReady: true });
    const ready = formatStatus({ config: readyConfig(), discovery, classification: code, recommendation: route, activeModel: "actual-model" });
    assert.match(ready, /shadow · ready/);
    assert.match(ready, /recommended pi-code/);
    assert.match(ready, /active Pi model: actual-model/);
    assert.doesNotMatch(ready, /active Pi model: pi-code/);
  });
});
