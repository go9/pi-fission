import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFissionExtension } from "../src/extension.ts";
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

/**
 * Stands in for the Pi host. `setModel` mirrors AgentSession.setModel in
 * pi-coding-agent 0.83.0 (dist/core/agent-session.js): it re-clamps the thinking level for
 * the incoming model and emits `thinking_level_select` BEFORE emitting `model_select`, and
 * it suppresses `model_select` entirely when the model is unchanged. Getting that order
 * wrong hides real defects -- a stub that emitted nothing let Pi's own clamp be recorded as
 * the user's thinking preference without any test noticing.
 */
function fakeApi(options: {
  setModel?: (model: any, index: number) => boolean | Promise<boolean>;
  /** Thinking levels each model id supports, mirroring Pi's clamp on switch. */
  thinkingSupport?: Record<string, readonly string[]>;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const providers: Array<{ name: string; provider: any }> = [];
  const shortcuts = new Map<string, { description: string; handler: (ctx: any) => void | Promise<void> }>();
  const selectionCalls: any[] = [];
  const thinkingCalls: string[] = [];
  let thinkingLevel = "high";
  let currentModel: any = null;
  let lastContext: any = null;
  const dispatch = async (name: string, event: any): Promise<void> => {
    for (const handler of handlers.get(name) ?? []) await handler(event, lastContext);
  };
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) { commands.set(name, command.handler); },
    registerProvider(name: string, provider: any) { providers.push({ name, provider }); },
    registerShortcut(key: string, options: { description: string; handler: (ctx: any) => void | Promise<void> }) { shortcuts.set(key, options); },
    async setModel(model: any) {
      selectionCalls.push(model);
      const accepted = await (options.setModel?.(model, selectionCalls.length - 1) ?? true);
      if (!accepted) return false;
      const previousModel = currentModel;
      currentModel = model;
      const supported = options.thinkingSupport?.[model.id];
      if (supported && !supported.includes(thinkingLevel)) {
        const previousLevel = thinkingLevel;
        thinkingLevel = supported[supported.length - 1] ?? "off";
        await dispatch("thinking_level_select", { level: thinkingLevel, previousLevel });
      }
      const unchanged = previousModel && previousModel.provider === model.provider && previousModel.id === model.id;
      if (!unchanged) await dispatch("model_select", { model, previousModel, source: "set" });
      return true;
    },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level: string) { thinkingLevel = level; thinkingCalls.push(level); },
  } as unknown as ExtensionAPI;
  return {
    api, handlers, commands, providers, shortcuts, selectionCalls, thinkingCalls,
    setThinking(level: string) { thinkingLevel = level; },
    useContext(context: any) { lastContext = context; },
  };
}

async function emit(runtime: ReturnType<typeof fakeApi>, context: ExtensionContext, name: string, event: any): Promise<unknown[]> {
  // Host-initiated events carry the context too, so setModel's own emissions reach handlers.
  runtime.useContext(context);
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
  await writeFile(join(saved.dir, "pi-fission.setup.json"), JSON.stringify(completeSetup(config)), "utf8");
  return { mock, config, ...saved };
}

describe("router-only Pi Fission extension", () => {
  it("registers only setup and routing diagnostics", async () => {
    const saved = await fixture("shadow");
    const runtime = fakeApi();
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      assert.deepEqual([...runtime.commands.keys()].sort(), [
        "fission", "fission-agents", "fission-config", "fission-explain", "fission-mode", "fission-routing", "fission-setup", "fission-setup-status", "fission-status",
      ]);
      assert.equal(runtime.handlers.has("tool_call"), false, "Fission never intercepts tools");
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", {
        prompt: "Inspect the inventory listings and items pages and let's improve the usability",
        images: [],
      });
      assert.equal(runtime.handlers.has("tool_call"), false);
      assert.equal(runtime.commands.has("fission-plan"), false);
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      // First prompt starts the session and routes normally.
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1);
      // A mid-session manual selection pauses automatic routing.
      await emit(runtime, context, "model_select", { model: { provider: "existing", id: "manual" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1, "manual selection must pause routing");
      await runtime.commands.get("fission-mode")?.("active", context);
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
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
          { id: "fission-explore" }, { id: "fission-sidekick" }, { id: "fission-plan" }, { id: "fission-reviewer" },
          { id: "fission-research" }, { id: "fission-vision" }, { id: "fission-design" },
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
      await createFissionExtension(runtime.api, {
        configPath: saved.path,
        env: { NINE_ROUTER_API_KEY: "test" },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          return fetch(`${mock.baseUrl}${url.pathname.replace(/^\/v1/, "")}`, init);
        },
      });
      await runtime.commands.get("fission-setup")?.("", context);
      const config = JSON.parse(await readFile(saved.path, "utf8"));
      assert.equal(config.mode, "active");
      assert.equal(config.profiles.design.modelId, "fission-design");
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      const entries = JSON.parse(await readFile(join(saved.dir, "pi-fission.routing.jsonl"), "utf8"));
      assert.equal(entries.kind, "route");
      assert.equal(entries.profile, "code");
      assert.equal(entries.toModel, `9router/${saved.config.profiles.code.modelId}`, "both models are provider-qualified so they compare");
      assert.equal(entries.fromModel, "existing/original");
      assert.equal(entries.switched, true);
      assert.equal(entries.reason, "writing code");
      assert.ok(entries.sessionId.length > 0);
      assert.doesNotMatch(JSON.stringify(entries), /Implement a TypeScript helper/);
    } finally {
      await saved.mock.close();
    }
  });

  it("does not report a switch when the session is already on the routed group", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    // The current model IS the recommended target, so nothing actually moves.
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], target, [target]);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      const entry = JSON.parse(await readFile(join(saved.dir, "pi-fission.routing.jsonl"), "utf8"));
      assert.equal(entry.kind, "route");
      assert.equal(entry.fromModel, entry.toModel);
      assert.equal(entry.switched, false, "no model change occurred");
      assert.equal(runtime.selectionCalls.length, 0, "and no selection was issued");
    } finally {
      await saved.mock.close();
    }
  });

  it("records shadow-mode decisions without switching the model", async () => {
    const saved = await fixture("shadow");
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 0, "shadow mode never switches");
      const entry = JSON.parse(await readFile(join(saved.dir, "pi-fission.routing.jsonl"), "utf8"));
      assert.equal(entry.kind, "shadow");
      assert.equal(entry.switched, false);
      assert.equal(entry.toModel, `9router/${saved.config.profiles.code.modelId}`, "records what it would have picked");
      assert.match(entry.reason, /would route/);
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
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

  it("does not read the host's own switch events as manual overrides", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      // No hand-emitted events here: setModel emits model_select itself, exactly as
      // AgentSession does, for both the route and the restore.
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 1);
      await emit(runtime, context, "agent_settled", {});
      assert.equal(runtime.selectionCalls.length, 2);
      await emit(runtime, context, "before_agent_start", { prompt: "Implement another helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 3, "routing must survive its own echoes");
    } finally {
      await saved.mock.close();
    }
  });

  it("still pauses routing when the user picks a model between turns", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const target = { provider: "9router", id: saved.config.profiles.code.modelId };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target]);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      await emit(runtime, context, "agent_settled", {});
      assert.equal(runtime.selectionCalls.length, 2);
      // The counterpart to the test above: suppressing our own echoes must not suppress a
      // real choice. The previous wall-clock window swallowed exactly this for 3 seconds
      // after every restore, because the user picked the model we had just restored.
      await emit(runtime, context, "model_select", { model: { provider: "existing", id: "original" }, previousModel: target, source: "cycle" });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement another helper", images: [] });
      assert.equal(runtime.selectionCalls.length, 2, "a user selection pauses automatic routing");
    } finally {
      await saved.mock.close();
    }
  });

  it("restores the user's thinking level, not the one Pi clamped for the routed group", async () => {
    const saved = await fixture();
    const codeGroup = saved.config.profiles.code.modelId;
    // AgentSession.setModel re-clamps the thinking level to the incoming model's
    // capabilities and announces it, before it announces the model switch.
    const runtime = fakeApi({ thinkingSupport: { [codeGroup]: ["off", "low"] } });
    const target = { provider: "9router", id: codeGroup };
    const context = fakeContext(tmpdir(), [], { provider: "existing", id: "original" }, [target], "high");
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a helper", images: [] });
      assert.equal(runtime.thinkingCalls.length, 0, "the clamp is the host's, not ours");
      await emit(runtime, context, "agent_settled", {});
      // The clamp to "low" was Pi reacting to our own switch. Restoring it as though the
      // user had asked for it would quietly downgrade their thinking level on every
      // routed turn, and it would stick.
      assert.equal(runtime.thinkingCalls.at(-1), "high", "the level to restore is the user's own");
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "session_start", {});
      assert.ok(runtime.shortcuts.has("ctrl+e"), "toggle shortcut registered");
      assert.ok(notifications.some((line) => line.startsWith("widget:pi-fission-agents:")), JSON.stringify(notifications));
      assert.ok(notifications.some((line) => /0 agents routing/.test(line)));
    } finally {
      await saved.mock.close();
    }
  });

  it("forces a widget re-render on toggle even when the routing log is unchanged", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "session_start", {});
      const before = notifications.filter((line) => line.startsWith("widget:pi-fission-agents:")).length;
      // Toggle collapses and expands; each toggle must re-render the view regardless of log state.
      await runtime.shortcuts.get("ctrl+e")!.handler(context);
      await runtime.shortcuts.get("ctrl+e")!.handler(context);
      const after = notifications.filter((line) => line.startsWith("widget:pi-fission-agents:")).length;
      assert.equal(after, before + 2, "each toggle re-renders the widget");
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
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await emit(runtime, context, "session_start", {});
      await emit(runtime, context, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      await runtime.shortcuts.get("ctrl+e")!.handler(context);
      const expanded = notifications.filter((line) => line.startsWith("widget:pi-fission-agents:")).at(-1);
      assert.ok(expanded && /fission workers \(1\)/.test(expanded), JSON.stringify(expanded));
      assert.ok(expanded && /main · fission-sidekick · writing code/.test(expanded), JSON.stringify(expanded));
    } finally {
      await saved.mock.close();
    }
  });

  it("routes through a project override when the session cwd matches", async () => {
    const mock = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [
          ...CANONICAL_PROFILES.map((profile) => ({ id: validConfig().profiles[profile].modelId })),
          { id: "repo-specific-code" },
        ] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
    const base = validConfig();
    const config = validConfig({
      mode: "active",
      provider: { ...base.provider, baseUrl: mock.baseUrl },
      projectOverrides: [{ repo: "/repo-with-override", profiles: { code: "repo-specific-code" } }],
    });
    const saved = await writeConfig(config);
    await writeFile(join(saved.dir, "pi-fission.setup.json"), JSON.stringify(completeSetup(config)), "utf8");
    const runtime = fakeApi();
    const overridden = { provider: "9router", id: "repo-specific-code" };
    const standard = { provider: "9router", id: config.profiles.code.modelId };
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      const matching = fakeContext("/repo-with-override", [], { provider: "existing", id: "original" }, [overridden, standard]);
      await emit(runtime, matching, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      assert.deepEqual(runtime.selectionCalls.at(-1), overridden, "the override applies in its own repo");
      await emit(runtime, matching, "agent_settled", {});

      const other = fakeContext("/some-other-repo", [], { provider: "existing", id: "original" }, [overridden, standard]);
      await emit(runtime, other, "before_agent_start", { prompt: "Implement a TypeScript helper", images: [] });
      assert.deepEqual(runtime.selectionCalls.at(-1), standard, "and nowhere else");
    } finally {
      await mock.close();
    }
  });

  it("parses mode arguments without exposing workflow state", async () => {
    const saved = await fixture();
    const runtime = fakeApi();
    const notifications: string[] = [];
    const context = fakeContext(tmpdir(), notifications);
    try {
      await createFissionExtension(runtime.api, { configPath: saved.path, env: { TEST_9ROUTER_KEY: "test" } });
      await runtime.commands.get("fission-mode")?.("  shadow  ", context);
      assert.ok(notifications.includes("fission mode: shadow"));
      assert.equal(runtime.commands.has("fission-workflow"), false);
    } finally {
      await saved.mock.close();
    }
  });
});
