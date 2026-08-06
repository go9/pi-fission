import type { CanonicalProfile, Capabilities, FusionConfig } from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";
import { resolveApiKey } from "./config.ts";

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities: Partial<Omit<Capabilities, "contextWindow">>;
}

export type DiscoveryStatus = "ready" | "auth" | "timeout" | "unavailable" | "malformed" | "empty" | "disabled";

export interface DiscoveryResult {
  status: DiscoveryStatus;
  models: DiscoveredModel[];
  resolvedProfiles: Partial<Record<CanonicalProfile, string>>;
  effectiveCapabilities: Partial<Record<CanonicalProfile, Capabilities>>;
  unresolvedProfiles: CanonicalProfile[];
  diagnostic: string;
}

function emptyResult(status: Exclude<DiscoveryStatus, "ready">, diagnostic: string): DiscoveryResult {
  return {
    status,
    models: [],
    resolvedProfiles: {},
    effectiveCapabilities: {},
    unresolvedProfiles: [...CANONICAL_PROFILES],
    diagnostic,
  };
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models`;
}

function explicitBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value.map((entry) => entry.toLowerCase())
    : undefined;
}

function parseModel(value: unknown): DiscoveredModel | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.trim().length === 0) return null;
  const capabilityObject = typeof item.capabilities === "object" && item.capabilities !== null && !Array.isArray(item.capabilities)
    ? item.capabilities as Record<string, unknown>
    : {};
  const modalityObject = typeof item.modalities === "object" && item.modalities !== null && !Array.isArray(item.modalities)
    ? item.modalities as Record<string, unknown>
    : {};
  const declaredInputs = stringArray(item.input) ?? stringArray(modalityObject.input);
  const contextWindow = Number.isInteger(item.context_window) && (item.context_window as number) > 0
    ? item.context_window as number
    : undefined;
  const maxTokens = Number.isInteger(item.max_tokens) && (item.max_tokens as number) > 0
    ? item.max_tokens as number
    : undefined;
  const tools = explicitBoolean(item.tools, item.supports_tools, capabilityObject.tools);
  const reasoning = explicitBoolean(item.reasoning, item.supports_reasoning, capabilityObject.reasoning);
  const structuredOutput = explicitBoolean(
    item.structured_output,
    item.supports_structured_output,
    capabilityObject.structuredOutput,
    capabilityObject.structured_output,
  );
  const image = declaredInputs ? declaredInputs.includes("image") : explicitBoolean(item.image, capabilityObject.image);
  return {
    id: item.id,
    name: typeof item.name === "string" && item.name.trim() ? item.name : item.id,
    capabilities: {
      ...(tools !== undefined ? { tools } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    },
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

export function constrainCapabilities(configured: Capabilities, discovered: DiscoveredModel): Capabilities {
  return {
    tools: discovered.capabilities.tools === undefined ? configured.tools : configured.tools && discovered.capabilities.tools,
    reasoning: discovered.capabilities.reasoning === undefined
      ? configured.reasoning
      : configured.reasoning && discovered.capabilities.reasoning,
    image: discovered.capabilities.image === undefined ? configured.image : configured.image && discovered.capabilities.image,
    structuredOutput: discovered.capabilities.structuredOutput === undefined
      ? configured.structuredOutput
      : configured.structuredOutput && discovered.capabilities.structuredOutput,
    contextWindow: discovered.contextWindow === undefined
      ? configured.contextWindow
      : Math.min(configured.contextWindow, discovered.contextWindow),
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

function effectiveCapabilities(
  config: FusionConfig,
  models: readonly DiscoveredModel[],
  resolvedProfiles: Partial<Record<CanonicalProfile, string>>,
): Partial<Record<CanonicalProfile, Capabilities>> {
  const byId = new Map(models.map((model) => [model.id, model]));
  const result: Partial<Record<CanonicalProfile, Capabilities>> = {};
  for (const profile of CANONICAL_PROFILES) {
    const modelId = resolvedProfiles[profile];
    const model = modelId ? byId.get(modelId) : undefined;
    if (model) result[profile] = constrainCapabilities(config.profiles[profile].capabilities, model);
  }
  return result;
}

export async function discoverModels(
  config: FusionConfig,
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<DiscoveryResult> {
  if (!config.enabled) return emptyResult("disabled", "extension is disabled");

  const apiKey = resolveApiKey(config.provider.apiKey, options.env);
  if (!apiKey) return emptyResult("auth", "API key environment variable is not set");

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(modelsUrl(config.provider.baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.provider.timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") return emptyResult("timeout", "model discovery timed out");
    return emptyResult("unavailable", "9Router model discovery is unavailable");
  }

  if (response.status === 401 || response.status === 403) return emptyResult("auth", "9Router authentication failed");
  if (!response.ok) return emptyResult("unavailable", `9Router model discovery returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return emptyResult("malformed", "model catalogue is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
    return emptyResult("malformed", "model catalogue must contain a data array");
  }

  const rawModels = (payload as { data: unknown[] }).data;
  const models = rawModels.map(parseModel);
  if (models.some((model) => model === null)) return emptyResult("malformed", "model catalogue contains an invalid model entry");
  const uniqueModels = [...new Map((models as DiscoveredModel[]).map((model) => [model.id, model])).values()];
  if (uniqueModels.length === 0) return emptyResult("empty", "model catalogue is empty");

  const resolvedProfiles = resolveProfiles(config, uniqueModels);
  const unresolvedProfiles = CANONICAL_PROFILES.filter((profile) => !resolvedProfiles[profile]);
  return {
    status: "ready",
    models: uniqueModels,
    resolvedProfiles,
    effectiveCapabilities: effectiveCapabilities(config, uniqueModels, resolvedProfiles),
    unresolvedProfiles,
    diagnostic: `discovered ${uniqueModels.length} logical model${uniqueModels.length === 1 ? "" : "s"}; ${unresolvedProfiles.length} unresolved profile${unresolvedProfiles.length === 1 ? "" : "s"}`,
  };
}
