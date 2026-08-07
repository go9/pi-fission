import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig, parseConfig, type ConfigResult } from "../src/config.ts";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { footerText, formatConfig, formatExplain, formatSetup, formatStatus, type FissionView } from "../src/presentation.ts";
import type { CanonicalProfile, Capabilities } from "../src/types.ts";
import type { DiscoveryResult } from "../src/router.ts";
import { validConfig } from "../test-support/helpers.ts";

const readyConfig = (): ConfigResult => ({ status: "ready", path: "/safe/pi-fission.json", config: validConfig(), diagnostics: [] });
const allModels = Object.fromEntries(["fast", "code", "reason", "review", "research", "vision", "design"].map((id) => [id, id])) as Record<CanonicalProfile, string>;
const allCapabilities = Object.fromEntries(
  Object.entries(validConfig().profiles).map(([profile, config]) => [profile, config.capabilities]),
) as Record<CanonicalProfile, Capabilities>;

function readyDiscovery(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    status: "ready", models: [], resolvedProfiles: allModels, effectiveCapabilities: allCapabilities,
    unresolvedProfiles: [], diagnostic: "ready", ...overrides,
  };
}

function baseView(overrides: Partial<FissionView> = {}): FissionView {
  return {
    config: readyConfig(), discovery: readyDiscovery(), classification: null, recommendation: null,
    activeModel: "existing/actual-model", setup: null, routingStatus: "idle", routingReason: null, ...overrides,
  };
}

describe("config diagnostics", () => {
  it("provides conventional seven-group defaults", () => {
    const config = createDefaultConfig();
    assert.equal(config.profiles.fast.modelId, "fission-explore");
    assert.equal(config.profiles.code.modelId, "fission-sidekick");
    assert.equal(config.profiles.design.modelId, "fission-design");
    assert.equal(config.mode, "shadow");
    assert.equal(config.telemetry.enabled, false);
    assert.equal(config.tuning.enabled, false);
  });

  it("malformed configuration is visible without echoing credentials", () => {
    const raw = structuredClone(validConfig()) as unknown as Record<string, any>;
    raw.provider.apiKey = "super-secret-value";
    raw.profiles.vision.capabilities.image = "yes";
    const result = parseConfig(raw);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("provider.apiKey")));
    assert.ok(result.diagnostics.some((item) => item.includes("vision.capabilities.image")));
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /super-secret-value/);
  });

  it("allows keyless loopback and requires a key reference remotely", () => {
    const local = structuredClone(validConfig()) as unknown as Record<string, any>;
    local.provider.baseUrl = "http://127.0.0.1:20128/v1";
    delete local.provider.apiKey;
    assert.ok(parseConfig(local).config);

    const remote = structuredClone(local);
    remote.provider.baseUrl = "https://router.example.com/v1";
    const result = parseConfig(remote);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("apiKey")));
  });
});

describe("minimal status UI", () => {
  it("shows setup-required, unavailable, routed, retained, and manual states", () => {
    assert.match(footerText(baseView({ config: { status: "unconfigured", path: "/x", config: null, diagnostics: [] }, discovery: null })), /setup required/);
    assert.match(footerText(baseView({ discovery: { ...readyDiscovery(), status: "timeout", diagnostic: "timeout" } })), /9Router unavailable/);

    const code = classify({ text: "implement a code fix" });
    const route = recommend({ classification: code, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    const routed = baseView({ classification: code, recommendation: route, routingStatus: "routed" });
    assert.match(footerText(routed), /implement → code · code/);
    assert.match(formatStatus(routed), /routed/);
    assert.match(formatExplain(routed), /code → code/);

    assert.match(footerText({ ...routed, routingStatus: "retained" }), /retained current/);
    assert.match(footerText({ ...routed, routingStatus: "manual" }), /manual model/);
  });

  it("shows seven mappings and concise setup status", () => {
    assert.match(formatConfig(baseView()), /profiles 7/);
    assert.match(formatConfig(baseView()), /fast\s+fission-explore/);
    assert.match(formatSetup(baseView()), /incomplete/);
  });
});
