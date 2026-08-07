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
const allModels = Object.fromEntries(["fast", "code", "reason", "review", "research", "vision", "design"].map((id) => [id, id])) as Record<CanonicalProfile, string>;
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

function baseView(overrides: Partial<FusionView> = {}): FusionView {
  return {
    config: readyConfig(),
    discovery: readyDiscovery(),
    classification: null,
    recommendation: null,
    activeModel: "existing/actual-model",
    setup: null,
    workflow: null,
    foreignOwner: false,
    proposals: [],
    mode: "shadow",
    ...overrides,
  };
}

describe("config diagnostics", () => {
  it("malformed capability config is visible and never echoes a credential", () => {
    const raw = structuredClone(validConfig()) as unknown as Record<string, any>;
    raw.provider.apiKey = "super-secret-value";
    raw.profiles["vision"].capabilities.image = "yes";
    const result = parseConfig(raw);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("provider.apiKey")));
    assert.ok(result.diagnostics.some((item) => item.includes("vision.capabilities.image")));
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
    assert.ok(result.diagnostics.some((item) => item.includes("apiKey")));

    const localResult = parseConfig({
      ...validConfig(),
      provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:20128/v1", apiKey: undefined },
    });
    assert.ok(localResult.config);
    const localView = baseView({ config: { status: "ready", path: "/safe/pi-fusion.json", config: localResult.config, diagnostics: [] } });
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
    const invalid = baseView({ config: { status: "invalid-config", path: "/safe/config", config: null, diagnostics: ["bad field"] }, discovery: null });
    assert.match(formatStatus(invalid), /invalid-config/);
    assert.match(formatConfig(invalid), /invalid-config/);

    const unavailable = baseView({ discovery: { status: "timeout", models: [], resolvedProfiles: {}, effectiveCapabilities: {}, unresolvedProfiles: [...Object.keys(allModels)] as CanonicalProfile[], diagnostic: "model discovery timed out" } });
    assert.match(formatStatus(unavailable), /shadow · unavailable/);
    assert.match(formatExplain(unavailable), /unavailable/);
    assert.match(formatHistory([]), /shadow · empty/);

    const discovery = readyDiscovery();
    const ambiguous = classify({ text: "maybe" });
    const lowRoute = recommend({ classification: ambiguous, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    assert.match(formatStatus(baseView({ discovery, classification: ambiguous, recommendation: lowRoute })), /low-confidence/);

    const vision = classify({ text: "inspect this image", imageCount: 1 });
    const textOnlyCapabilities = Object.fromEntries(
      Object.entries(allCapabilities).map(([profile, capabilities]) => [profile, { ...capabilities, image: false }]),
    ) as Record<CanonicalProfile, Capabilities>;
    const noRoute = recommend({ classification: vision, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: textOnlyCapabilities, providerReady: true });
    assert.ok(noRoute.reasonCodes.includes("policy.no-eligible-profile"));
    const noEligibleView = baseView({ discovery: readyDiscovery({ effectiveCapabilities: textOnlyCapabilities }), classification: vision, recommendation: noRoute });
    assert.match(formatStatus(noEligibleView), /no-eligible-profile/);
    assert.doesNotMatch(formatStatus(noEligibleView), /low-confidence/);
    assert.match(formatExplain(noEligibleView), /no-eligible-profile/);

    const code = classify({ text: "implement a code fix" });
    const route = recommend({ classification: code, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    const ready = formatStatus(baseView({ discovery, classification: code, recommendation: route }));
    assert.match(ready, /shadow · ready/);
    assert.match(ready, /recommended code/);
    assert.match(ready, /active Pi model: existing\/actual-model/);
    assert.doesNotMatch(ready, /active Pi model: code/);

    const baseViewReady = baseView({ discovery, classification: code, recommendation: route });
    assert.match(formatConfig(baseViewReady), /shadow · ready/);
    assert.match(formatHistory([{
      schemaVersion: 1, timestamp: "2026-01-01T00:00:00.000Z", phase: "implement", recommendedProfile: "code",
      reasonCodes: ["phase.implement", "policy.preferred"], confidence: 0.9, activeModelCategory: "code",
      routeOnceStatus: "restored", usage: {}, durationMs: 1, outcome: "success",
    }]), /implement → code/);
  });

  it("setup and workflow states render without leaking content", () => {
    const setupView = baseView({ setup: { version: 1, complete: false, lastProbedAt: null, probes: {} } });
    assert.match(formatStatus(setupView), /no recommendation yet/);
    assert.match(formatConfig(baseView()), /profiles 7/);
  });
});
