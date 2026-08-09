import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalProfile, FissionConfig, ProbeResult, SetupState } from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";
import { DEFAULT_PROFILE_CAPABILITIES, defaultSetupStatePath, isLoopbackUrl, resolveApiKey } from "./config.ts";

export type { ProbeResult, SetupState };

export interface DiscoveredModel {
  id: string;
  name: string;
  capabilities: Partial<Record<CapabilityKey, boolean>>;
}

type CapabilityKey = "tools" | "reasoning" | "image" | "structuredOutput";

export interface SetupDiagnostic {
  profile: CanonicalProfile;
  target: string;
  ok: boolean;
  issues: string[];
}

export interface SetupProbeOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Inject a clock for tests. */
  now?: () => Date;
  /** Cap how long one probe may wait, in milliseconds. */
  probeTimeoutMs?: number;
}

/** A probe is a minimal real inference call: "Reply exactly with OK". */
const PROBE_PROMPT = "Reply exactly with OK";

function modelExists(models: readonly { id: string }[], modelId: string): boolean {
  return models.some((model) => model.id === modelId);
}

/** Validate that every profile target resolves and meets its capability floor. */
export function diagnoseSetup(config: FissionConfig, models: readonly { id: string; capabilities?: unknown }[]): SetupDiagnostic[] {
  return CANONICAL_PROFILES.map((profile) => {
    const target = config.profiles[profile].modelId;
    const issues: string[] = [];
    if (!target.trim()) {
      issues.push("no target model configured");
      return { profile, target, ok: false, issues };
    }
    if (!modelExists(models, target)) {
      issues.push("target not in discovered catalogue");
      return { profile, target, ok: false, issues };
    }
    const required = DEFAULT_PROFILE_CAPABILITIES[profile];
    const declared = config.profiles[profile].capabilities;
    // Every configured capability must satisfy the profile's floor.
    for (const key of ["tools", "reasoning", "image", "structuredOutput"] as const) {
      if (required[key] && !declared[key]) issues.push(`capability.${key} below floor`);
    }
    if (declared.contextWindow < required.contextWindow) {
      issues.push(`context-window ${declared.contextWindow} below floor ${required.contextWindow}`);
    }
    return { profile, target, ok: issues.length === 0, issues };
  });
}

function parseProbePayload(value: unknown): { text?: string; error?: string } {
  if (typeof value !== "object" || value === null) return {};
  const payload = value as Record<string, unknown>;
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    return { text: content };
  }
  if (isRecord(payload.error)) {
    const error = payload.error as Record<string, unknown>;
    return { error: typeof error.message === "string" ? error.message : "probe returned an error" };
  }
  return { error: "unexpected probe response shape" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Run one real minimal inference probe against a profile target. */
export async function runProbe(
  config: FissionConfig,
  profile: CanonicalProfile,
  target: string,
  options: SetupProbeOptions = {},
): Promise<ProbeResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();
  const timeoutMs = options.probeTimeoutMs ?? 15_000;
  const baseUrl = config.provider.baseUrl.replace(/\/$/, "");
  const loopback = isLoopbackUrl(baseUrl);
  const apiKey = resolveApiKey(config.provider.apiKey, options.env);
  if (apiKey === null && !loopback) {
    return {
      profile,
      modelId: target,
      ok: false,
      error: "remote endpoint requires an API-key environment reference",
      keyless: false,
      probedAt: now().toISOString(),
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    return {
      profile,
      modelId: target,
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "probe timed out" : "probe request failed",
      keyless: loopback && apiKey === null,
      probedAt: now().toISOString(),
    };
  }

  if (!response.ok) {
    return {
      profile,
      modelId: target,
      ok: false,
      error: `probe returned HTTP ${response.status}`,
      keyless: loopback && apiKey === null,
      probedAt: now().toISOString(),
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      profile,
      modelId: target,
      ok: false,
      error: "probe response was not valid JSON",
      keyless: loopback && apiKey === null,
      probedAt: now().toISOString(),
    };
  }

  const parsed = parseProbePayload(payload);
  const text = parsed.text ?? "";
  // "OK", "ok", "OK." and "Ok!" all mean the group answered. Demanding the exact bytes
  // failed usable models and blocked active mode for all seven profiles.
  const acknowledged = /^ok[.!]?$/i.test(text.trim());
  return {
    profile,
    modelId: target,
    ok: acknowledged,
    error: acknowledged ? undefined : parsed.error ?? `unexpected probe text: ${text.slice(0, 40)}`,
    latencyMs: Date.now() - startedAt,
    keyless: loopback && apiKey === null,
    probedAt: now().toISOString(),
  };
}

/** Probe all seven profiles; returns results plus aggregate readiness. */
export async function probeAll(
  config: FissionConfig,
  options: SetupProbeOptions = {},
): Promise<{ probes: Partial<Record<CanonicalProfile, ProbeResult>>; complete: boolean; failures: CanonicalProfile[] }> {
  // Concurrently: sequentially this was seven timeouts deep, so a stalled 9Router blocked
  // /fission-setup for up to 105s instead of one probe timeout.
  const results = await Promise.all(CANONICAL_PROFILES.map((profile) =>
    runProbe(config, profile, config.profiles[profile].modelId, options)));
  const probes: Partial<Record<CanonicalProfile, ProbeResult>> = {};
  const failures: CanonicalProfile[] = [];
  for (const result of results) {
    probes[result.profile] = result;
    if (!result.ok) failures.push(result.profile);
  }
  return { probes, complete: failures.length === 0, failures };
}

/** Load the durable setup state. Missing file means setup is incomplete. */
export async function loadSetupState(configPath: string, options: { fetch?: typeof fetch } = {}): Promise<SetupState> {
  const path = defaultSetupStatePath(configPath);
  try {
    const text = await readFile(path, "utf8");
    const raw: unknown = JSON.parse(text);
    if (isRecord(raw) && raw.version === 1 && isRecord(raw.probes)) {
      return raw as unknown as SetupState;
    }
  } catch {
    // Missing or malformed setup state is treated as incomplete.
  }
  return { version: 1, complete: false, lastProbedAt: null, probes: {} };
}

export async function saveSetupState(configPath: string, state: SetupState): Promise<void> {
  const path = defaultSetupStatePath(configPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** True when active mode may proceed: seven probed profiles, all passing,
 *  and every probe target still matches the configured target for that profile. */
export function isActiveReady(config: FissionConfig, setup: SetupState): boolean {
  if (config.mode !== "active") return false;
  if (!setup.complete) return false;
  return CANONICAL_PROFILES.every((profile) => {
    const probe = setup.probes[profile];
    return probe !== undefined
      && probe.ok
      && probe.modelId === config.profiles[profile].modelId;
  });
}
