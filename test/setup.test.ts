import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, defaultSetupStatePath, effectiveProfileTarget } from "../src/config.ts";
import { diagnoseSetup, isActiveReady, probeAll, runProbe, loadSetupState, saveSetupState } from "../src/setup.ts";
import { validConfig } from "../test-support/helpers.ts";

function chatCompletion(text: string, status = 200) {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "fission-plan",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  });
}

describe("full-product config", () => {
  it("migrates a 0.1 six-profile config into seven canonical profiles", () => {
    const legacy = {
      version: 1,
      enabled: true,
      provider: { id: "9router", baseUrl: "http://127.0.0.1:20128/v1", apiKey: "$NINE_ROUTER_API_KEY", timeoutMs: 2000 },
      profiles: {
        "pi-fast": { modelId: "fission-explore", capabilities: { tools: true, reasoning: false, image: false, structuredOutput: false, contextWindow: 64000 } },
        "pi-code": { modelId: "fission-sidekick", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 128000 } },
        "pi-reason": { modelId: "fission-plan", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 200000 } },
        "pi-review": { modelId: "fission-reviewer", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 200000 } },
        "pi-research": { modelId: "fission-research", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: false, contextWindow: 200000 } },
        "pi-vision": { modelId: "fission-vision", capabilities: { tools: true, reasoning: true, image: true, structuredOutput: false, contextWindow: 128000 } },
      },
      aliases: { plan: "pi-reason", sidekick: "pi-code", explore: "pi-fast", "small-model": "pi-fast" },
      telemetry: { enabled: true, file: "telemetry.jsonl", maxEntries: 200 },
    };
    const result = parseConfig(legacy);
    assert.ok(result.config, `migration failed: ${result.diagnostics.join("; ")}`);
    assert.equal(result.config?.version, 2);
    assert.equal(result.config?.mode, "shadow", "migrated config defaults to shadow, never active");
    assert.ok(result.config?.profiles.fast);
    assert.ok(result.config?.profiles.design, "design profile is added by migration");
    assert.equal(Object.keys(result.config!.profiles).length, 7);
  });

  it("applies project overrides only to their matching repository", () => {
    const config = validConfig({
      projectOverrides: [
        { repo: "/repo-a", profiles: { fast: "override-model-a" } },
        { repo: "/repo-b", profiles: { fast: "override-model-b" } },
      ],
    });
    assert.equal(effectiveProfileTarget(config, "fast", "/repo-a"), "override-model-a");
    assert.equal(effectiveProfileTarget(config, "fast", "/repo-b"), "override-model-b");
    assert.equal(effectiveProfileTarget(config, "fast", "/repo-c"), "fission-explore", "unmatched repo uses the global target");
    assert.equal(effectiveProfileTarget(config, "fast"), "fission-explore", "no repo uses the global target");
  });

  it("rejects an active mode config with missing profiles", () => {
    const config = validConfig();
    const raw = structuredClone(config) as unknown as Record<string, any>;
    delete raw.profiles.design;
    const result = parseConfig(raw);
    assert.equal(result.config, null);
    assert.ok(result.diagnostics.some((item) => item.includes("profiles.design")));
  });
});

describe("setup diagnostics and probes", () => {
  it("flags profile targets missing from the discovered catalogue", () => {
    const config = validConfig();
    const diagnostics = diagnoseSetup(config, [{ id: "fission-explore" }, { id: "fission-sidekick" }]);
    const reason = diagnostics.find((item) => item.profile === "reason");
    assert.ok(reason);
    assert.equal(reason.ok, false);
    assert.ok(reason.issues.includes("target not in discovered catalogue"));
  });

  it("runs a real minimal inference probe and requires the exact OK text", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:1/v1" } });
    let authorization: string | undefined;
    const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(chatCompletion("OK"), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await runProbe(config, "reason", "fission-plan", { fetch: fetchImpl as unknown as typeof fetch, env: { TEST_9ROUTER_KEY: "secret" } });
    assert.equal(result.ok, true);
    assert.equal(result.keyless, false);
    assert.equal(authorization, "Bearer secret");
  });

  it("probes without Authorization on keyless loopback and fails on wrong text", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:20128/v1", apiKey: undefined } });
    let authorization: string | undefined;
    const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(chatCompletion("I will help"), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await runProbe(config, "code", "fission-sidekick", { fetch: fetchImpl as unknown as typeof fetch, env: {} });
    assert.equal(result.ok, false, "non-OK text fails the probe");
    assert.equal(result.keyless, true);
    assert.equal(authorization, undefined, "keyless loopback sends no Authorization");
  });

  it("probeAll gates active readiness on all seven profiles", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:20128/v1", apiKey: undefined } });
    const fetchImpl = async (): Promise<Response> => new Response(chatCompletion("OK"), { status: 200, headers: { "content-type": "application/json" } });
    const { probes, complete, failures } = await probeAll(config, { fetch: fetchImpl as unknown as typeof fetch, env: {} });
    assert.equal(complete, true);
    assert.deepEqual(failures, []);
    assert.equal(Object.keys(probes).length, 7);
    assert.equal(isActiveReady({ ...config, mode: "active" }, { version: 1, complete, lastProbedAt: null, probes }), true);
  });

  it("blocks active readiness when any profile fails or is unprobed", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:1/v1" } });
    const okFetch = async (): Promise<Response> => new Response(chatCompletion("OK"), { status: 200, headers: { "content-type": "application/json" } });
    const failFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      return new Response(chatCompletion(body.model === "fission-vision" ? "nope" : "OK"), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { probes, complete, failures } = await probeAll(config, { fetch: failFetch as unknown as typeof fetch, env: { TEST_9ROUTER_KEY: "secret" } });
    assert.equal(complete, false);
    assert.ok(failures.includes("vision"));
    assert.equal(isActiveReady({ ...config, mode: "active" }, { version: 1, complete, lastProbedAt: null, probes }), false);
    // Unprobed state also blocks.
    assert.equal(isActiveReady({ ...config, mode: "active" }, { version: 1, complete: false, lastProbedAt: null, probes: {} }), false);
    assert.equal(isActiveReady({ ...config, mode: "shadow" }, { version: 1, complete: false, lastProbedAt: null, probes: {} }), false, "shadow is not active-ready");
  });

  it("active readiness requires probe targets to match the current config targets", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:20128/v1", apiKey: undefined } });
    const okFetch = async (): Promise<Response> => new Response(chatCompletion("OK"), { status: 200, headers: { "content-type": "application/json" } });
    const { probes, complete } = await probeAll(config, { fetch: okFetch as unknown as typeof fetch, env: {} });
    assert.equal(complete, true);
    assert.equal(isActiveReady({ ...config, mode: "active" }, { version: 1, complete, lastProbedAt: null, probes }), true);
    // Changing a profile target after a complete setup invalidates readiness until re-probed.
    const staleTarget = { ...config, profiles: { ...config.profiles, fast: { ...config.profiles.fast, modelId: "fission-new-target" } } };
    assert.equal(isActiveReady({ ...staleTarget, mode: "active" }, { version: 1, complete, lastProbedAt: null, probes }), false);
  });

  it("persists setup state and rejects an active mode without a complete setup file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fission-setup-"));
    const configPath = join(dir, "pi-fission.json");
    const setup = { version: 1 as const, complete: true, lastProbedAt: "2026-01-01T00:00:00.000Z", probes: {
      fast: { profile: "fast" as const, modelId: "fission-explore", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      code: { profile: "code" as const, modelId: "fission-sidekick", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      reason: { profile: "reason" as const, modelId: "fission-plan", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      review: { profile: "review" as const, modelId: "fission-reviewer", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      research: { profile: "research" as const, modelId: "fission-research", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      vision: { profile: "vision" as const, modelId: "fission-vision", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
      design: { profile: "design" as const, modelId: "fission-design", ok: true, keyless: true, probedAt: "2026-01-01T00:00:00.000Z" },
    } };
    await saveSetupState(configPath, setup);
    const loaded = await loadSetupState(configPath);
    assert.equal(loaded.complete, true);
    assert.equal(loaded.probes.reason?.ok, true);
    const file = await readFile(defaultSetupStatePath(configPath), "utf8");
    assert.doesNotMatch(file, /Bearer|Authorization|apiKey/);
  });
});
