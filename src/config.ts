import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  CANONICAL_PROFILES,
  type CanonicalProfile,
  type Capabilities,
  type FusionConfig,
  type ProfileConfig,
} from "./types.ts";

const DEFAULT_ALIASES: Record<string, CanonicalProfile> = {
  plan: "pi-reason",
  sidekick: "pi-code",
  explore: "pi-fast",
  "small-model": "pi-fast",
};

export type ConfigResult =
  | { status: "ready"; path: string; config: FusionConfig; diagnostics: [] }
  | { status: "unconfigured" | "invalid-config"; path: string; config: null; diagnostics: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseConfig(value: unknown): { config: FusionConfig | null; diagnostics: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { config: null, diagnostics: ["config root must be an object"] };

  if (value.version !== 1) errors.push("version must be 1");
  if (typeof value.enabled !== "boolean") errors.push("enabled must be a boolean");

  const provider = value.provider;
  if (!isRecord(provider)) {
    errors.push("provider must be an object");
  } else {
    if (typeof provider.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider.id)) {
      errors.push("provider.id must be a non-empty logical identifier");
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
    if (typeof provider.apiKey !== "string" || !/^\$[A-Z_][A-Z0-9_]*$/i.test(provider.apiKey)) {
      errors.push("provider.apiKey must be an environment-variable reference such as $NINE_ROUTER_API_KEY");
    }
    if (!Number.isInteger(provider.timeoutMs) || (provider.timeoutMs as number) < 50 || (provider.timeoutMs as number) > 30_000) {
      errors.push("provider.timeoutMs must be an integer from 50 to 30000");
    }
  }

  const parsedProfiles = {} as Record<CanonicalProfile, ProfileConfig>;
  if (!isRecord(value.profiles)) {
    errors.push("profiles must be an object");
  } else {
    for (const profile of CANONICAL_PROFILES) {
      const raw = value.profiles[profile];
      if (!isRecord(raw)) {
        errors.push(`profiles.${profile} must be an object`);
        continue;
      }
      if (typeof raw.modelId !== "string" || raw.modelId.trim().length === 0) {
        errors.push(`profiles.${profile}.modelId must be a non-empty string`);
      }
      const capabilities = parseCapabilities(raw.capabilities, `profiles.${profile}.capabilities`, errors);
      if (typeof raw.modelId === "string" && raw.modelId.trim() && capabilities) {
        parsedProfiles[profile] = { modelId: raw.modelId, capabilities };
      }
    }
  }

  const aliases: Record<string, CanonicalProfile> = { ...DEFAULT_ALIASES };
  if (value.aliases !== undefined) {
    if (!isRecord(value.aliases)) {
      errors.push("aliases must be an object");
    } else {
      for (const [alias, target] of Object.entries(value.aliases)) {
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

  const telemetry = value.telemetry;
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

  if (errors.length > 0 || !isRecord(provider) || !isRecord(telemetry)) {
    return { config: null, diagnostics: [...new Set(errors)] };
  }

  return {
    config: {
      version: 1,
      enabled: value.enabled as boolean,
      provider: {
        id: provider.id as string,
        baseUrl: (provider.baseUrl as string).replace(/\/$/, ""),
        apiKey: provider.apiKey as string,
        timeoutMs: provider.timeoutMs as number,
      },
      profiles: parsedProfiles,
      aliases,
      telemetry: {
        enabled: telemetry.enabled as boolean,
        file: telemetry.file as string,
        maxEntries: telemetry.maxEntries as number,
      },
    },
    diagnostics: [],
  };
}

export function defaultConfigPath(): string {
  return join(getAgentDir(), "extensions", "pi-fusion.json");
}

export function telemetryPath(configPath: string, config: FusionConfig): string {
  return join(dirname(configPath), config.telemetry.file);
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

export function resolveApiKey(reference: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return env[reference.slice(1)]?.trim() || null;
}
