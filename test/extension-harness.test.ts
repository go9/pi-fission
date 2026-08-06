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

function fakeContext(cwd: string, notifications: string[], mode: "tui" | "print" = "tui"): ExtensionContext {
  const failPrompt = (): never => { throw new Error("shadow extension attempted to prompt"); };
  return {
    mode,
    hasUI: mode === "tui",
    cwd,
    model: { id: "actually-active", provider: "existing" },
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

describe("Pi observer extension shadow mode", () => {
  it("extension harness proves observation makes zero selection, delegation, or project mutation calls", async () => {
    const mock = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "pi-fast" }, { id: "pi-code" }, { id: "pi-reason" }, { id: "pi-review" }, { id: "pi-research" }, { id: "pi-vision" },
      ] }));
    });
    const config = validConfig({ provider: { ...validConfig().provider, baseUrl: mock.baseUrl } });
    const { dir: agentDir, path: configPath } = await writeConfig(config);
    const projectDir = await mkdtemp(join(tmpdir(), "pi-fusion-project-"));
    await writeFile(join(projectDir, "source.ts"), "const untouched = 'SOURCE_SENTINEL';\n", "utf8");
    const before = await snapshot(projectDir);

    const handlers = new Map<string, Handler[]>();
    const commands = new Map<string, CommandHandler>();
    const providers: unknown[] = [];
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

    try {
      await createFusionExtension(api, { configPath, env: { TEST_9ROUTER_KEY: "CREDENTIAL_SENTINEL" } });
      assert.equal(providers.length, 1, "provider registered during async initialization");
      assert.deepEqual([...commands.keys()].sort(), ["fusion-config", "fusion-explain", "fusion-history", "fusion-status"]);
      for (const event of ["before_agent_start", "tool_result", "turn_end", "model_select", "after_provider_response", "session_start", "session_shutdown"]) {
        assert.ok(handlers.has(event), `registered ${event}`);
      }

      const notifications: string[] = [];
      const context = fakeContext(projectDir, notifications);
      const emit = async (name: string, event: any): Promise<void> => {
        for (const handler of handlers.get(name) ?? []) {
          const returned = await handler(event, context);
          assert.equal(returned, undefined, `${name} does not modify execution`);
        }
      };
      await emit("session_start", { reason: "startup" });
      await emit("before_agent_start", { prompt: "Implement code PROMPT_SENTINEL", images: [], systemPrompt: "SYSTEM_SENTINEL" });
      await emit("tool_result", {
        toolName: "read",
        toolCallId: "1",
        input: { path: "SOURCE_SENTINEL" },
        content: [{ type: "text", text: "TOOL_OUTPUT_SENTINEL" }],
        details: { credential: "CREDENTIAL_SENTINEL" },
        isError: false,
        usage: { inputTokens: 3 },
      });
      await emit("after_provider_response", { status: 200, headers: {} });
      await emit("turn_end", { turnIndex: 0, message: { usage: { input: 5, output: 2 } }, toolResults: [] });
      await emit("model_select", { model: { id: "user-selected-model", provider: "existing" }, source: "set" });

      for (const command of commands.values()) await command("", context);
      assert.ok(notifications.some((line) => line.includes("shadow")));
      assert.ok(notifications.some((line) => line.includes("active Pi model")));

      const nonTui = fakeContext(projectDir, [], "print");
      for (const command of commands.values()) await command("", nonTui);

      assert.deepEqual(forbiddenCalls, []);
      assert.deepEqual(await snapshot(projectDir), before, "project/source files remain byte-for-byte unchanged");
      const telemetry = await readFile(join(agentDir, "telemetry.jsonl"), "utf8");
      for (const sentinel of ["PROMPT_SENTINEL", "SYSTEM_SENTINEL", "SOURCE_SENTINEL", "TOOL_OUTPUT_SENTINEL", "CREDENTIAL_SENTINEL"]) {
        assert.doesNotMatch(telemetry, new RegExp(sentinel));
      }
      assert.match(telemetry, /"recommendedProfile":"pi-code"/);
      assert.match(telemetry, /"activeModel":"actually-active"/);
    } finally {
      await mock.close();
    }
  });
});
