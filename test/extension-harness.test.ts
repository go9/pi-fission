import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFusionExtension } from "../src/extension.ts";
import { listen, validConfig, writeConfig } from "../test-support/helpers.ts";
import { CANONICAL_PROFILES, type SetupState } from "../src/types.ts";

type Handler = (event: any, context: any) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: any) => Promise<void>;

function completeSetup(config = validConfig()): SetupState {
  return {
    version: 1,
    complete: true,
    lastProbedAt: "2026-01-01T00:00:00.000Z",
    probes: Object.fromEntries(CANONICAL_PROFILES.map((profile) => [profile, {
      profile,
      modelId: config.profiles[profile].modelId,
      ok: true,
      keyless: false,
      probedAt: "2026-01-01T00:00:00.000Z",
    }])),
  };
}

function fakeContext(
  cwd: string,
  notifications: string[],
  model = { id: "original", provider: "existing" },
  models: any[] = [],
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = "high",
): ExtensionContext {
  const widgets = new Map<string, string[]>();
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    model,
    thinkingLevel,
    modelRegistry: { find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id) },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, value: string | undefined) => notifications.push(`status:${key}:${value ?? "cleared"}`),
      setWidget: (key: string, content: string[] | undefined) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
        notifications.push(`widget:${key}:${(content ?? []).join(" | ")}`);
      },
    },
    sessionManager: {},
  } as unknown as ExtensionContext & { ui: { setWidget: (key: string, content?: string[]) => void } };
}

function fakeApi(options: { setModel?: (model: any, index: number) => boolean | Promise<boolean> } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const providers: Array<{ name: string; provider: any }> = [];
  const shortcuts = new Map<string, { description: string; handler: (ctx: any) => void | Promise<void> }>();
  const selectionCalls: any[] = [];
  const thinkingCalls: string[] = [];
  let thinkingLevel = "high";
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) { commands.set(name, command.handler); },
    registerProvider(name: string, provider: any) { providers.push({ name, provider }); },
    registerShortcut(key: string, options: { description: string; handler: (ctx: any) => void | Promise<void> }) { shortcuts.set(key, options); },
    async setModel(model: any) {
      selectionCalls.push(model);
      return options.setModel?.(model, selectionCalls.length - 1) ?? true;
    },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level: string) { thinkingLevel = level; thinkingCalls.push(level); },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, providers, shortcuts, selectionCalls, thinkingCalls, setThinking(level: string) { thinkingLevel = level; } };
}

async function emit(runtime: ReturnType<typeof fakeApi>, context: ExtensionContext, name: string, event: any): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of runtime.handlers.get(name) ?? []) results.push(await handler(event, context));
  return results;
}

async function fixture(mode: "active" | "shadow" = "active") {
  const mock = await listen((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: CANONICAL_PROFILES.map((profile) => ({ id: validConfig().profiles[profile].modelId })) }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
  });
  const base = validConfig();
  const config = validConfig({ mode, provider: { ...base.provider, baseUrl: mock.baseUrl } });
  const saved = await writeConfig(config);
  await writeFile(join(saved.dir, "pi-fusion.setup.json"), JSON.stringify(completeSetup(config)), "utf8");
  return { mock, config, ...saved };
}

describe("router-only Pi Fusion extension", () => {
  it("registers only setup and routing diagnostics", async () => {
    const saved = await fixture("shadow");
    const runtime = fakeApi();
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      assert.deepEqual([...runtime.commands.keys()].sort(), [
        "fusion", "fusion-agents", "fusion-config", "fusion-explain", "fusion-mode", "fusion-routing", "fusion-setup", "fusion-setup-status", "fusion-status",
      ]);
      assert.equal(runtime.handlers.has("tool_call"), false, "Fusion never intercepts tools");
      assert.equal(runtime.handlers.has("tool_result"), false);
      assert.equal(runtime.providers.length, 1);
    } finally {
      await saved.mock.close();
    }
  });

  it("automatically routes a normal prompt and restores the previous model", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      assert.deepEqual(runtime.selectionCalls[0], target);
      await emit(runtime, context, "agent_settled", {});
      assert.deepEqual(runtime.selectionCalls[1], { provider: "existing", id: "original" });
    } finally {
      await saved.mock.close();
    }
  });

  it("does not block the inventory-inspection failure transcript or any tool", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.design.modelId };
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications, { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", {
        prompt: "Inspect the inventory listings and items pages and let's improve the usability",
        images: [],
      });
      assert.equal(runtime.handlers.has("tool_call"), false);
      assert.equal(runtime.commands.has("fusion-plan"), false);
      assert.ok(notifications.some((line) => line.includes("→")), JSON.stringify(notifications));
    } finally {
      await saved.mock.close();
    }
  });

  it("retains the current model when the recommended group is unavailable", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications, { provider: "existing", id: "original" }, []);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 0);
      assert.ok(notifications.some((line) => line.includes("retained current")), JSON.stringify(notifications));
    } finally {
      await saved.mock.close();
    }
  });

  it("respects a manual model selection until automatic mode is re-enabled", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      // First prompt starts the session and routes normally.
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1);
      // A mid-session manual selection pauses automatic routing.
      await emit(runtime, context, "model_select", { model: { provider: "existing", id: "manual" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1, "manual selection must pause routing");
      await runtime.commands.get("fusion-mode")?.("active", context);
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 2, "re-enabling resumes routing");
    } finally {
      await saved.mock.close();
    }
  });

  it("does not treat session-start model selection as a user override", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "opencode-go", id: "deepseek-v4-flash" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      // Session startup selects the default model before any prompt.
      await emit(runtime, context, "model_select", { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.deepEqual(runtime.selectionCalls[0], target, "auto-routing must still switch to the routed group");
    } finally {
      await saved.mock.close();
    }
  });

  it("restores a user thinking-level change made during a routed request", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.reason.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target], "high");
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Plan an architecture migration", images: [] });
      runtime.setThinking("low");
      await emit(runtime, context, "thinking_level_select", { previousLevel: "high", level: "low" });
      await emit(runtime, context, "agent_settled", {});
      assert.equal(runtime.thinkingCalls.at(-1), "low");
    } finally {
      await saved.mock.close();
    }
  });

  it("creates conventional mappings, probes them, and activates from an unconfigured install", async () => {
    const mock = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [
          { id: "fusion-explore" }, { id: "fusion-sidekick" }, { id: "fusion-plan" }, { id: "fusion-reviewer" },
          { id: "fusion-research" }, { id: "fusion-vision" }, { id: "fusion-design" },
        ] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
    });
    const saved = await writeConfig(validConfig());
    await rm(saved.path);
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications);
    try {
      await createFusionExtension(runtime.api, {
        configPath: saved.path,
        env: { NINE_ROUTER_API_KEY: "test" },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          return fetch(`${mock.baseUrl}${url.pathname.replace(/^\/v1/, "")}`, init);
        },
      });
      await runtime.commands.get("fusion-setup")?.("", context);
      const config = JSON.parse(await readFile(saved.path, "utf8"));
      assert.equal(config.mode, "active");
      assert.equal(config.profiles.design.modelId, "fusion-design");
      assert.ok(notifications.some((line) => line.includes("7/7 profiles passed")));
    } finally {
      await mock.close();
    }
  });

  it("records a content-free routing entry with the switch reason", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      const entries = JSON.parse(await readFile(join(saved.dir, "pi-fusion.routing.jsonl"), "utf8"));
      assert.equal(entries.kind, "route");
      assert.equal(entries.profile, "code");
      assert.equal(entries.toModel, saved.config.profiles.code.modelId);
      assert.equal(entries.switched, true);
      assert.equal(entries.reason, "writing code");
      assert.ok(entries.sessionId.length > 0);
      assert.doesNotMatch(JSON.stringify(entries), /Implement a TypeScript helper/);
    } finally {
      await saved.mock.close();
    }
  });

  it("ignores restore-source model events so routing continues", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1);
      // Pi re-applies the restored model after the turn settles; this must not pause routing.
      await emit(runtime, context, "model_select", { model: { provider: "existing", id: "original" }, previousModel: target, source: "restore" });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement another helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 2, "restore-source event must not be treated as a manual override");
    } finally {
      await saved.mock.close();
    }
  });

  it("ignores a late set-source event for the restored model so routing continues", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1);
      // Turn settles; Fusion restores the previous model (second selection).
      await emit(runtime, context, "agent_settled", {});
      assert.equal(runtime.selectionCalls.length, 2);
      // Pi emits a late set-source event for the restored model after the restore finished.
      await emit(runtime, context, "model_select", { model: { provider: "existing", id: "original" }, previousModel: target, source: "set" });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement another helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 3, "late restore set event must not be treated as a manual override");
    } finally {
      await saved.mock.close();
    }
  });

  it("registers a live agents widget and a toggle shortcut", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "session_start", {});
      assert.ok(runtime.shortcuts.has("ctrl+alt+f"), "toggle shortcut registered");
      assert.ok(notifications.some((line) => line.startsWith("widget:pi-fusion-agents:")), JSON.stringify(notifications));
      assert.ok(notifications.some((line) => /0 agents routing/.test(line)));
    } finally {
      await saved.mock.close();
    }
  });

  it("expands the widget to per-agent rows after a routed prompt", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications, { provider: "existing", id: "original" }, [target]);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "session_start", {});
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      await runtime.shortcuts.get("ctrl+alt+f")!.handler(context);
      const expanded = notifications.filter((line) => line.startsWith("widget:pi-fusion-agents:")).at(-1);
      assert.ok(expanded && /fusion workers \(1\)/.test(expanded), JSON.stringify(expanded));
      assert.ok(expanded && /main\s+fusion-sidekick · writing code/.test(expanded), JSON.stringify(expanded));
    } finally {
      await saved.mock.close();
    }
  });

  it("parses mode arguments without exposing workflow state", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications);
    try {
      await createFusionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await runtime.commands.get("fusion-mode")?.("  shadow  ", context);
      assert.ok(notifications.includes("fusion mode: shadow"));
      assert.equal(runtime.commands.has("fusion-workflow"), false);
    } finally {
      await saved.mock.close();
    }
  });
});
