import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FissionConfig } from "../src/types.ts";
import { DEFAULT_PROFILE_CAPABILITIES } from "../src/config.ts";

export function validConfig(overrides: Partial<FissionConfig> = {}): FissionConfig {
  const config: FissionConfig = {
    version: 2,
    mode: "shadow",
    provider: { id: "9router", baseUrl: "http://127.0.0.1:1/v1", apiKey: "$TEST_9ROUTER_KEY", timeoutMs: 200 },
    profiles: {
      fast: { modelId: "fission-explore", capabilities: DEFAULT_PROFILE_CAPABILITIES.fast },
      code: { modelId: "fission-sidekick", capabilities: DEFAULT_PROFILE_CAPABILITIES.code },
      reason: { modelId: "fission-plan", capabilities: DEFAULT_PROFILE_CAPABILITIES.reason },
      review: { modelId: "fission-reviewer", capabilities: DEFAULT_PROFILE_CAPABILITIES.review },
      research: { modelId: "fission-research", capabilities: DEFAULT_PROFILE_CAPABILITIES.research },
      vision: { modelId: "fission-vision", capabilities: DEFAULT_PROFILE_CAPABILITIES.vision },
      design: { modelId: "fission-design", capabilities: DEFAULT_PROFILE_CAPABILITIES.design },
    },
    aliases: { plan: "reason", sidekick: "code", explore: "fast", "small-model": "fast", reviewer: "review", research: "research", vision: "vision", design: "design" },
    projectOverrides: [],
    telemetry: { enabled: true, file: "telemetry.jsonl", maxEntries: 20 },
    tuning: { enabled: true, file: "tuning.jsonl", maxEntries: 200, minEvidence: 5, maxFanout: 4, maxDepth: 2, maxRetries: 3, maxSwitches: 4 },
  };
  return {
    ...config,
    ...overrides,
    provider: { ...config.provider, ...overrides.provider },
    profiles: overrides.profiles ?? config.profiles,
    aliases: overrides.aliases ?? config.aliases,
    projectOverrides: overrides.projectOverrides ?? config.projectOverrides,
    telemetry: { ...config.telemetry, ...overrides.telemetry },
    tuning: { ...config.tuning, ...overrides.tuning },
  };
}

export async function writeConfig(config: FissionConfig): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-fission-test-"));
  const path = join(dir, "pi-fission.json");
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
