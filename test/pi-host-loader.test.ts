import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { validConfig } from "../test-support/helpers.ts";

interface RpcMessage {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  method?: string;
  message?: string;
  data?: { commands?: Array<{ name?: string; source?: string }> };
}

describe("Pi host loader", () => {
  it("loads the explicit extension in Pi 0.83 and runs a diagnostic command without an agent turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-fusion-host-loader-"));
    const configPath = join(directory, "pi-fusion.json");
    const base = validConfig();
    await writeFile(configPath, JSON.stringify(validConfig({
      enabled: false,
      provider: { ...base.provider, baseUrl: "http://127.0.0.1:1/v1", apiKey: undefined },
      telemetry: { ...base.telemetry, enabled: false },
    })), "utf8");

    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const pi = join(packageRoot, "node_modules", ".bin", "pi");
    const extension = join(packageRoot, "extensions", "pi-fusion.ts");
    const child = spawn(pi, [
      "--mode", "rpc",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--extension", extension,
    ], {
      cwd: directory,
      env: { ...process.env, PI_FUSION_CONFIG_PATH: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let sawAgentTurn = false;
    let sawDiagnostic = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Pi host-loader smoke timed out; stderr=${stderr}`)), 15_000);
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const send = (message: RpcMessage): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };

        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => { finish(error); });
        child.on("exit", (code, signal) => {
          if (!sawDiagnostic) finish(new Error(`Pi exited before diagnostic completed (${code ?? signal}); stderr=${stderr}`));
        });
        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
          while (true) {
            const newline = stdoutBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line.trim()) continue;

            let message: RpcMessage;
            try {
              message = JSON.parse(line) as RpcMessage;
            } catch {
              finish(new Error(`Pi emitted non-JSON RPC output: ${line}`));
              return;
            }

            if (message.type === "extension_error") {
              finish(new Error(`Pi extension error: ${JSON.stringify(message)}`));
              return;
            }
            if (message.type === "agent_start" || message.type === "message_start") sawAgentTurn = true;

            if (message.type === "response" && message.id === "commands") {
              if (!message.success) {
                finish(new Error(`get_commands failed: ${message.error ?? "unknown error"}`));
                return;
              }
              const command = message.data?.commands?.find((entry) => entry.name === "fusion-config");
              if (command?.source !== "extension") {
                finish(new Error("fusion-config was not loaded from the explicit extension"));
                return;
              }
              send({ id: "diagnostic", type: "prompt", message: "/fusion-config" });
            } else if (message.type === "extension_ui_request" && message.method === "notify") {
              if (message.message?.includes("fusion config: shadow")) sawDiagnostic = true;
            } else if (message.type === "response" && message.id === "diagnostic") {
              if (!message.success) {
                finish(new Error(`fusion-config failed: ${message.error ?? "unknown error"}`));
                return;
              }
              if (!sawDiagnostic) {
                finish(new Error("fusion-config completed without its diagnostic notification"));
                return;
              }
              finish();
            }
          }
        });

        send({ id: "commands", type: "get_commands" });
      });

      assert.equal(sawAgentTurn, false, "diagnostic command must not start a model completion");
      assert.equal(sawDiagnostic, true);
      assert.doesNotMatch(stderr, /Failed to load extension|ERR_MODULE_NOT_FOUND|extension error/i);
    } finally {
      child.kill("SIGTERM");
      child.stdin.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
