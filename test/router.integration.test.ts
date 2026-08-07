import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverModels } from "../src/router.ts";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { listen, validConfig } from "../test-support/helpers.ts";

const env = { TEST_9ROUTER_KEY: "test-key-that-must-never-appear" };

describe("9Router discovery integration", () => {
  it("9Router discovery resolves canonical IDs and semantic aliases", async () => {
    const mock = await listen((request, response) => {
      assert.equal(request.url, "/v1/models");
      assert.equal(request.headers.authorization, "Bearer test-key-that-must-never-appear");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fast" }, { id: "code" }, { id: "plan" }, { id: "review" }, { id: "research" }, { id: "vision" }, { id: "design" },
      ] }));
    });
    try {
      const result = await discoverModels(validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } }), { env });
      assert.equal(result.status, "ready");
      assert.equal(result.resolvedProfiles["reason"], "plan");
      assert.equal(result.resolvedProfiles["fast"], "fast");
      assert.doesNotMatch(result.diagnostic, /test-key/);
    } finally {
      await mock.close();
    }
  });

  it("discovers a keyless loopback catalogue without sending Authorization", async () => {
    const mock = await listen((request, response) => {
      assert.equal(request.headers.authorization, undefined);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fast" }, { id: "code" }, { id: "reason" },
        { id: "review" }, { id: "research" }, { id: "vision" }, { id: "design" },
      ] }));
    });
    try {
      const base = validConfig();
      const config = validConfig({ provider: { ...base.provider, baseUrl: mock.baseUrl, apiKey: undefined } });
      const result = await discoverModels(config, { env: {} });
      assert.equal(result.status, "ready");
      assert.equal(result.models.length, 7);
    } finally {
      await mock.close();
    }
  });

  it("known discovered limits constrain configured capability floors conservatively", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fast" },
        { id: "code", context_window: 32_000, input: ["text"], supports_tools: true, supports_reasoning: true, supports_structured_output: false },
        { id: "reason" }, { id: "review" }, { id: "research" },
        { id: "vision", context_window: 64_000, modalities: { input: ["text"] } },
        { id: "design" },
      ] }));
    });
    try {
      const config = validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } });
      const result = await discoverModels(config, { env });
      assert.equal(result.status, "ready");
      assert.deepEqual(result.effectiveCapabilities["code"], {
        ...config.profiles["code"].capabilities,
        structuredOutput: false,
        contextWindow: 32_000,
      });
      assert.equal(result.effectiveCapabilities["vision"]?.image, false);
      assert.equal(result.effectiveCapabilities["reason"]?.contextWindow, 128_000, "unknown discovered fields retain explicit configured floors");
      const route = recommend({
        classification: classify({ text: "implement a TypeScript change" }),
        config,
        resolvedModels: result.resolvedProfiles,
        effectiveCapabilities: result.effectiveCapabilities,
        providerReady: true,
      });
      const code = route.evaluations.find((entry) => entry.profile === "code");
      assert.ok(code?.reasons.includes("capability.structured-output"));
      assert.ok(code?.reasons.includes("capability.context-window"));
    } finally {
      await mock.close();
    }
  });

  it("reports explicit unresolved canonical profiles", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fusion-explore" }, { id: "fusion-plan" }, { id: "fusion-research" },
        { id: "fusion-reviewer" }, { id: "fusion-sidekick" }, { id: "fusion-small" }, { id: "fusion-design" },
      ] }));
    });
    try {
      const base = validConfig();
      const config = validConfig({
        provider: { ...base.provider, baseUrl: mock.baseUrl },
        profiles: {
          ...base.profiles,
          "fast": { ...base.profiles["fast"], modelId: "fusion-explore" },
          "code": { ...base.profiles["code"], modelId: "fusion-sidekick" },
          "reason": { ...base.profiles["reason"], modelId: "fusion-plan" },
          "review": { ...base.profiles["review"], modelId: "fusion-reviewer" },
          "research": { ...base.profiles["research"], modelId: "fusion-research" },
          "vision": { ...base.profiles["vision"], modelId: "fusion-vision" },
          "design": { ...base.profiles["design"], modelId: "fusion-design" },
        },
      });
      const result = await discoverModels(config, { env });
      assert.equal(result.status, "ready");
      assert.deepEqual(result.unresolvedProfiles, ["vision"]);
      assert.match(result.diagnostic, /1 unresolved profile/);
    } finally {
      await mock.close();
    }
  });

  it("9Router discovery reports a malformed response", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [] }));
    });
    try {
      const result = await discoverModels(validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } }), { env });
      assert.equal(result.status, "malformed");
      assert.match(result.diagnostic, /data array/);
    } finally {
      await mock.close();
    }
  });

  it("9Router discovery reports a timeout", async () => {
    const mock = await listen((_request, response) => {
      setTimeout(() => response.end(JSON.stringify({ data: [{ id: "fast" }] })), 150);
    });
    try {
      const config = validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl, timeoutMs: 50 } });
      const result = await discoverModels(config, { env });
      assert.equal(result.status, "timeout");
      assert.match(result.diagnostic, /timed out/);
    } finally {
      await mock.close();
    }
  });

  it("9Router discovery reports an unavailable endpoint", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 50 } });
    const result = await discoverModels(config, { env });
    assert.equal(result.status, "unavailable");
    assert.doesNotMatch(result.diagnostic, /test-key-that-must-never-appear/);
  });

  it("9Router discovery reports an empty catalogue", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });
    try {
      const result = await discoverModels(validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } }), { env });
      assert.equal(result.status, "empty");
    } finally {
      await mock.close();
    }
  });

  it("9Router discovery reports auth failure without credentials", async () => {
    const mock = await listen((_request, response) => {
      response.statusCode = 401;
      response.end("credential rejected: test-key-that-must-never-appear");
    });
    try {
      const result = await discoverModels(validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } }), { env });
      assert.equal(result.status, "auth");
      assert.equal(result.diagnostic, "9Router authentication failed");
      assert.doesNotMatch(JSON.stringify(result), /test-key-that-must-never-appear/);
    } finally {
      await mock.close();
    }
  });

  it("9Router discovery reports a missing environment credential without a request", async () => {
    const result = await discoverModels(validConfig(), { env: {} });
    assert.equal(result.status, "auth");
    assert.match(result.diagnostic, /environment variable/);
  });
});
