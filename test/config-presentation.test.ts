import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig, parseConfig, type ConfigResult } from "../src/config.ts";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { footerText, formatSetupTable, type FissionView } from "../src/presentation.ts";
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

  it("treats the telemetry and tuning sections as optional but still validates a written one", () => {
    const raw = structuredClone(validConfig()) as unknown as Record<string, any>;
    delete raw.telemetry;
    delete raw.tuning;
    const omitted = parseConfig(raw);
    assert.deepEqual(omitted.diagnostics, [], "diagnostics-only sections must not make a routable config invalid");
    assert.equal(omitted.config?.telemetry.enabled, false);
    assert.equal(omitted.config?.tuning.maxSwitches, 4);

    const typo = structuredClone(validConfig()) as unknown as Record<string, any>;
    typo.telemetry.maxEntries = "lots";
    assert.equal(parseConfig(typo).config, null, "a section you did write is still checked in full");
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

  it("accepts any provider id, because the contract is OpenAI-compatible HTTP and not a vendor", () => {
    // This pinned to /^9router/ once, so every other router was a config error and the
    // extension was unusable by anyone who did not run the author's setup. The only calls
    // made are GET {baseUrl}/models and POST {baseUrl}/chat/completions.
    for (const id of ["litellm", "openrouter", "ollama", "openai", "vllm", "9router", "my-gateway.internal"]) {
      const candidate = structuredClone(validConfig()) as unknown as Record<string, any>;
      candidate.provider.id = id;
      assert.ok(parseConfig(candidate).config, `provider id ${id} must validate`);
    }

    const empty = structuredClone(validConfig()) as unknown as Record<string, any>;
    empty.provider.id = "";
    assert.equal(parseConfig(empty).config, null, "an id still has to be a usable slug");
  });

  it("ships a default that is loopback and keyless, so it validates before it is edited", () => {
    // createDefaultConfig is what an unconfigured install writes. If the default failed its
    // own validator the first run would report a broken config the user never wrote.
    const fresh = createDefaultConfig();
    assert.ok(parseConfig(JSON.parse(JSON.stringify(fresh))).config, "the default config must validate");
    assert.equal(fresh.provider.apiKey, undefined, "no key is required for a loopback default");
  });
});

describe("minimal status UI", () => {
  it("shows setup-required, unavailable, routed, retained, and manual states", () => {
    assert.match(footerText(baseView({ config: { status: "unconfigured", path: "/x", config: null, diagnostics: [] }, discovery: null })), /setup required/);
    assert.match(footerText(baseView({ discovery: { ...readyDiscovery(), status: "timeout", diagnostic: "timeout" } })), /provider unavailable/);

    const code = classify({ text: "implement a code fix" });
    const route = recommend({ classification: code, config: validConfig(), resolvedModels: allModels, effectiveCapabilities: allCapabilities, providerReady: true });
    const routed = baseView({ classification: code, recommendation: route, routingStatus: "routed" });
    assert.match(footerText(routed), /implement → code · code/);

    assert.match(footerText({ ...routed, routingStatus: "retained" }), /retained current/);
    assert.match(footerText({ ...routed, routingStatus: "manual" }), /manual model/);
  });

  it("shows every mapping beside the evidence for it, in one table", () => {
    const table = formatSetupTable(baseView());
    // The declaration and the verdict on it must appear on the SAME row: reading either
    // alone is what made the two old commands feel redundant.
    assert.match(table, /fast\s+fission-explore\s+not probed/);
    for (const profile of ["fast", "code", "reason", "review", "research", "vision", "design"]) {
      assert.match(table, new RegExp(`\\n  ${profile}\\s`), `${profile} row missing`);
    }
    assert.match(table, /0\/7 verified/);
    assert.match(table, /run \/fission-setup probe/);
  });

  it("distinguishes a failed probe from one that never ran, and names the failure", () => {
    const probed = formatSetupTable(baseView({
      setup: {
        version: 1,
        complete: false,
        lastProbedAt: "2026-08-09T14:32:11Z",
        probes: {
          fast: { profile: "fast", modelId: "fission-explore", ok: true, probedAt: "t", keyless: false },
          review: { profile: "review", modelId: "fission-reviewer", ok: false, error: "group not found", probedAt: "t", keyless: false },
        },
      },
    }));
    assert.match(probed, /fast\s+fission-explore\s+ok/);
    assert.match(probed, /review\s+fission-reviewer\s+FAILED\s+group not found/);
    assert.match(probed, /code\s+fission-sidekick\s+not probed/, "unprobed must not read as failed");
    assert.match(probed, /1\/7 verified/);
  });

  it("shows project-override targets as their own rows, outside the seven-profile count", () => {
    const table = formatSetupTable(baseView({
      setup: {
        version: 1,
        complete: true,
        lastProbedAt: "2026-08-09T14:32:11Z",
        probes: {},
        overrideProbes: [
          { profile: "code", modelId: "repo-specific-code", ok: true, probedAt: "t", keyless: false },
          { profile: "fast", modelId: "repo-specific-fast", ok: false, error: "group not found", probedAt: "t", keyless: false },
        ],
      },
    }));
    assert.match(table, /override\s+repo-specific-code\s+ok/);
    assert.match(table, /override\s+repo-specific-fast\s+FAILED\s+group not found/);
    assert.match(table, /0\/7 verified/, "an override is not one of the seven mappings");
  });
});
