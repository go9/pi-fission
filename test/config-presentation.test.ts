import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig, type ConfigResult } from "../src/config.ts";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { footerText, formatConfig, formatExplain, formatHistory, formatStatus, type FusionView } from "../src/presentation.ts";
import type { CanonicalProfile, Capabilities } from "../src/types.ts";
import type { DiscoveryResult } from "../src/router.ts";
import { validConfig } from "../test-support/helpers.ts";

const readyConfig = (): ConfigResult => ({ status: "ready", path: "/safe/pi-fusion.json", config: validConfig(), diagnostics: [] });
const allModels = Object.fromEntries(["pi-fast", "pi-code", "pi-reason", "pi-review", "pi-research", "pi-vision"].map((id) => [id, id])) as Record<CanonicalProfile, string>;
const allCapabilities = Object.fromEntries(
  Object.entries(validConfig().profiles).map(([profile, config]) => [profile, config.capabilities]),
) as Record<CanonicalProfile, Capabilities>;

function readyDiscovery(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    status: "ready",
    models: [],
    resolvedProfiles: allModels,
    effectiveCapabilities: allCapabilities,
    unresolvedProfiles: [],
    diagnostic: "ready",
    ...overrides,
  };
}

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

  it("allows keyless loopback endpoints and requires an environment key for remote endpoints", () => {
    for (const baseUrl of ["http://127.0.0.1:20128/v1", "https://localhost:20128/v1", "http://[::1]:20128/v1"]) {
      const local = structuredClone(validConfig()) as unknown as Record<string, any>;
      local.provider.baseUrl = baseUrl;
      delete local.provider.apiKey;
      const result = parseConfig(local);
      assert.equal(result.diagnostics.length, 0);
      assert.equal(result.config?.provider.apiKey, undefined);
    }

    const remote = structuredClone(validConfig()) as unknown as Record<string, any>;
    remote.provider.baseUrl = "https://router.example.com/v1";
    delete remote.provider.apiKey;
    const result = parseConfig(remote);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("required for non-loopback")));

    const localResult = parseConfig({
      ...validConfig(),
      provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:20128/v1", apiKey: undefined },
    });
    assert.ok(localResult.config);
    const localView: FusionView = {
      config: { status: "ready", path: "/safe/pi-fusion.json", config: localResult.config, diagnostics: [] },
      discovery: readyDiscovery(), classification: null, recommendation: null, activeModel: null,
    };
    assert.match(formatConfig(localView), /keyless loopback authentication/);
    assert.doesNotMatch(formatConfig(localView), /env reference configured/);
  });

  it("rejects built-in and non-9Router provider namespaces", () => {
    for (const providerId of ["openai", "anthropic", "my-gateway"]) {
      const raw = structuredClone(validConfig()) as unknown as Record<string, any>;
      raw.provider.id = providerId;
      const result = parseConfig(raw);
      assert.equal(result.config, null);
      assert.ok(result.diagnostics.some((item) => item.includes("provider.id")));
    }
    assert.equal(parseConfig(validConfig({ provider: { ...validConfig().provider, id: "9router-local" } })).diagnostics.length, 0);
  });
});

describe("explain and command state formatting", () => {
  it("commands expose explicit invalid-config, unavailable, empty, low-confidence, no-eligible, and ready states", () => {
    const invalid: FusionView = {
      config: { status: "invalid-config", path: "/safe/config", config: null, diagnostics: ["bad field"] },
      discovery: null, classification: null, recommendation: null, activeModel: "existing/actual-model",
    };
    assert.match(formatStatus(invalid), /shadow · invalid-config/);
    assert.match(formatConfig(invalid), /invalid-config/);

    const unavailable: FusionView = {
      config: readyConfig(),
      discovery: { status: "timeout", models: [], resolvedProfiles: {}, effectiveCapabilities: {}, unresolvedProfiles: [...Object.keys(allModels)] as CanonicalProfile[], diagnostic: "model discovery timed out" },
      classification: null, recommendation: null, activeModel: "existing/actual-model",
    };
    assert.match(formatStatus(unavailable), /shadow · unavailable/);
    assert.match(formatExplain(unavailable), /unavailable/);
    assert.match(formatHistory([]), /shadow · empty/);

    const discovery = readyDiscovery();
    const ambiguous = classify({ text: "maybe" });
    const lowRoute = recommend({ classification: ambiguous, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    assert.match(formatStatus({ config: readyConfig(), discovery, classification: ambiguous, recommendation: lowRoute, activeModel: "existing/actual-model" }), /low-confidence/);

    const vision = classify({ text: "inspect this image", imageCount: 1 });
    const textOnlyCapabilities = Object.fromEntries(
      Object.entries(allCapabilities).map(([profile, capabilities]) => [profile, { ...capabilities, image: false }]),
    ) as Record<CanonicalProfile, Capabilities>;
    const noRoute = recommend({ classification: vision, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: textOnlyCapabilities, providerReady: true });
    assert.ok(noRoute.reasonCodes.includes("policy.no-eligible-profile"));
    const noEligibleView = { config: readyConfig(), discovery: readyDiscovery({ effectiveCapabilities: textOnlyCapabilities }), classification: vision, recommendation: noRoute, activeModel: "existing/actual-model" };
    assert.match(formatStatus(noEligibleView), /no-eligible-profile/);
    assert.doesNotMatch(formatStatus(noEligibleView), /low-confidence/);
    assert.match(formatExplain(noEligibleView), /no-eligible-profile/);

    const code = classify({ text: "implement a code fix" });
    const route = recommend({ classification: code, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    const ready = formatStatus({ config: readyConfig(), discovery, classification: code, recommendation: route, activeModel: "existing/actual-model" });
    assert.match(ready, /shadow · ready/);
    assert.match(ready, /recommended pi-code/);
    assert.match(ready, /active Pi model: existing\/actual-model/);
    assert.doesNotMatch(ready, /active Pi model: pi-code/);

    const baseView: FusionView = { config: readyConfig(), discovery, classification: code, recommendation: route, activeModel: "existing/actual-model" };
    assert.match(formatStatus({ ...baseView, routeOnce: { status: "armed", reason: null } }), /one-shot armed/);
    assert.match(formatExplain({ ...baseView, routeOnce: { status: "applied", reason: null } }), /one-shot applied/);
    assert.match(formatStatus({ ...baseView, routeOnce: { status: "skipped", reason: "model-not-found" } }), /one-shot skipped \(model-not-found\)/);
    assert.match(footerText({ ...baseView, routeOnce: { status: "restored", reason: null } }), /one-shot restored/);
    assert.match(footerText({ ...baseView, routeOnce: { status: "restore-failed", reason: "restore-failed" } }), /restore-failed/);
    assert.match(formatConfig(baseView), /shadow-default · one-shot available/);
    assert.match(formatHistory([{
      schemaVersion: 1, timestamp: "2026-01-01T00:00:00.000Z", phase: "implement", recommendedProfile: "pi-code",
      reasonCodes: ["phase.implement", "policy.preferred"], confidence: 0.9, activeModelCategory: "pi-code",
      routeOnceStatus: "restored", usage: {}, durationMs: 1, outcome: "success",
    }]), /route restored/);
  });
});
