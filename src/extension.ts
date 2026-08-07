import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createDefaultConfig,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type ConfigResult,
} from "./config.ts";
import { classify } from "./classifier.ts";
import { recommend } from "./policy.ts";
import { discoverModels, type DiscoveredModel, type DiscoveryResult } from "./router.ts";
import {
  footerText,
  formatConfig,
  formatExplain,
  formatSetup,
  formatStatus,
  type FusionView,
  type RoutingStatus,
} from "./presentation.ts";
import { diagnoseSetup, isActiveReady, loadSetupState, probeAll, saveSetupState } from "./setup.ts";
import { appendRoutingEntry, describeRouting, readRoutingEntries, formatRoutingLog, type RoutingLogEntry } from "./routing-log.ts";
import type {
  ActiveThinkingLevel,
  CanonicalProfile,
  Classification,
  FusionConfig,
  Recommendation,
  SetupState,
} from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";

export interface FusionExtensionOptions {
  configPath?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  stderr?: (message: string) => void;
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
  setup: SetupState | null;
  routingStatus: RoutingStatus;
  routingReason: string | null;
  sessionId: string;
}

type ActivePiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

function modelIdentity(ctx: ExtensionContext): ModelIdentity | null {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
}

function displayModel(identity: ModelIdentity | null): string | null {
  return identity ? `${identity.provider}/${identity.id}` : null;
}

function profileForModel(config: FusionConfig, modelId: string, discovery?: DiscoveryResult | null): CanonicalProfile | null {
  if (discovery) {
    for (const [profile, resolved] of Object.entries(discovery.resolvedProfiles) as [CanonicalProfile, string][]) {
      if (resolved === modelId) return profile;
    }
  }
  for (const profile of CANONICAL_PROFILES) {
    if (config.profiles[profile].modelId === modelId) return profile;
  }
  return null;
}

function providerModels(config: FusionConfig, discovery: DiscoveryResult): DiscoveredModel[] {
  if (discovery.status === "ready") return discovery.models;
  return [...new Set(CANONICAL_PROFILES.map((profile) => config.profiles[profile].modelId))]
    .map((id) => ({ id, name: id, capabilities: {} }));
}

function registerProvider(pi: ExtensionAPI, config: FusionConfig, discovery: DiscoveryResult): void {
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
  const keylessLoopback = config.provider.apiKey === undefined;
  pi.registerProvider(config.provider.id, {
    name: "9Router (Pi Fusion)",
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey ?? "local",
    authHeader: !keylessLoopback,
    api: "openai-completions",
    ...(keylessLoopback
      ? {
          streamSimple: (model: Parameters<typeof streamOpenAICompletions>[0], context: unknown, options?: { headers?: Record<string, string | null> }) =>
            streamOpenAICompletions(model, context as Parameters<typeof streamOpenAICompletions>[1], {
              ...options,
              headers: { ...options?.headers, Authorization: null },
            }),
        }
      : {}),
    models,
  });
}

function asView(state: RuntimeState): FusionView {
  return state;
}

function updateFooter(state: RuntimeState, ctx: ExtensionContext): void {
  if (ctx.mode === "tui") ctx.ui.setStatus("pi-fusion", footerText(asView(state)));
}

function show(ctx: ExtensionContext, message: string, level: "info" | "warning", stderr: (message: string) => void): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else stderr(`[pi-fusion] ${message}\n`);
}

function words(args: string | string[] | undefined): string[] {
  if (Array.isArray(args)) return args.flatMap((value) => value.trim().split(/\s+/)).filter(Boolean);
  return typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
}

function setupMappings(args: string | string[] | undefined): { mappings: Partial<Record<CanonicalProfile, string>>; error: string | null } {
  const mappings: Partial<Record<CanonicalProfile, string>> = {};
  for (const token of words(args)) {
    const separator = token.indexOf("=");
    if (separator <= 0 || separator === token.length - 1) return { mappings, error: `expected profile=9router-group, got ${token}` };
    const profile = token.slice(0, separator) as CanonicalProfile;
    const modelId = token.slice(separator + 1);
    if (!CANONICAL_PROFILES.includes(profile)) return { mappings, error: `unknown profile ${profile}` };
    mappings[profile] = modelId;
  }
  return { mappings, error: null };
}

function applyMappings(config: FusionConfig, mappings: Partial<Record<CanonicalProfile, string>>): FusionConfig {
  return {
    ...config,
    profiles: Object.fromEntries(CANONICAL_PROFILES.map((profile) => [profile, {
      ...config.profiles[profile],
      modelId: mappings[profile] ?? config.profiles[profile].modelId,
    }])) as FusionConfig["profiles"],
  };
}

export async function createFusionExtension(pi: ExtensionAPI, options: FusionExtensionOptions = {}): Promise<void> {
  const environment = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(environment);
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  let configResult = await loadConfig(configPath);
  let discovery: DiscoveryResult | null = null;
  let setup: SetupState | null = null;

  if (configResult.status === "ready") {
    discovery = await discoverModels(configResult.config, { fetch: options.fetch, env: environment });
    registerProvider(pi, configResult.config, discovery);
    setup = await loadSetupState(configPath, { fetch: options.fetch });
  }

  const state: RuntimeState = {
    config: configResult,
    discovery,
    classification: null,
    recommendation: null,
    activeModel: null,
    setup,
    routingStatus: "idle",
    routingReason: null,
    sessionId: "unknown",
  };

  let restoreModel: ActivePiModel | null = null;
  let routeActive = false;
  let routeChangedModel = false;
  let expectedInternalSelection: ModelIdentity | null = null;
  let restorationInProgress = false;
  let restorationPromise: Promise<void> | null = null;
  let userSelectionDuringRestore: ActivePiModel | null = null;
  /** Model we just restored, plus when; late set-source events matching it are our own restore, not overrides. */
  let lastRestoreModel: ModelIdentity | null = null;
  let lastRestoreAt = 0;
  let restoreThinkingLevel: PiThinkingLevel | null = null;
  let userThinkingLevel: PiThinkingLevel | null = null;
  let expectedInternalThinkingLevel: PiThinkingLevel | null = null;
  let activeInternalThinkingStart: PiThinkingLevel | null = null;
  let activeInternalThinkingObserved = false;
  let routeSelectionInProgress = false;
  let pendingInternalThinkingTransitions: Array<{
    model: ModelIdentity;
    previousLevel: PiThinkingLevel;
    level: PiThinkingLevel;
  }> = [];
  let manualOverride = false;
  /** Whether a real user prompt has begun; selections before that are startup defaults, not overrides. */
  let promptSeen = false;

  const setActiveModel = (identity: ModelIdentity | null): void => {
    state.activeModel = displayModel(identity);
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

  const readThinkingLevel = (ctx?: ExtensionContext): PiThinkingLevel | null => {
    if (ctx?.thinkingLevel) return ctx.thinkingLevel;
    try { return pi.getThinkingLevel(); } catch { return null; }
  };

  const selectInternalModel = async (model: ActivePiModel): Promise<boolean> => {
    activeInternalThinkingStart = readThinkingLevel();
    activeInternalThinkingObserved = false;
    try {
      return await pi.setModel(model);
    } finally {
      const start = activeInternalThinkingStart;
      const after = readThinkingLevel();
      if (start && after && start !== after && !activeInternalThinkingObserved) {
        pendingInternalThinkingTransitions.push({
          model: { provider: model.provider, id: model.id },
          previousLevel: start,
          level: after,
        });
      }
      activeInternalThinkingStart = null;
      activeInternalThinkingObserved = false;
    }
  };

  const applyInternalThinkingLevel = async (level: PiThinkingLevel): Promise<boolean> => {
    expectedInternalThinkingLevel = level;
    try {
      pi.setThinkingLevel(level);
      await Promise.resolve();
      const observed = readThinkingLevel();
      return observed === null || observed === level;
    } catch {
      return false;
    } finally {
      if (expectedInternalThinkingLevel === level) expectedInternalThinkingLevel = null;
    }
  };

  const takeUserSelectionDuringRestore = (): ActivePiModel | null => {
    const selected = userSelectionDuringRestore;
    userSelectionDuringRestore = null;
    return selected;
  };

  const restoreRoute = async (ctx: ExtensionContext): Promise<void> => {
    if (restorationPromise) return restorationPromise;
    if (!routeActive) return;
    restorationPromise = (async () => {
      const previous = restoreModel;
      const originalThinking = restoreThinkingLevel;
      let modelReady = false;
      if (previous && routeChangedModel) {
        restorationInProgress = true;
        userSelectionDuringRestore = null;
        expectedInternalSelection = { provider: previous.provider, id: previous.id };
        let restored = false;
        try { restored = await selectInternalModel(previous); } catch { restored = false; }
        expectedInternalSelection = null;

        let userSelection = takeUserSelectionDuringRestore();
        while (userSelection) {
          expectedInternalSelection = { provider: userSelection.provider, id: userSelection.id };
          let retained = false;
          try { retained = await selectInternalModel(userSelection); } catch { retained = false; }
          expectedInternalSelection = null;
          if (!retained) {
            restored = false;
            break;
          }
          restored = true;
          manualOverride = true;
          state.routingStatus = "manual";
          state.routingReason = "user selected a model";
          setActiveModel({ provider: userSelection.provider, id: userSelection.id });
          userSelection = takeUserSelectionDuringRestore();
        }
        restorationInProgress = false;
        modelReady = restored;
      } else if (previous) {
        modelReady = true;
      }

      if (modelReady && state.routingStatus !== "manual") {
        lastRestoreModel = previous;
        lastRestoreAt = Date.now();
      }
      if (modelReady && state.routingStatus !== "manual") {
        setActiveModel(previous ? { provider: previous.provider, id: previous.id } : null);
      }
      if (modelReady) {
        const desiredThinking = userThinkingLevel ?? originalThinking;
        if (desiredThinking && !(await applyInternalThinkingLevel(desiredThinking))) modelReady = false;
      }
      if (!modelReady && state.routingStatus !== "manual") {
        state.routingStatus = "restore-failed";
        state.routingReason = "previous model or thinking level could not be restored";
      }

      routeActive = false;
      routeChangedModel = false;
      restoreModel = null;
      restoreThinkingLevel = null;
      userThinkingLevel = null;
      expectedInternalSelection = null;
      expectedInternalThinkingLevel = null;
      activeInternalThinkingStart = null;
      activeInternalThinkingObserved = false;
      routeSelectionInProgress = false;
      pendingInternalThinkingTransitions = [];
      restorationInProgress = false;
      userSelectionDuringRestore = null;
    })();
    try { await restorationPromise; } finally { restorationPromise = null; }
    updateFooter(state, ctx);
  };

  const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void => show(ctx, message, level, stderr);

  const getSessionId = (ctx: ExtensionContext): string => {
    try {
      const id = ctx.sessionManager?.getSessionId?.();
      if (id) return id;
    } catch {
      // fall through
    }
    return `pid:${process.pid}`;
  };

  const recordRouting = async (ctx: ExtensionContext, previousModel: ModelIdentity | null): Promise<void> => {
    if (state.config.status !== "ready" || state.config.config.mode !== "active") return;
    const kind: RoutingLogEntry["kind"] =
      state.routingStatus === "routed" ? "route"
      : state.routingStatus === "manual" ? "manual"
      : state.routingStatus === "restore-failed" ? "restore-failed"
      : "retained";
    const toModel = state.recommendation?.modelId ?? null;
    const fromModel = previousModel ? `${previousModel.provider}/${previousModel.id}` : state.activeModel;
    const entry: RoutingLogEntry = {
      version: 1,
      ts: new Date().toISOString(),
      sessionId: state.sessionId,
      cwd: ctx.cwd,
      kind,
      phase: state.classification?.phase ?? "unknown",
      profile: state.recommendation?.profile ?? null,
      fromModel,
      toModel,
      switched: kind === "route" && toModel !== null && fromModel !== toModel,
      reason: describeRouting(kind, state.classification?.phase ?? "unknown", state.recommendation?.reasonCodes ?? []),
      reasonCodes: state.recommendation?.reasonCodes ?? [],
      confidence: state.recommendation?.confidence ?? null,
    };
    await appendRoutingEntry(configPath, entry);
  };

  pi.on("session_start", async (_event, ctx) => {
    state.sessionId = getSessionId(ctx);
    setActiveModel(modelIdentity(ctx));
    updateFooter(state, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await restoreRoute(ctx);
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-fusion", undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    promptSeen = true;
    lastRestoreModel = null;
    lastRestoreAt = 0;
    const previousModel = modelIdentity(ctx);
    setActiveModel(previousModel);
    state.classification = classify({ text: event.prompt, imageCount: event.images?.length ?? 0 });
    state.routingReason = null;
    reroute();

    if (state.config.status !== "ready" || state.config.config.mode !== "active") {
      state.routingStatus = "idle";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    if (!state.setup || !isActiveReady(state.config.config, state.setup)) {
      state.routingStatus = "setup-blocked";
      state.routingReason = "run /fusion-setup";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    if (manualOverride) {
      state.routingStatus = "manual";
      state.routingReason = "manual model selection takes precedence; run /fusion-mode active to resume automatic routing";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    if (!state.recommendation?.profile || !state.recommendation.modelId || state.discovery?.status !== "ready") {
      state.routingStatus = "retained";
      state.routingReason = state.recommendation?.reasonCodes.join(", ") || state.discovery?.diagnostic || "no eligible route";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    const target = ctx.modelRegistry.find(state.config.config.provider.id, state.recommendation.modelId);
    const previous = ctx.model;
    if (!target || !previous) {
      state.routingStatus = "retained";
      state.routingReason = !target ? "recommended 9Router group is unavailable" : "current Pi model is unavailable";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }

    restoreModel = previous;
    restoreThinkingLevel = readThinkingLevel(ctx);
    routeActive = true;
    routeChangedModel = previous.provider !== target.provider || previous.id !== target.id;
    state.routingStatus = "routed";
    if (!routeChangedModel) {
      setActiveModel({ provider: target.provider, id: target.id });
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }

    routeSelectionInProgress = true;
    expectedInternalSelection = { provider: target.provider, id: target.id };
    let selected = false;
    try { selected = await selectInternalModel(target); } catch { selected = false; }
    routeSelectionInProgress = false;
    expectedInternalSelection = null;
    if (!selected) {
      routeActive = false;
      routeChangedModel = false;
      restoreModel = null;
      restoreThinkingLevel = null;
      state.routingStatus = "retained";
      state.routingReason = "9Router group selection failed";
    } else {
      setActiveModel({ provider: target.provider, id: target.id });
    }
    await recordRouting(ctx, previousModel);
    updateFooter(state, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const selected = { provider: event.model.provider, id: event.model.id };
    const internal = expectedInternalSelection
      && expectedInternalSelection.provider === selected.provider
      && expectedInternalSelection.id === selected.id;
    if (internal) {
      expectedInternalSelection = null;
    } else if (restorationInProgress) {
      userSelectionDuringRestore = event.model;
    } else if (lastRestoreModel
      && selected.provider === lastRestoreModel.provider
      && selected.id === lastRestoreModel.id
      && Date.now() - lastRestoreAt < 3000) {
      // Late set-source event from our own restore: not a user override.
      setActiveModel(selected);
    } else if (event.source === "restore") {
      // Pi re-applying a model (our own restore or a session restore): never a user override.
      setActiveModel(selected);
    } else if (event.source === "cycle" || promptSeen) {
      manualOverride = true;
      routeActive = false;
      routeChangedModel = false;
      restoreModel = null;
      state.routingStatus = "manual";
      state.routingReason = "user selected a model";
      setActiveModel(selected);
    } else {
      // Session-start default or idle provider fallback: not a user override.
      setActiveModel(selected);
    }
    updateFooter(state, ctx);
  });

  pi.on("thinking_level_select", (event) => {
    const current = state.activeModel?.split("/");
    const currentModel = current && current.length > 1 ? { provider: current[0]!, id: current.slice(1).join("/") } : null;
    const expectedTargetIsCurrent = expectedInternalSelection !== null
      && currentModel?.provider === expectedInternalSelection.provider
      && currentModel.id === expectedInternalSelection.id;
    const internalExplicit = expectedInternalThinkingLevel === event.level;
    const activeInternalClamp = expectedTargetIsCurrent
      && activeInternalThinkingStart === event.previousLevel
      && !activeInternalThinkingObserved;
    const pendingIndex = pendingInternalThinkingTransitions.findIndex((transition) =>
      currentModel?.provider === transition.model.provider
      && currentModel.id === transition.model.id
      && transition.previousLevel === event.previousLevel
      && transition.level === event.level);
    if (internalExplicit) expectedInternalThinkingLevel = null;
    else if (activeInternalClamp) activeInternalThinkingObserved = true;
    else if (pendingIndex >= 0) pendingInternalThinkingTransitions.splice(pendingIndex, 1);
    else if (routeSelectionInProgress || routeActive || restorationInProgress) userThinkingLevel = event.level;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await restoreRoute(ctx);
  });

  pi.registerCommand("fusion", {
    description: "Show Pi Fusion routing status",
    handler: async (_args, ctx) => report(ctx, formatStatus(asView(state)), state.routingStatus === "restore-failed" ? "warning" : "info"),
  });
  pi.registerCommand("fusion-status", {
    description: "Show Pi Fusion routing status",
    handler: async (_args, ctx) => report(ctx, formatStatus(asView(state)), state.routingStatus === "restore-failed" ? "warning" : "info"),
  });
  pi.registerCommand("fusion-config", {
    description: "Show the seven semantic profile mappings",
    handler: async (_args, ctx) => report(ctx, formatConfig(asView(state))),
  });
  pi.registerCommand("fusion-explain", {
    description: "Explain the latest automatic route",
    handler: async (_args, ctx) => report(ctx, formatExplain(asView(state))),
  });
  pi.registerCommand("fusion-routing", {
    description: "Show current models and why each session switched (main agent and subagents)",
    handler: async (_args, ctx) => report(ctx, formatRoutingLog(await readRoutingEntries(configPath))),
  });
  pi.registerCommand("fusion-setup-status", {
    description: "Show seven-profile setup and probe status",
    handler: async (_args, ctx) => report(ctx, formatSetup(asView(state))),
  });
  pi.registerCommand("fusion-mode", {
    description: "Show or set automatic routing mode (off, shadow, active)",
    handler: async (args, ctx) => {
      if (state.config.status !== "ready") {
        report(ctx, "fusion mode: setup required · run /fusion-setup", "warning");
        return;
      }
      const requested = words(args)[0];
      if (!requested) {
        report(ctx, `fusion mode: ${state.config.config.mode}`);
        return;
      }
      if (requested !== "off" && requested !== "shadow" && requested !== "active") {
        report(ctx, "fusion mode: must be off, shadow, or active", "warning");
        return;
      }
      if (requested === "active" && (!state.setup || !isActiveReady({ ...state.config.config, mode: "active" }, state.setup))) {
        report(ctx, "fusion mode: active blocked · run /fusion-setup", "warning");
        return;
      }
      const updated = { ...state.config.config, mode: requested } as FusionConfig;
      await saveConfig(configPath, updated);
      state.config = { status: "ready", path: configPath, config: updated, diagnostics: [] };
      configResult = state.config;
      manualOverride = false;
      state.routingStatus = "idle";
      state.routingReason = null;
      updateFooter(state, ctx);
      report(ctx, `fusion mode: ${requested}`);
    },
  });
  pi.registerCommand("fusion-setup", {
    description: "Configure, probe, and activate seven 9Router profile groups",
    handler: async (args, ctx) => {
      const parsed = setupMappings(args);
      if (parsed.error) {
        report(ctx, `fusion setup: ${parsed.error}`, "warning");
        return;
      }
      if (state.config.status === "invalid-config") {
        report(ctx, `fusion setup: refusing to overwrite invalid config · ${state.config.diagnostics.join("; ")}`, "warning");
        return;
      }
      let config = state.config.status === "ready" ? state.config.config : createDefaultConfig();
      config = { ...applyMappings(config, parsed.mappings), mode: "shadow" };
      await saveConfig(configPath, config);
      state.config = { status: "ready", path: configPath, config, diagnostics: [] };
      configResult = state.config;
      state.discovery = await discoverModels(config, { fetch: options.fetch, env: environment });
      discovery = state.discovery;
      if (discovery.status !== "ready") {
        state.routingStatus = "setup-blocked";
        state.routingReason = discovery.diagnostic;
        updateFooter(state, ctx);
        report(ctx, `fusion setup: 9Router unavailable · ${discovery.diagnostic}`, "warning");
        return;
      }
      const blocked = diagnoseSetup(config, discovery.models).filter((diagnostic) => !diagnostic.ok);
      if (blocked.length > 0) {
        state.routingStatus = "setup-blocked";
        state.routingReason = blocked.map((item) => `${item.profile}: ${item.issues.join(", ")}`).join(" · ");
        updateFooter(state, ctx);
        report(ctx, `fusion setup: mapping blocked · ${state.routingReason}`, "warning");
        return;
      }
      const result = await probeAll(config, { fetch: options.fetch, env: environment });
      const nextSetup: SetupState = {
        version: 1,
        complete: result.complete,
        lastProbedAt: new Date().toISOString(),
        probes: result.probes,
      };
      await saveSetupState(configPath, nextSetup);
      setup = nextSetup;
      state.setup = nextSetup;
      if (!result.complete) {
        state.routingStatus = "setup-blocked";
        state.routingReason = result.failures.join(", ");
        updateFooter(state, ctx);
        report(ctx, `fusion setup: blocked · failed profiles ${result.failures.join(", ")}`, "warning");
        return;
      }
      config = { ...config, mode: "active" };
      await saveConfig(configPath, config);
      state.config = { status: "ready", path: configPath, config, diagnostics: [] };
      configResult = state.config;
      registerProvider(pi, config, discovery);
      manualOverride = false;
      state.routingStatus = "idle";
      state.routingReason = null;
      updateFooter(state, ctx);
      report(ctx, "fusion setup: complete · 7/7 profiles passed · automatic routing active");
    },
  });
}

export default function piFusion(pi: ExtensionAPI): void {
  void createFusionExtension(pi).catch((error) => {
    process.stderr.write(`[pi-fusion] initialization failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  });
}
