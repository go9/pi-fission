import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverModels } from "../src/router.ts";
import { listen, validConfig } from "../test-support/helpers.ts";

const env = { TEST_9ROUTER_KEY: "test-key-that-must-never-appear" };

describe("9Router discovery integration", () => {
  it("9Router discovery resolves canonical IDs and semantic aliases", async () => {
    const mock = await listen((request, response) => {
      assert.equal(request.url, "/v1/models");
      assert.equal(request.headers.authorization, "Bearer test-key-that-must-never-appear");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "pi-fast" }, { id: "pi-code" }, { id: "plan" }, { id: "pi-review" }, { id: "pi-research" }, { id: "pi-vision" },
      ] }));
    });
    try {
      const result = await discoverModels(validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } }), { env });
      assert.equal(result.status, "ready");
      assert.equal(result.resolvedProfiles["pi-reason"], "plan");
      assert.equal(result.resolvedProfiles["pi-fast"], "pi-fast");
      assert.doesNotMatch(result.diagnostic, /test-key/);
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
      setTimeout(() => response.end(JSON.stringify({ data: [{ id: "pi-fast" }] })), 150);
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
