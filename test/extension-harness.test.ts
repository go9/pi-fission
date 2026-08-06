import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
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
): ExtensionContext {
  const failPrompt = (): never => { throw new Error("shadow extension attempted to prompt"); };
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    model,
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

function fakeApi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const providers: Array<{ name: string; provider: any }> = [];
  const forbiddenCalls: string[] = [];
  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) { commands.set(name, options.handler); },
    registerProvider(name: string, provider: unknown) { providers.push({ name, provider }); },
    setModel() { forbiddenCalls.push("setModel"); },
    setThinkingLevel() { forbiddenCalls.push("setThinkingLevel"); },
    sendMessage() { forbiddenCalls.push("sendMessage"); },
    sendUserMessage() { forbiddenCalls.push("sendUserMessage/delegation"); },
    registerTool() { forbiddenCalls.push("registerTool/delegation"); },
    exec() { forbiddenCalls.push("exec/workflow"); },
    edit() { forbiddenCalls.push("edit"); },
    write() { forbiddenCalls.push("write"); },
    startWorkflow() { forbiddenCalls.push("workflow"); },
    release() { forbiddenCalls.push("release"); },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, providers, forbiddenCalls };
}

async function emit(handlers: Map<string, Handler[]>, context: ExtensionContext, name: string, event: any): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    const returned = await handler(event, context);
    assert.equal(returned, undefined, `${name} does not modify execution`);
  }
}

describe("Pi observer extension shadow mode", () => {
  it("proves observation makes zero selection, delegation, or project mutation calls across TUI/print/JSON/RPC", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "pi-fast" },
        { id: "pi-code", context_window: 32_000, input: ["text"], supports_structured_output: false },
        { id: "pi-reason" }, { id: "pi-review" }, { id: "pi-research" }, { id: "pi-vision" },
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
      const registeredCode = runtime.providers[0]?.provider.models.find((model: any) => model.id === "pi-code");
      assert.equal(registeredCode.contextWindow, 32_000, "known discovered context constrains registration");
      assert.equal(registeredCode.reasoning, true, "unknown discovered reasoning retains explicit configured floor");
      assert.deepEqual([...runtime.commands.keys()].sort(), ["fusion-config", "fusion-explain", "fusion-history", "fusion-status"]);
      for (const event of ["before_agent_start", "tool_result", "turn_end", "model_select", "after_provider_response", "session_start", "session_shutdown"]) {
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

      for (const command of runtime.commands.values()) await command("", context);
      assert.ok(notifications.some((line) => line.includes("shadow")));
      assert.ok(notifications.some((line) => line.includes("active Pi model")));

      for (const mode of ["print", "json"] as const) {
        const nonTui = fakeContext(projectDir, [], mode);
        for (const command of runtime.commands.values()) await command("", nonTui);
      }
      assert.equal(stderr.length, runtime.commands.size * 2);
      assert.ok(stderr.every((line) => line.startsWith("[pi-fusion]") && line.includes("shadow")));

      const rpcNotifications: string[] = [];
      const rpc = fakeContext(projectDir, rpcNotifications, "rpc");
      for (const command of runtime.commands.values()) await command("", rpc);
      assert.equal(rpcNotifications.length, runtime.commands.size, "RPC uses normal UI notifications");

      assert.deepEqual(runtime.forbiddenCalls, []);
      assert.deepEqual(await snapshot(projectDir), before, "project/source files remain byte-for-byte unchanged");
      const telemetry = await readFile(join(agentDir, "telemetry.jsonl"), "utf8");
      for (const sentinel of ["PROMPT_SENTINEL", "SYSTEM_SENTINEL", "SOURCE_SENTINEL", "TOOL_OUTPUT_SENTINEL", "CREDENTIAL_SENTINEL", "tenant-a/private-deployment"]) {
        assert.doesNotMatch(telemetry, new RegExp(sentinel));
      }
      assert.match(telemetry, /"recommendedProfile":"pi-reason"/, "pi-code is ineligible under discovered lower capability floor");
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
        "pi-fast": { ...base.profiles["pi-fast"], modelId: "fusion-explore" },
        "pi-code": { ...base.profiles["pi-code"], modelId: "fusion-sidekick" },
        "pi-reason": { ...base.profiles["pi-reason"], modelId: "fusion-plan" },
        "pi-review": { ...base.profiles["pi-review"], modelId: "fusion-reviewer" },
        "pi-research": { ...base.profiles["pi-research"], modelId: "fusion-research" },
        "pi-vision": { ...base.profiles["pi-vision"], modelId: "fusion-vision" },
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
      assert.match(stderr.join(""), /unresolved pi-vision/);
      assert.equal(runtime.providers[0]?.provider.models.some((model: any) => model.id === "fusion-vision"), false);
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
    assert.equal(runtime.providers[0]?.provider.models.length, 6, "explicit profile IDs supply registration fallback");
    const context = fakeContext(tmpdir(), [], "json");
    await emit(runtime.handlers, context, "before_agent_start", { prompt: "implement code", images: [] });
    await runtime.commands.get("fusion-status")?.("", context);
    assert.match(stderr.join(""), /shadow · unavailable/);
    assert.deepEqual(runtime.forbiddenCalls, []);
  });
});
