import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FusionConfig } from "../src/types.ts";

export function validConfig(overrides: Partial<FusionConfig> = {}): FusionConfig {
  const config: FusionConfig = {
    version: 1,
    enabled: true,
    provider: { id: "9router", baseUrl: "http://127.0.0.1:1/v1", apiKey: "$TEST_9ROUTER_KEY", timeoutMs: 200 },
    profiles: {
      "pi-fast": { modelId: "pi-fast", capabilities: { tools: true, reasoning: false, image: false, structuredOutput: false, contextWindow: 64_000 } },
      "pi-code": { modelId: "pi-code", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 128_000 } },
      "pi-reason": { modelId: "pi-reason", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 200_000 } },
      "pi-review": { modelId: "pi-review", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 200_000 } },
      "pi-research": { modelId: "pi-research", capabilities: { tools: true, reasoning: true, image: false, structuredOutput: false, contextWindow: 200_000 } },
      "pi-vision": { modelId: "pi-vision", capabilities: { tools: true, reasoning: true, image: true, structuredOutput: false, contextWindow: 128_000 } },
    },
    aliases: { plan: "pi-reason", sidekick: "pi-code", explore: "pi-fast", "small-model": "pi-fast" },
    telemetry: { enabled: true, file: "telemetry.jsonl", maxEntries: 20 },
  };
  return {
    ...config,
    ...overrides,
    provider: { ...config.provider, ...overrides.provider },
    profiles: overrides.profiles ?? config.profiles,
    aliases: overrides.aliases ?? config.aliases,
    telemetry: { ...config.telemetry, ...overrides.telemetry },
  };
}

export async function writeConfig(config: FusionConfig): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-fusion-test-"));
  const path = join(dir, "pi-fusion.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return { dir, path };
}

export async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
