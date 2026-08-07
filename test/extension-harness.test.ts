import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFusionExtension } from "../src/extension.ts";
import { listen, validConfig, writeConfig } from "../test-support/helpers.ts";

type Handler = (event: any, context: any) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: any) => Promise<void>;
type Mode = "tui" | "print" | "json" | "rpc";

function fakeContext(
  cwd: string,
  notifications: string[],
  mode: Mode = "tui",
  model = { id: "actually-active", provider: "existing" },
  models: any[] = [],
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): ExtensionContext {
  const failPrompt = (): never => { throw new Error("shadow extension attempted to prompt"); };
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    modelRegistry: {
      find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
    },
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: (key: string, value: string | undefined) => { notifications.push(`status:${key}:${value ?? "cleared"}`); },
      select: failPrompt,
      confirm: failPrompt,
      input: failPrompt,
      editor: failPrompt,
    },
  } as unknown as ExtensionContext;
}

async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(path)) result[name] = await readFile(join(path, name), "utf8");
  return result;
}

function fakeApi(options: {
  setModel?: (model: any, callIndex: number) => boolean | Promise<boolean>;
  initialThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  clampThinkingForModel?: (model: any, current: string, callIndex: number) => string;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const providers: Array<{ name: string; provider: any }> = [];
  const forbiddenCalls: string[] = [];
  const selectionCalls: any[] = [];
  const thinkingCalls: string[] = [];
  let thinkingLevel = options.initialThinkingLevel ?? "high";
  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) { commands.set(name, options.handler); },
    registerProvider(name: string, provider: unknown) { providers.push({ name, provider }); },
    async setModel(model: any) {
      selectionCalls.push(model);
      const callIndex = selectionCalls.length - 1;
      const selected = await (options.setModel?.(model, callIndex) ?? true);
      if (selected && options.clampThinkingForModel) {
        thinkingLevel = options.clampThinkingForModel(model, thinkingLevel, callIndex) as typeof thinkingLevel;
      }
      return selected;
    },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level: typeof thinkingLevel) {
      thinkingCalls.push(level);
      thinkingLevel = level;
    },
    sendMessage() { forbiddenCalls.push("sendMessage"); },
    sendUserMessage() { forbiddenCalls.push("sendUserMessage/delegation"); },
    registerTool() { forbiddenCalls.push("registerTool/delegation"); },
    exec() { forbiddenCalls.push("exec/workflow"); },
    edit() { forbiddenCalls.push("edit"); },
    write() { forbiddenCalls.push("write"); },
    startWorkflow() { forbiddenCalls.push("workflow"); },
    release() { forbiddenCalls.push("release"); },
  } as unknown as ExtensionAPI;
  return {
    api, handlers, commands, providers, forbiddenCalls, selectionCalls, thinkingCalls,
    setThinkingLevelFromUser(level: typeof thinkingLevel) { thinkingLevel = level; },
    get thinkingLevel() { return thinkingLevel; },
  };
}

async function emit(handlers: Map<string, Handler[]>, context: ExtensionContext, name: string, event: any): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    const returned = await handler(event, context);
    assert.equal(returned, undefined, `${name} does not modify execution`);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for test condition");
}

describe("Pi observer extension shadow mode", () => {
  it("proves observation makes zero selection, delegation, or project mutation calls across TUI/print/JSON/RPC", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fusion-explore" },
        { id: "fusion-sidekick", context_window: 32_000, input: ["text"], supports_structured_output: false },
        { id: "fusion-plan" }, { id: "fusion-reviewer" }, { id: "fusion-research" }, { id: "fusion-vision" }, { id: "fusion-design" },
      ] }));
    });
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } });
    const { dir: agentDir, path: configPath } = await writeConfig(config);
    const projectDir = await mkdtemp(join(tmpdir(), "pi-fusion-project-"));
    await writeFile(join(projectDir, "source.ts"), "const untouched = 'SOURCE_SENTINEL';\n", "utf8");
    const before = await snapshot(projectDir);
    const runtime = fakeApi();
    const stderr: string[] = [];

    try {
      await createFusionExtension(runtime.api, {
        configPath,
        env: { TEST_9ROUTER_KEY: "CREDENTIAL_SENTINEL" },
        stderr: (message) => stderr.push(message),
      });
      assert.equal(runtime.providers.length, 1, "provider registered during async initialization");
      assert.equal(runtime.providers[0]?.name, "9router");
      const registeredCode = runtime.providers[0]?.provider.models.find((model: any) => model.id === "fusion-sidekick");
      assert.equal(registeredCode.contextWindow, 32_000, "known discovered context constrains registration");
      assert.equal(registeredCode.reasoning, true, "unknown discovered reasoning retains explicit configured floor");
      const expectedCommands = [
        "fusion", "fusion-cancel", "fusion-config", "fusion-dashboard-close", "fusion-delegate",
        "fusion-explain", "fusion-history", "fusion-mode", "fusion-pause", "fusion-plan",
        "fusion-proposals", "fusion-resume", "fusion-route-once", "fusion-setup",
        "fusion-setup-status", "fusion-status", "fusion-tune-approve", "fusion-tune-deny",
        "fusion-tune-propose", "fusion-tune-rollback", "fusion-workflow",
      ].sort((a, b) => a.localeCompare(b));

      assert.deepEqual([...runtime.commands.keys()].sort(), expectedCommands);
      for (const event of ["agent_settled", "before_agent_start", "tool_result", "turn_end", "model_select", "thinking_level_select", "after_provider_response", "session_start", "session_shutdown"]) {
        assert.ok(runtime.handlers.has(event), `registered ${event}`);
      }

      const notifications: string[] = [];
      const context = fakeContext(projectDir, notifications);
      await emit(runtime.handlers, context, "session_start", { reason: "startup" });
      await emit(runtime.handlers, context, "before_agent_start", { prompt: "Implement code PROMPT_SENTINEL", images: [], systemPrompt: "SYSTEM_SENTINEL" });
      await emit(runtime.handlers, context, "tool_result", {
        toolName: "read",
        toolCallId: "1",
        input: { path: "SOURCE_SENTINEL" },
        content: [{ type: "text", text: "TOOL_OUTPUT_SENTINEL" }],
        details: { credential: "CREDENTIAL_SENTINEL" },
        isError: false,
        usage: { inputTokens: 3 },
      });
      await emit(runtime.handlers, context, "after_provider_response", { status: 200, headers: {} });
      await emit(runtime.handlers, context, "turn_end", { turnIndex: 0, message: { usage: { input: 5, output: 2 } }, toolResults: [] });
      await emit(runtime.handlers, context, "model_select", { model: { id: "tenant-a/private-deployment", provider: "existing" }, source: "set" });

      const reportingCommands = ["fusion-config", "fusion-explain", "fusion-history", "fusion-status"];
      for (const name of reportingCommands) await runtime.commands.get(name)?.("", context);
      assert.ok(notifications.some((line) => line.includes("shadow")));
      assert.ok(notifications.some((line) => line.includes("active Pi model")));

      for (const mode of ["print", "json"] as const) {
        const nonTui = fakeContext(projectDir, [], mode);
        for (const name of reportingCommands) await runtime.commands.get(name)?.("", nonTui);
      }
      assert.equal(stderr.length, reportingCommands.length * 2);
      assert.ok(stderr.every((line) => line.startsWith("[pi-fusion]") && line.includes("shadow")));

      const rpcNotifications: string[] = [];
      const rpc = fakeContext(projectDir, rpcNotifications, "rpc");
      for (const name of reportingCommands) await runtime.commands.get(name)?.("", rpc);
      assert.equal(rpcNotifications.length, reportingCommands.length, "RPC uses normal UI notifications");

      assert.deepEqual(runtime.forbiddenCalls, []);
      assert.deepEqual(runtime.selectionCalls, [], "shadow requests never select a model");
      assert.deepEqual(runtime.thinkingCalls, [], "shadow mode never chooses or changes thinking levels");
      assert.deepEqual(await snapshot(projectDir), before, "project/source files remain byte-for-byte unchanged");
      const telemetry = await readFile(join(agentDir, "telemetry.jsonl"), "utf8");
      for (const sentinel of ["PROMPT_SENTINEL", "SYSTEM_SENTINEL", "SOURCE_SENTINEL", "TOOL_OUTPUT_SENTINEL", "CREDENTIAL_SENTINEL", "tenant-a/private-deployment"]) {
        assert.doesNotMatch(telemetry, new RegExp(sentinel));
      }
      assert.match(telemetry, /"recommendedProfile":"reason"/, "fusion-sidekick is ineligible under discovered lower capability floor");
      assert.match(telemetry, /"activeModelCategory":"external"/);
    } finally {
      await mock.close();
    }
  });

  it("reports explicit profile resolution gaps through the extension command surface", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "fusion-explore" }, { id: "fusion-sidekick" }, { id: "fusion-plan" },
        { id: "fusion-reviewer" }, { id: "fusion-research" }, { id: "fusion-small" },
      ] }));
    });
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
      },
    });
    const { path: configPath } = await writeConfig(config);
    const runtime = fakeApi();
    const stderr: string[] = [];
    try {
      await createFusionExtension(runtime.api, {
        configPath,
        env: { TEST_9ROUTER_KEY: "test" },
        stderr: (message) => stderr.push(message),
      });
      const context = fakeContext(tmpdir(), [], "json");
      await runtime.commands.get("fusion-config")?.("", context);
      assert.match(stderr.join(""), /unresolved vision/);
      assert.equal(runtime.providers[0]?.provider.models.some((model: any) => model.id === "fusion-vision"), false);
    } finally {
      await mock.close();
    }
  });

  it("sends keyless and configured-key inference through the real OpenAI transport with the correct auth", async () => {
    const inferenceAuthorization: Array<string | undefined> = [];
    const mock = await listen((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [
          { id: "fusion-explore" }, { id: "fusion-sidekick" }, { id: "fusion-plan" },
          { id: "fusion-reviewer" }, { id: "fusion-research" }, { id: "fusion-vision" }, { id: "fusion-design" },
        ] }));
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      inferenceAuthorization.push(request.headers.authorization);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "fusion-explore",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "fusion-explore",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    const base = validConfig();
    const keylessConfig = validConfig({ provider: { ...base.provider, baseUrl: mock.baseUrl, apiKey: undefined } });
    const keyedConfig = validConfig({ provider: { ...base.provider, baseUrl: mock.baseUrl } });
    const keylessWritten = await writeConfig(keylessConfig);
    const keyedWritten = await writeConfig(keyedConfig);
    const keylessRuntime = fakeApi();
    const keyedRuntime = fakeApi();
    const context = { messages: [{ role: "user" as const, content: "test", timestamp: 1 }] };
    try {
      await createFusionExtension(keylessRuntime.api, { configPath: keylessWritten.path, env: {} });
      await createFusionExtension(keyedRuntime.api, {
        configPath: keyedWritten.path,
        env: { TEST_9ROUTER_KEY: "CREDENTIAL_SENTINEL" },
      });
      const keyless = keylessRuntime.providers[0]?.provider;
      const keyed = keyedRuntime.providers[0]?.provider;
      assert.equal(keyless.apiKey, "local", "sentinel keeps Pi's model auth gate configured");
      assert.equal(keyless.authHeader, false);
      assert.equal(typeof keyless.streamSimple, "function");
      assert.equal(keyed.apiKey, "$TEST_9ROUTER_KEY");
      assert.equal(keyed.authHeader, true);
      assert.equal(keyed.streamSimple, undefined, "configured keys retain Pi's native authenticated transport");

      const keylessModel = { ...keyless.models[0], provider: "9router", api: keyless.api, baseUrl: keyless.baseUrl };
      const keyedModel = { ...keyed.models[0], provider: "9router", api: keyed.api, baseUrl: keyed.baseUrl };
      const keylessResult = await keyless.streamSimple(keylessModel, context, { apiKey: keyless.apiKey }).result();
      const keyedResult = await streamOpenAICompletions(keyedModel, context, { apiKey: "CREDENTIAL_SENTINEL" }).result();
      assert.equal(keylessResult.stopReason, "stop");
      assert.equal(keyedResult.stopReason, "stop");
      assert.deepEqual(inferenceAuthorization, [undefined, "Bearer CREDENTIAL_SENTINEL"]);
    } finally {
      await mock.close();
    }
  });

  it("allows /fusion-mode active once all seven probes pass", async () => {
    const mock = await listen((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [
          { id: "fusion-explore" }, { id: "fusion-sidekick" }, { id: "fusion-plan" },
          { id: "fusion-reviewer" }, { id: "fusion-research" }, { id: "fusion-vision" }, { id: "fusion-design" },
        ] }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    });
    const base = validConfig();
    const config = validConfig({ provider: { ...base.provider, baseUrl: mock.baseUrl } });
    const { dir, path: configPath } = await writeConfig(config);
    const runtime = fakeApi();
    const stderr: string[] = [];
    try {
      await createFusionExtension(runtime.api, {
        configPath,
        env: { TEST_9ROUTER_KEY: "test" },
        stderr: (message) => stderr.push(message),
      });
      const context = fakeContext(tmpdir(), [], "json");
      // Complete the durable setup state before requesting active.
      await runtime.commands.get("fusion-setup")?.("", context);
      await runtime.commands.get("fusion-mode")?.("active", context);
      assert.ok(stderr.some((line) => line.includes("fusion mode: active")), `mode applied: ${stderr.join(" | ")}`);
    } finally {
      await mock.close();
    }
  });

  it("registers only the namespaced 9Router provider fallback when discovery is unavailable", async () => {
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 50 } });
    const { path: configPath } = await writeConfig(config);
    const runtime = fakeApi();
    const stderr: string[] = [];
    await createFusionExtension(runtime.api, {
      configPath,
      env: { TEST_9ROUTER_KEY: "test" },
      stderr: (message) => stderr.push(message),
    });
    assert.equal(runtime.providers.length, 1);
    assert.equal(runtime.providers[0]?.name, "9router");
    assert.equal(runtime.providers[0]?.provider.models.length, 7, "explicit profile IDs supply registration fallback");
    const context = fakeContext(tmpdir(), [], "json");
    await runtime.commands.get("fusion-status")?.("", context);
    assert.match(stderr.join(""), /shadow · unavailable/);
    await runtime.commands.get("fusion-route-once")?.("", context);
    await emit(runtime.handlers, context, "before_agent_start", { prompt: "implement code", images: [] });
    await runtime.commands.get("fusion-status")?.("", context);
    assert.match(stderr.join(""), /one-shot skipped \(provider-unavailable\)/);
    assert.equal(runtime.selectionCalls.length, 0);
    await emit(runtime.handlers, context, "before_agent_start", { prompt: "implement another task", images: [] });
    assert.equal(runtime.selectionCalls.length, 0, "unavailable route arm is consumed");
    assert.deepEqual(runtime.forbiddenCalls, []);
  });
});

type FakeApiOptions = Parameters<typeof fakeApi>[0];

async function readyOneShotRuntime(
  setModelOrOptions?: ((model: any, callIndex: number) => boolean | Promise<boolean>) | FakeApiOptions,
) {
  const mock = await listen((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [
      { id: "fusion-explore" }, { id: "fusion-sidekick" }, { id: "fusion-plan" },
      { id: "fusion-reviewer" }, { id: "fusion-research" }, { id: "fusion-vision" }, { id: "fusion-design" },
    ] }));
  });
  const config = validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } });
  const written = await writeConfig(config);
  const runtime = fakeApi(typeof setModelOrOptions === "function"
    ? { setModel: setModelOrOptions }
    : setModelOrOptions);
  await createFusionExtension(runtime.api, {
    configPath: written.path,
    env: { TEST_9ROUTER_KEY: "CREDENTIAL_SENTINEL" },
  });
  const models = Object.values(config.profiles).map((profile) => ({ id: profile.modelId, provider: "9router", name: profile.modelId }));
  return { mock, config, written, runtime, models };
}

describe("Pi Fusion one-shot active routing", () => {
  it("arms once, selects before execution, ignores internal selection, and restores only after settlement", async () => {
    const fixture = await readyOneShotRuntime();
    const notifications: string[] = [];
    const previous = { id: "actually-active", provider: "existing", name: "Existing" };
    const context = fakeContext(tmpdir(), notifications, "tui", previous, fixture.models);
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      assert.ok(notifications.some((line) => line.includes("one-shot armed")));
      assert.ok(notifications.some((line) => line.includes("no additional route queued")), "repeated arming does not stack");

      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "Plan the architecture for a complex migration", images: [], systemPrompt: "SYSTEM_SENTINEL",
      });
      assert.equal(fixture.runtime.selectionCalls.length, 1, "selection completes inside before_agent_start");
      assert.equal(fixture.runtime.selectionCalls[0]?.id, "fusion-plan");

      const target = fixture.runtime.selectionCalls[0];
      await emit(fixture.runtime.handlers, context, "model_select", { model: target, previousModel: previous, source: "set" });
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 0, message: { usage: { input: 5, output: 2 } }, toolResults: [],
      });
      assert.equal(fixture.runtime.selectionCalls.length, 1, "turn_end does not restore during a tool-capable run");

      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls.length, 2);
      assert.equal(fixture.runtime.selectionCalls[1], previous, "restoration uses the exact prior Model object");
      const firstTelemetry = await readFile(join(fixture.written.dir, "telemetry.jsonl"), "utf8");
      assert.match(firstTelemetry, /"routeOnceStatus":"restored"/);

      (context as any).model = previous;
      await emit(fixture.runtime.handlers, context, "before_agent_start", { prompt: "Plan another architecture", images: [] });
      assert.equal(fixture.runtime.selectionCalls.length, 2, "the next request returns to shadow mode");
      assert.deepEqual(fixture.runtime.forbiddenCalls, []);
    } finally {
      await fixture.mock.close();
    }
  });

  it("restores an xhigh thinking preference after the routed model clamps it to high", async () => {
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const previous = { id: "xhigh-base", provider: "existing", name: "XHigh Base" };
    const context = fakeContext(tmpdir(), [], "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "Plan a small implementation", images: [],
      });
      assert.equal(fixture.runtime.thinkingLevel, "high", "native model switch clamps xhigh to target maximum");
      const target = fixture.runtime.selectionCalls[0];
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "high", previousLevel: "xhigh",
      });
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });

      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls[1], previous);
      assert.deepEqual(fixture.runtime.thinkingCalls, ["xhigh"], "one-shot restores but never chooses a new thinking level");
      assert.equal(fixture.runtime.thinkingLevel, "xhigh");
    } finally {
      await fixture.mock.close();
    }
  });

  it("keeps a user-selected model while restoring the original thinking preference", async () => {
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const previous = { id: "xhigh-base", provider: "existing", name: "XHigh Base" };
    const context = fakeContext(tmpdir(), [], "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "implement a small code fix", images: [],
      });
      const target = fixture.runtime.selectionCalls[0];
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "high", previousLevel: "xhigh",
      });
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });

      const userModel = { id: "user-final", provider: "user-provider", name: "User Final" };
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: userModel, previousModel: target, source: "set",
      });
      (context as any).model = userModel;
      await emit(fixture.runtime.handlers, context, "agent_settled", {});

      assert.equal(fixture.runtime.selectionCalls.length, 1, "user model wins without stale old-model restoration");
      assert.deepEqual(fixture.runtime.thinkingCalls, ["xhigh"]);
      assert.equal(fixture.runtime.thinkingLevel, "xhigh", "model override does not erase the original preference");
    } finally {
      await fixture.mock.close();
    }
  });

  it("keeps a user thinking selection made during the pre-model auth wait", async () => {
    const selectionGate = deferred<boolean>();
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      setModel: (_model, callIndex) => callIndex === 0 ? selectionGate.promise : true,
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const previous = { id: "xhigh-base", provider: "existing", name: "XHigh Base" };
    const context = fakeContext(tmpdir(), [], "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      const routing = emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "implement a small code fix", images: [],
      });
      await waitFor(() => fixture.runtime.selectionCalls.length === 1);

      fixture.runtime.setThinkingLevelFromUser("medium");
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "medium", previousLevel: "xhigh",
      });
      selectionGate.resolve(true);
      await routing;

      const target = fixture.runtime.selectionCalls[0];
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "high", previousLevel: "medium",
      });
      await emit(fixture.runtime.handlers, context, "agent_settled", {});

      assert.equal(fixture.runtime.thinkingLevel, "medium", "pre-auth user intent remains final");
      assert.deepEqual(fixture.runtime.thinkingCalls, ["medium"]);
    } finally {
      await fixture.mock.close();
    }
  });

  it("keeps an explicit user thinking selection made during delayed restoration", async () => {
    const restoreGate = deferred<boolean>();
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      setModel: (_model, callIndex) => callIndex === 1 ? restoreGate.promise : true,
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const previous = { id: "xhigh-base", provider: "existing", name: "XHigh Base" };
    const context = fakeContext(tmpdir(), [], "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "implement a small code fix", images: [],
      });
      const target = fixture.runtime.selectionCalls[0];
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "high", previousLevel: "xhigh",
      });
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });

      const settling = emit(fixture.runtime.handlers, context, "agent_settled", {});
      await waitFor(() => fixture.runtime.selectionCalls.length === 2);
      // Native restore events are internal even though setModel is still awaiting
      // other extension handlers.
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: previous, previousModel: target, source: "set",
      });
      fixture.runtime.setThinkingLevelFromUser("medium");
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "medium", previousLevel: "high",
      });
      restoreGate.resolve(true);
      await settling;

      assert.equal(fixture.runtime.thinkingLevel, "medium", "latest explicit user level remains final");
      assert.deepEqual(fixture.runtime.thinkingCalls, ["medium"], "extension reapplies user intent instead of original xhigh");
    } finally {
      await fixture.mock.close();
    }
  });

  it("consumes low-confidence, registry-miss, and failed-selection arms without a later surprise route", async () => {
    const cases = [
      { name: "low-confidence", prompt: "maybe", models: true, result: true, calls: 0, reason: "no-recommendation" },
      { name: "registry-miss", prompt: "implement a code fix", models: false, result: true, calls: 0, reason: "model-not-found" },
      { name: "selection-failed", prompt: "implement a code fix", models: true, result: false, calls: 1, reason: "selection-failed" },
    ];
    for (const item of cases) {
      const fixture = await readyOneShotRuntime(() => item.result);
      const notifications: string[] = [];
      const models = item.models ? fixture.models : [];
      const context = fakeContext(tmpdir(), notifications, "tui", { id: "current", provider: "existing" }, models);
      try {
        await fixture.runtime.commands.get("fusion-route-once")?.("", context);
        await emit(fixture.runtime.handlers, context, "before_agent_start", { prompt: item.prompt, images: [] });
        assert.equal(fixture.runtime.selectionCalls.length, item.calls, item.name);
        await fixture.runtime.commands.get("fusion-status")?.("", context);
        assert.ok(notifications.some((line) => line.includes(item.reason)), `${item.name} is visible`);

        await emit(fixture.runtime.handlers, context, "before_agent_start", { prompt: "implement another code fix", images: [] });
        assert.equal(fixture.runtime.selectionCalls.length, item.calls, `${item.name} consumed the arm`);
      } finally {
        await fixture.mock.close();
      }
    }
  });

  it("keeps a user-selected model and records only allow-listed one-shot state", async () => {
    const fixture = await readyOneShotRuntime();
    const notifications: string[] = [];
    const previous = { id: "private-previous-SOURCE_SENTINEL", provider: "existing" };
    const context = fakeContext(tmpdir(), notifications, "tui", previous, fixture.models);
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "Review PROMPT_SENTINEL credentials CREDENTIAL_SENTINEL", images: [],
      });
      const target = fixture.runtime.selectionCalls[0];
      await emit(fixture.runtime.handlers, context, "model_select", { model: target, previousModel: previous, source: "set" });
      const userModel = { id: "tenant-a/TOOL_OUTPUT_SENTINEL", provider: "user-provider" };
      await emit(fixture.runtime.handlers, context, "model_select", { model: userModel, previousModel: target, source: "set" });
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      assert.ok(notifications.some((line) => line.includes("no additional route queued")), "override cannot stack another arm before settlement");
      (context as any).model = userModel;
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 0, message: { usage: { input: 1, output: 1 } }, toolResults: [],
      });
      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls.length, 1, "stale restoration is cancelled");
      await fixture.runtime.commands.get("fusion-status")?.("", context);
      assert.ok(notifications.some((line) => line.includes("user-overrode")));

      const telemetry = await readFile(join(fixture.written.dir, "telemetry.jsonl"), "utf8");
      assert.match(telemetry, /"routeOnceStatus":"user-overrode"/);
      for (const sentinel of ["PROMPT_SENTINEL", "CREDENTIAL_SENTINEL", "SOURCE_SENTINEL", "TOOL_OUTPUT_SENTINEL", "tenant-a"]) {
        assert.doesNotMatch(telemetry, new RegExp(sentinel));
      }
    } finally {
      await fixture.mock.close();
    }
  });

  it("reapplies a user model selected during delayed internal restoration", async () => {
    const restoreGate = deferred<boolean>();
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      setModel: (_model, callIndex) => callIndex === 1 ? restoreGate.promise : true,
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const notifications: string[] = [];
    const previous = { id: "current", provider: "existing", name: "Existing" };
    const context = fakeContext(tmpdir(), notifications, "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "implement a code fix", images: [],
      });
      const target = fixture.runtime.selectionCalls[0];
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "thinking_level_select", {
        level: "high", previousLevel: "xhigh",
      });
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 0, message: { usage: { input: 1, output: 1 } }, toolResults: [],
      });

      const settling = emit(fixture.runtime.handlers, context, "agent_settled", {});
      await waitFor(() => fixture.runtime.selectionCalls.length === 2);
      const userModel = { id: "user-final", provider: "user-provider", name: "User Final" };
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: userModel, previousModel: target, source: "set",
      });
      (context as any).model = userModel;
      restoreGate.resolve(true);
      await settling;

      assert.equal(fixture.runtime.selectionCalls.length, 3);
      assert.equal(fixture.runtime.selectionCalls[1], previous, "internal restoration remains an explicit transaction");
      assert.equal(fixture.runtime.selectionCalls[2], userModel, "latest user selection is reapplied after delayed restore");
      assert.deepEqual(fixture.runtime.thinkingCalls, ["xhigh"]);
      assert.equal(fixture.runtime.thinkingLevel, "xhigh", "delayed user model keeps original thinking preference");
      await fixture.runtime.commands.get("fusion-status")?.("", context);
      assert.ok(notifications.some((line) => line.includes("one-shot user-overrode")));
      assert.ok(notifications.some((line) => line.includes("active Pi model: user-provider/user-final")));
    } finally {
      await fixture.mock.close();
    }
  });

  it("restores model and thinking on normal session shutdown before agent settlement", async () => {
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const notifications: string[] = [];
    const previous = { id: "current", provider: "existing", name: "Existing" };
    const context = fakeContext(tmpdir(), notifications, "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "implement a code fix", images: [],
      });
      const target = fixture.runtime.selectionCalls[0];
      await emit(fixture.runtime.handlers, context, "model_select", {
        model: target, previousModel: previous, source: "set",
      });
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 0, message: { usage: { input: 1, output: 1 } }, toolResults: [],
      });

      await emit(fixture.runtime.handlers, context, "session_shutdown", {});
      assert.equal(fixture.runtime.selectionCalls.length, 2);
      assert.equal(fixture.runtime.selectionCalls[1], previous, "shutdown awaits exact prior-model restoration");
      assert.equal(fixture.runtime.thinkingLevel, "xhigh", "shutdown restores the exact prior thinking preference");
      assert.deepEqual(fixture.runtime.thinkingCalls, ["xhigh"]);
      assert.ok(notifications.includes("status:pi-fusion:cleared"));

      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls.length, 2, "later settlement cannot duplicate shutdown restoration");
      const telemetry = await readFile(join(fixture.written.dir, "telemetry.jsonl"), "utf8");
      assert.equal(telemetry.trim().split("\n").length, 1, "shutdown and settlement append one record total");
      assert.match(telemetry, /"routeOnceStatus":"restored"/);
    } finally {
      await fixture.mock.close();
    }
  });

  it("keeps an already-current target active until settlement without duplicate telemetry", async () => {
    const fixture = await readyOneShotRuntime();
    const notifications: string[] = [];
    const current = fixture.models.find((model) => model.id === "fusion-plan");
    assert.ok(current);
    const context = fakeContext(tmpdir(), notifications, "tui", current, fixture.models);
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", {
        prompt: "Plan the architecture for a complex migration", images: [],
      });
      assert.equal(fixture.runtime.selectionCalls.length, 0, "already-current target requires no model API call");

      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      assert.ok(notifications.some((line) => line.includes("already active")), "same-target run rejects a stacked arm");
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 0, message: { usage: { input: 1, output: 1 } }, toolResults: [],
      });
      await emit(fixture.runtime.handlers, context, "turn_end", {
        turnIndex: 1, message: { usage: { input: 2, output: 1 } }, toolResults: [],
      });
      assert.equal((await readdir(fixture.written.dir)).includes("telemetry.jsonl"), false, "intermediate turns do not persist applied records");

      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls.length, 0, "same-target settlement requires no restoration call");
      assert.deepEqual(fixture.runtime.thinkingCalls, [], "same-target one-shot does not touch thinking");
      const telemetry = await readFile(join(fixture.written.dir, "telemetry.jsonl"), "utf8");
      assert.equal(telemetry.trim().split("\n").length, 1, "one settled run creates one telemetry record");
      assert.match(telemetry, /"routeOnceStatus":"restored"/);

      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      assert.equal(notifications.filter((line) => line.includes("one-shot armed · exactly")).length, 2, "a fresh arm is allowed only after settlement");
    } finally {
      await fixture.mock.close();
    }
  });

  it("surfaces a non-throwing restoration failure without forcing thinking on the routed model", async () => {
    const fixture = await readyOneShotRuntime({
      initialThinkingLevel: "xhigh",
      setModel: (_model, callIndex) => callIndex === 0,
      clampThinkingForModel: (model, current) => model.provider === "9router" ? "high" : current,
    });
    const notifications: string[] = [];
    const previous = { id: "current", provider: "existing" };
    const context = fakeContext(tmpdir(), notifications, "tui", previous, fixture.models, "xhigh");
    try {
      await fixture.runtime.commands.get("fusion-route-once")?.("", context);
      await emit(fixture.runtime.handlers, context, "before_agent_start", { prompt: "implement a code fix", images: [] });
      const target = fixture.runtime.selectionCalls[0];
      await emit(fixture.runtime.handlers, context, "model_select", { model: target, previousModel: previous, source: "set" });
      (context as any).model = target;
      await emit(fixture.runtime.handlers, context, "turn_end", { turnIndex: 0, message: {}, toolResults: [] });
      await emit(fixture.runtime.handlers, context, "agent_settled", {});
      assert.equal(fixture.runtime.selectionCalls.length, 2);
      await fixture.runtime.commands.get("fusion-status")?.("", context);
      assert.ok(notifications.some((line) => line.includes("restore-failed")));
      assert.equal(fixture.runtime.thinkingLevel, "high", "failed model restore does not force unsupported xhigh on routed model");
      assert.deepEqual(fixture.runtime.thinkingCalls, []);
      const telemetry = await readFile(join(fixture.written.dir, "telemetry.jsonl"), "utf8");
      assert.match(telemetry, /"routeOnceStatus":"restore-failed"/);
    } finally {
      await fixture.mock.close();
    }
  });
});
