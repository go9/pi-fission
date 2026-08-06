import type { CanonicalProfile, FusionConfig } from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";
import { resolveApiKey } from "./config.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

export type DiscoveryStatus = "ready" | "auth" | "timeout" | "unavailable" | "malformed" | "empty" | "disabled";

export interface DiscoveryResult {
  status: DiscoveryStatus;
  models: DiscoveredModel[];
  resolvedProfiles: Partial<Record<CanonicalProfile, string>>;
  diagnostic: string;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

function parseModel(value: unknown): DiscoveredModel | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.trim().length === 0) return null;
  const contextWindow = Number.isInteger(item.context_window) && (item.context_window as number) > 0
    ? item.context_window as number
    : undefined;
  const maxTokens = Number.isInteger(item.max_tokens) && (item.max_tokens as number) > 0
    ? item.max_tokens as number
    : undefined;
  return {
    id: item.id,
    name: typeof item.name === "string" && item.name.trim() ? item.name : item.id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

export function resolveProfiles(config: FusionConfig, models: readonly DiscoveredModel[]): Partial<Record<CanonicalProfile, string>> {
  const available = new Set(models.map((model) => model.id));
  const result: Partial<Record<CanonicalProfile, string>> = {};
  const aliases = Object.entries(config.aliases).sort(([left], [right]) => left.localeCompare(right));

  for (const profile of CANONICAL_PROFILES) {
    const explicit = config.profiles[profile].modelId;
    const candidates = [
      explicit,
      profile,
      ...aliases.filter(([, target]) => target === profile).map(([alias]) => alias),
    ];
    const match = [...new Set(candidates)].find((candidate) => available.has(candidate));
    if (match) result[profile] = match;
  }
  return result;
}

export async function discoverModels(
  config: FusionConfig,
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<DiscoveryResult> {
  if (!config.enabled) {
    return { status: "disabled", models: [], resolvedProfiles: {}, diagnostic: "extension is disabled" };
  }

  const apiKey = resolveApiKey(config.provider.apiKey, options.env);
  if (!apiKey) {
    return {
      status: "auth",
      models: [],
      resolvedProfiles: {},
      diagnostic: "API key environment variable is not set",
    };
  }

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(modelsUrl(config.provider.baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.provider.timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: "timeout", models: [], resolvedProfiles: {}, diagnostic: "model discovery timed out" };
    }
    return { status: "unavailable", models: [], resolvedProfiles: {}, diagnostic: "9Router model discovery is unavailable" };
  }

  if (response.status === 401 || response.status === 403) {
    return { status: "auth", models: [], resolvedProfiles: {}, diagnostic: "9Router authentication failed" };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      models: [],
      resolvedProfiles: {},
      diagnostic: `9Router model discovery returned HTTP ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "malformed", models: [], resolvedProfiles: {}, diagnostic: "model catalogue is not valid JSON" };
  }
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
    return { status: "malformed", models: [], resolvedProfiles: {}, diagnostic: "model catalogue must contain a data array" };
  }

  const rawModels = (payload as { data: unknown[] }).data;
  const models = rawModels.map(parseModel);
  if (models.some((model) => model === null)) {
    return { status: "malformed", models: [], resolvedProfiles: {}, diagnostic: "model catalogue contains an invalid model entry" };
  }
  const uniqueModels = [...new Map((models as DiscoveredModel[]).map((model) => [model.id, model])).values()];
  if (uniqueModels.length === 0) {
    return { status: "empty", models: [], resolvedProfiles: {}, diagnostic: "model catalogue is empty" };
  }

  return {
    status: "ready",
    models: uniqueModels,
    resolvedProfiles: resolveProfiles(config, uniqueModels),
    diagnostic: `discovered ${uniqueModels.length} logical model${uniqueModels.length === 1 ? "" : "s"}`,
  };
}
