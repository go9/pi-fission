import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  CANONICAL_PROFILES,
  type CanonicalProfile,
  type Capabilities,
  type FissionConfig,
  type Mode,
  type ProfileConfig,
  type ProjectOverride,
} from "./types.ts";

const DEFAULT_ALIASES: Record<string, CanonicalProfile> = {
  plan: "reason",
  sidekick: "code",
  explore: "fast",
  "small-model": "fast",
  reviewer: "review",
  research: "research",
  vision: "vision",
  design: "design",
};

/** Migration from 0.1 canonical ids (pi-*) to the full-product ids. */
const LEGACY_ID_MAP: Record<string, CanonicalProfile> = {
  "pi-fast": "fast",
  "pi-code": "code",
  "pi-reason": "reason",
  "pi-review": "review",
  "pi-research": "research",
  "pi-vision": "vision",
};

export const DEFAULT_PROFILE_MODELS: Record<CanonicalProfile, string> = {
  fast: "fission-explore",
  code: "fission-sidekick",
  reason: "fission-plan",
  review: "fission-reviewer",
  research: "fission-research",
  vision: "fission-vision",
  design: "fission-design",
};

export const DEFAULT_PROFILE_CAPABILITIES: Record<CanonicalProfile, Capabilities> = {
  fast: { tools: true, reasoning: false, image: false, structuredOutput: false, contextWindow: 32_000 },
  code: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 64_000 },
  reason: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 128_000 },
  review: { tools: true, reasoning: true, image: false, structuredOutput: true, contextWindow: 128_000 },
  research: { tools: true, reasoning: true, image: false, structuredOutput: false, contextWindow: 128_000 },
  vision: { tools: true, reasoning: true, image: true, structuredOutput: false, contextWindow: 64_000 },
  design: { tools: true, reasoning: true, image: true, structuredOutput: false, contextWindow: 128_000 },
};

export type ConfigResult =
  | { status: "ready"; path: string; config: FissionConfig; diagnostics: [] }
  | { status: "unconfigured" | "invalid-config"; path: string; config: null; diagnostics: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackBaseUrl(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return isLoopbackUrl(value);
}

function isProfile(value: string): value is CanonicalProfile {
  return (CANONICAL_PROFILES as readonly string[]).includes(value);
}

function parseCapabilities(value: unknown, path: string, errors: string[]): Capabilities | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const booleanKeys = ["tools", "reasoning", "image", "structuredOutput"] as const;
  for (const key of booleanKeys) {
    if (typeof value[key] !== "boolean") errors.push(`${path}.${key} must be a boolean`);
  }
  if (!Number.isInteger(value.contextWindow) || (value.contextWindow as number) < 1) {
    errors.push(`${path}.contextWindow must be a positive integer`);
  }
  if (errors.some((error) => error.startsWith(`${path}.`) || error === `${path} must be an object`)) return null;
  return {
    tools: value.tools as boolean,
    reasoning: value.reasoning as boolean,
    image: value.image as boolean,
    structuredOutput: value.structuredOutput as boolean,
    contextWindow: value.contextWindow as number,
  };
}

/** Migrate a 0.1 config (six pi-* profiles, no mode) into the v2 shape. */
export function migrateLegacyConfig(value: Record<string, unknown>): Record<string, unknown> {
  const profiles = isRecord(value.profiles) ? value.profiles : {};
  const migratedProfiles: Record<string, unknown> = {};
  for (const [legacyId, raw] of Object.entries(profiles)) {
    const canonical = LEGACY_ID_MAP[legacyId] ?? legacyId;
    migratedProfiles[canonical] = raw;
  }
  // v2 requires seven profiles; fill design with a conservative default target.
  if (!isRecord(migratedProfiles.design)) {
    const reasonRaw = isRecord(value.profiles) && isRecord(value.profiles["pi-reason"])
      ? (value.profiles["pi-reason"] as Record<string, unknown>).modelId
      : isRecord(migratedProfiles.reason)
        ? (migratedProfiles.reason as Record<string, unknown>).modelId
        : "";
    migratedProfiles.design = {
      modelId: typeof reasonRaw === "string" ? reasonRaw : "",
      capabilities: DEFAULT_PROFILE_CAPABILITIES.design,
    };
  }
  // Migrate alias targets that still point at legacy pi-* ids.
  const aliases: Record<string, unknown> = {};
  if (isRecord(value.aliases)) {
    for (const [alias, target] of Object.entries(value.aliases)) {
      aliases[alias] = typeof target === "string" ? (LEGACY_ID_MAP[target] ?? target) : target;
    }
  }
  return {
    ...value,
    version: 2,
    mode: typeof value.mode === "string" ? value.mode : "shadow",
    profiles: migratedProfiles,
    aliases,
    tuning: isRecord(value.tuning) ? value.tuning : {
      enabled: true,
      file: "tuning.jsonl",
      maxEntries: 200,
      minEvidence: 5,
      maxFanout: 4,
      maxDepth: 2,
      maxRetries: 3,
      maxSwitches: 4,
    },
  };
}

export function parseConfig(value: unknown): { config: FissionConfig | null; diagnostics: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { config: null, diagnostics: ["config root must be an object"] };

  const raw = value.version === 1 ? migrateLegacyConfig(value) : value;
  if (!isRecord(raw)) return { config: null, diagnostics: ["config root must be an object"] };

  if (raw.version !== 2) errors.push("version must be 1 or 2");
  if (typeof raw.mode !== "string" || !["off", "shadow", "active"].includes(raw.mode)) {
    errors.push("mode must be off, shadow, or active");
  }

  const provider = raw.provider;
  if (!isRecord(provider)) {
    errors.push("provider must be an object");
  } else {
    if (typeof provider.id !== "string" || !/^9router(?:[._-][a-z0-9][a-z0-9._-]*)?$/i.test(provider.id)) {
      errors.push("provider.id must be 9router or a 9router-prefixed identifier such as 9router-local");
    }
    if (typeof provider.baseUrl !== "string") {
      errors.push("provider.baseUrl must be an http(s) URL");
    } else {
      try {
        const url = new URL(provider.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      } catch {
        errors.push("provider.baseUrl must be an http(s) URL");
      }
    }
    if (provider.apiKey !== undefined && (typeof provider.apiKey !== "string" || !/^\$[A-Z_][A-Z0-9_]*$/i.test(provider.apiKey))) {
      errors.push("provider.apiKey must be an environment-variable reference such as $NINE_ROUTER_API_KEY");
    } else if (provider.apiKey === undefined && !isLoopbackBaseUrl(provider.baseUrl as string | undefined)) {
      errors.push("provider.apiKey is required for non-loopback endpoints");
    }
    if (!Number.isInteger(provider.timeoutMs) || (provider.timeoutMs as number) < 50 || (provider.timeoutMs as number) > 30_000) {
      errors.push("provider.timeoutMs must be an integer from 50 to 30000");
    }
  }

  const parsedProfiles = {} as Record<CanonicalProfile, ProfileConfig>;
  if (!isRecord(raw.profiles)) {
    errors.push("profiles must be an object");
  } else {
    for (const profile of CANONICAL_PROFILES) {
      const rawProfile = raw.profiles[profile];
      if (!isRecord(rawProfile)) {
        errors.push(`profiles.${profile} must be an object`);
        continue;
      }
      if (typeof rawProfile.modelId !== "string" || rawProfile.modelId.trim().length === 0) {
        errors.push(`profiles.${profile}.modelId must be a non-empty string`);
      }
      const capabilities = parseCapabilities(rawProfile.capabilities, `profiles.${profile}.capabilities`, errors);
      if (typeof rawProfile.modelId === "string" && rawProfile.modelId.trim() && capabilities) {
        parsedProfiles[profile] = { modelId: rawProfile.modelId, capabilities };
      }
    }
  }

  const aliases: Record<string, CanonicalProfile> = { ...DEFAULT_ALIASES };
  if (raw.aliases !== undefined) {
    if (!isRecord(raw.aliases)) {
      errors.push("aliases must be an object");
    } else {
      for (const [alias, target] of Object.entries(raw.aliases)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) {
          errors.push("alias names must be logical identifiers");
        } else if (typeof target !== "string" || !isProfile(target)) {
          errors.push(`aliases.${alias} must name a canonical profile`);
        } else {
          aliases[alias] = target;
        }
      }
    }
  }

  const projectOverrides: ProjectOverride[] = [];
  if (raw.projectOverrides !== undefined) {
    if (!Array.isArray(raw.projectOverrides)) {
      errors.push("projectOverrides must be an array");
    } else {
      for (const [index, entry] of raw.projectOverrides.entries()) {
        if (!isRecord(entry) || typeof entry.repo !== "string" || !isRecord(entry.profiles)) {
          errors.push(`projectOverrides[${index}] must be { repo, profiles }`);
          continue;
        }
        const overrides: Partial<Record<CanonicalProfile, string>> = {};
        for (const [profile, modelId] of Object.entries(entry.profiles)) {
          if (!isProfile(profile)) {
            errors.push(`projectOverrides[${index}].${profile} is not a canonical profile`);
          } else if (typeof modelId !== "string" || modelId.trim().length === 0) {
            errors.push(`projectOverrides[${index}].${profile}.modelId must be a non-empty string`);
          } else {
            overrides[profile] = modelId;
          }
        }
        projectOverrides.push({ repo: entry.repo, profiles: overrides });
      }
    }
  }

  const telemetry = raw.telemetry;
  if (!isRecord(telemetry)) {
    errors.push("telemetry must be an object");
  } else {
    if (typeof telemetry.enabled !== "boolean") errors.push("telemetry.enabled must be a boolean");
    if (typeof telemetry.file !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(telemetry.file)) {
      errors.push("telemetry.file must be a filename inside the extension config directory");
    }
    if (!Number.isInteger(telemetry.maxEntries) || (telemetry.maxEntries as number) < 1 || (telemetry.maxEntries as number) > 10_000) {
      errors.push("telemetry.maxEntries must be an integer from 1 to 10000");
    }
  }

  const tuning = raw.tuning ?? {};
  if (!isRecord(tuning)) {
    errors.push("tuning must be an object");
  } else {
    if (typeof tuning.enabled !== "boolean") errors.push("tuning.enabled must be a boolean");
    if (typeof tuning.file !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(tuning.file)) {
      errors.push("tuning.file must be a filename inside the extension config directory");
    }
    for (const key of ["maxEntries", "minEvidence", "maxFanout", "maxDepth", "maxRetries", "maxSwitches"] as const) {
      if (!Number.isInteger(tuning[key]) || (tuning[key] as number) < 1) {
        errors.push(`tuning.${key} must be a positive integer`);
      }
    }
  }

  if (errors.length > 0 || !isRecord(provider) || !isRecord(telemetry) || !isRecord(tuning)) {
    return { config: null, diagnostics: [...new Set(errors)] };
  }

  return {
    config: {
      version: 2,
      mode: raw.mode as Mode,
      provider: {
        id: provider.id as string,
        baseUrl: (provider.baseUrl as string).replace(/\/$/, ""),
        apiKey: provider.apiKey as string | undefined,
        timeoutMs: provider.timeoutMs as number,
      },
      profiles: parsedProfiles,
      aliases,
      projectOverrides,
      telemetry: {
        enabled: telemetry.enabled as boolean,
        file: telemetry.file as string,
        maxEntries: telemetry.maxEntries as number,
      },
      tuning: {
        enabled: tuning.enabled as boolean,
        file: tuning.file as string,
        maxEntries: tuning.maxEntries as number,
        minEvidence: tuning.minEvidence as number,
        maxFanout: tuning.maxFanout as number,
        maxDepth: tuning.maxDepth as number,
        maxRetries: tuning.maxRetries as number,
        maxSwitches: tuning.maxSwitches as number,
      },
    },
    diagnostics: [],
  };
}

export function createDefaultConfig(overrides: Partial<Record<CanonicalProfile, string>> = {}): FissionConfig {
  const profiles = Object.fromEntries(CANONICAL_PROFILES.map((profile) => [profile, {
    modelId: overrides[profile] ?? DEFAULT_PROFILE_MODELS[profile],
    capabilities: DEFAULT_PROFILE_CAPABILITIES[profile],
  }])) as FissionConfig["profiles"];
  return {
    version: 2,
    mode: "shadow",
    provider: {
      id: "9router",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "$NINE_ROUTER_API_KEY",
      timeoutMs: 15_000,
    },
    profiles,
    aliases: { ...DEFAULT_ALIASES },
    projectOverrides: [],
    telemetry: { enabled: false, file: "pi-fission.telemetry.jsonl", maxEntries: 200 },
    tuning: {
      enabled: false,
      file: "pi-fission.tuning.jsonl",
      maxEntries: 200,
      minEvidence: 5,
      maxFanout: 4,
      maxDepth: 2,
      maxRetries: 3,
      maxSwitches: 4,
    },
  };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_FISSION_CONFIG_PATH?.trim();
  return override || join(getAgentDir(), "extensions", "pi-fission.json");
}

export function defaultSetupStatePath(configPath: string): string {
  return join(dirname(configPath), "pi-fission.setup.json");
}

export function defaultTuningPath(configPath: string): string {
  return join(dirname(configPath), "pi-fission.tuning.jsonl");
}

export function telemetryPath(configPath: string, config: FissionConfig): string {
  return join(dirname(configPath), config.telemetry.file);
}

/** Effective profile target for a repository, applying project overrides.
 *  Only an override whose repo matches the given path applies; otherwise the
 *  global target is returned. */
export function effectiveProfileTarget(config: FissionConfig, profile: CanonicalProfile, repo?: string): string {
  if (repo) {
    for (const override of config.projectOverrides) {
      if (override.repo !== repo) continue;
      const target = override.profiles[profile];
      if (target) return target;
    }
  }
  return config.profiles[profile].modelId;
}

export async function loadConfig(path = defaultConfigPath()): Promise<ConfigResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "unconfigured", path, config: null, diagnostics: ["configuration file not found"] };
    }
    return { status: "invalid-config", path, config: null, diagnostics: ["configuration file could not be read"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "invalid-config", path, config: null, diagnostics: ["configuration file is not valid JSON"] };
  }
  const parsed = parseConfig(raw);
  if (!parsed.config) return { status: "invalid-config", path, config: null, diagnostics: parsed.diagnostics };
  return { status: "ready", path, config: parsed.config, diagnostics: [] };
}

export async function saveConfig(path: string, config: FissionConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveApiKey(reference: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!reference) return null;
  return env[reference.slice(1)]?.trim() || null;
}

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
