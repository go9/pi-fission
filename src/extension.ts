import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfigPath, loadConfig, telemetryPath, type ConfigResult } from "./config.ts";
import { classify, observeToolPhase } from "./classifier.ts";
import { recommend } from "./policy.ts";
import { discoverModels, type DiscoveredModel, type DiscoveryResult } from "./router.ts";
import { footerText, formatConfig, formatExplain, formatHistory, formatStatus, type FusionView } from "./presentation.ts";
import {
  createTelemetryRecord,
  mergeUsage,
  sanitizeUsage,
  TelemetryStore,
  type AggregateUsage,
} from "./telemetry.ts";
import type {
  ActiveModelCategory,
  CanonicalProfile,
  Classification,
  FusionConfig,
  Recommendation,
} from "./types.ts";

export interface FusionExtensionOptions {
  configPath?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  stderr?: (message: string) => void;
  telemetryStoreFactory?: (path: string, maxEntries: number) => TelemetryStore;
}

interface ModelIdentity {
  provider: string;
  id: string;
}

interface RuntimeState {
  config: ConfigResult;
  discovery: DiscoveryResult | null;
  classification: Classification | null;
  recommendation: Recommendation | null;
  activeModel: string | null;
  activeModelCategory: ActiveModelCategory;
  startedAt: number | null;
  usage: AggregateUsage;
  outcome: "success" | "error" | "unknown";
}

function modelIdentity(ctx: ExtensionContext): ModelIdentity | null {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
}

function displayModel(identity: ModelIdentity | null): string | null {
  return identity ? `${identity.provider}/${identity.id}` : null;
}

function profileForModel(config: FusionConfig, modelIdValue: string, discovery?: DiscoveryResult | null): CanonicalProfile | null {
  if (discovery) {
    for (const [profile, resolved] of Object.entries(discovery.resolvedProfiles) as [CanonicalProfile, string][]) {
      if (resolved === modelIdValue) return profile;
    }
  }
  for (const [profile, configured] of Object.entries(config.profiles) as [CanonicalProfile, FusionConfig["profiles"][CanonicalProfile]][]) {
    if (configured.modelId === modelIdValue) return profile;
  }
  for (const [alias, profile] of Object.entries(config.aliases)) {
    if (alias === modelIdValue) return profile;
  }
  return null;
}

function modelCategory(configResult: ConfigResult, discovery: DiscoveryResult | null, identity: ModelIdentity | null): ActiveModelCategory {
  if (!identity) return "unknown";
  if (configResult.status !== "ready" || identity.provider !== configResult.config.provider.id) return "external";
  return profileForModel(configResult.config, identity.id, discovery) ?? "external";
}

function providerModels(config: FusionConfig, discovery: DiscoveryResult): DiscoveredModel[] {
  if (discovery.status === "ready") return discovery.models;
  return [...new Set(Object.values(config.profiles).map((profile) => profile.modelId))]
    .map((id) => ({ id, name: id, capabilities: {} }));
}

function registerProvider(pi: ExtensionAPI, config: FusionConfig, discovery: DiscoveryResult): void {
  if (!config.enabled) return;
  const models = providerModels(config, discovery).map((model) => {
    const profile = profileForModel(config, model.id, discovery);
    const capabilities = profile
      ? discovery.effectiveCapabilities[profile] ?? config.profiles[profile].capabilities
      : null;
    return {
      id: model.id,
      name: model.name,
      reasoning: capabilities?.reasoning ?? false,
      input: capabilities?.image ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: capabilities?.contextWindow ?? model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? Math.min(16_384, capabilities?.contextWindow ?? 16_384),
    };
  });
  pi.registerProvider(config.provider.id, {
    name: "9Router (Pi Fusion)",
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey ?? "local",
    authHeader: true,
    api: "openai-completions",
    models,
  });
}

function asView(state: RuntimeState): FusionView {
  return {
    config: state.config,
    discovery: state.discovery,
    classification: state.classification,
    recommendation: state.recommendation,
    activeModel: state.activeModel,
  };
}

function updateFooter(state: RuntimeState, ctx: ExtensionContext): void {
  if (ctx.mode === "tui") ctx.ui.setStatus("pi-fusion", footerText(asView(state)));
}

function show(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning",
  stderr: (message: string) => void,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  stderr(`[pi-fusion] ${message}\n`);
}

export async function createFusionExtension(pi: ExtensionAPI, options: FusionExtensionOptions = {}): Promise<void> {
  const environment = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(environment);
  const configResult = await loadConfig(configPath);
  let discovery: DiscoveryResult | null = null;
  let telemetry: TelemetryStore | null = null;

  if (configResult.status === "ready") {
    discovery = await discoverModels(configResult.config, { fetch: options.fetch, env: environment });
    registerProvider(pi, configResult.config, discovery);
    if (configResult.config.telemetry.enabled) {
      telemetry = (options.telemetryStoreFactory ?? ((path, maxEntries) => new TelemetryStore(path, maxEntries)))(
        telemetryPath(configPath, configResult.config),
        configResult.config.telemetry.maxEntries,
      );
    }
  }

  const state: RuntimeState = {
    config: configResult,
    discovery,
    classification: null,
    recommendation: null,
    activeModel: null,
    activeModelCategory: "unknown",
    startedAt: null,
    usage: {},
    outcome: "unknown",
  };
  const clock = options.now ?? Date.now;
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));

  const setActiveModel = (identity: ModelIdentity | null): void => {
    state.activeModel = displayModel(identity);
    state.activeModelCategory = modelCategory(state.config, state.discovery, identity);
  };

  const reroute = (): void => {
    if (state.config.status !== "ready" || !state.discovery || !state.classification) {
      state.recommendation = null;
      return;
    }
    state.recommendation = recommend({
      classification: state.classification,
      config: state.config.config,
      resolvedModels: state.discovery.resolvedProfiles,
      effectiveCapabilities: state.discovery.effectiveCapabilities,
      providerReady: state.discovery.status === "ready",
    });
  };

  const persist = async (): Promise<void> => {
    if (!telemetry || !state.classification || !state.recommendation) return;
    const durationMs = state.startedAt === null ? null : Math.max(0, clock() - state.startedAt);
    const record = createTelemetryRecord({
      classification: state.classification,
      recommendation: state.recommendation,
      activeModelCategory: state.activeModelCategory,
      usage: state.usage,
      durationMs,
      outcome: state.outcome,
    });
    try {
      await telemetry.record(record);
    } catch {
      // Telemetry is best-effort and must never break the Pi session.
    }
    state.startedAt = clock();
    state.usage = {};
    state.outcome = "unknown";
  };

  pi.on("session_start", (_event, ctx) => {
    setActiveModel(modelIdentity(ctx));
    updateFooter(state, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-fusion", undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    setActiveModel(modelIdentity(ctx));
    state.classification = classify({ text: event.prompt, imageCount: event.images?.length ?? 0 });
    state.startedAt = clock();
    state.usage = {};
    state.outcome = "unknown";
    reroute();
    updateFooter(state, ctx);
    // Deliberately return nothing: shadow mode never changes prompt or execution.
  });

  pi.on("tool_result", (event, ctx) => {
    if (state.classification) {
      state.classification = observeToolPhase(state.classification, event.toolName);
      reroute();
    }
    state.usage = mergeUsage(state.usage, sanitizeUsage(event.usage));
    if (event.isError) state.outcome = "error";
    updateFooter(state, ctx);
    // Deliberately return nothing: tool output is neither read nor modified.
  });

  pi.on("after_provider_response", (event) => {
    if (event.status >= 400) state.outcome = "error";
  });

  pi.on("turn_end", async (event, ctx) => {
    const messageUsage = (event.message as { usage?: unknown }).usage;
    state.usage = mergeUsage(state.usage, sanitizeUsage(messageUsage));
    if (state.outcome === "unknown") state.outcome = "success";
    setActiveModel(modelIdentity(ctx));
    await persist();
    updateFooter(state, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    setActiveModel({ provider: event.model.provider, id: event.model.id });
    updateFooter(state, ctx);
  });

  const report = (ctx: ExtensionContext, message: string): void => show(ctx, message, healthLevel(state), stderr);
  pi.registerCommand("fusion-status", {
    description: "Show Pi Fusion shadow health and current recommendation",
    handler: async (_args, ctx) => report(ctx, formatStatus(asView(state))),
  });
  pi.registerCommand("fusion-explain", {
    description: "Explain the current shadow recommendation and capability eligibility",
    handler: async (_args, ctx) => report(ctx, formatExplain(asView(state))),
  });
  pi.registerCommand("fusion-history", {
    description: "Show recent content-free shadow routing decisions",
    handler: async (_args, ctx) => {
      try {
        const records = telemetry ? await telemetry.recent(20) : [];
        report(ctx, formatHistory(records));
      } catch {
        show(ctx, "fusion history: shadow · unavailable · telemetry path is unsafe or unreadable", "warning", stderr);
      }
    },
  });
  pi.registerCommand("fusion-config", {
    description: "Show resolved Pi Fusion configuration diagnostics without secrets",
    handler: async (_args, ctx) => report(ctx, formatConfig(asView(state))),
  });
}

function healthLevel(state: RuntimeState): "info" | "warning" {
  return state.config.status === "ready" && state.discovery?.status === "ready" ? "info" : "warning";
}
