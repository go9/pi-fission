import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { stat } from "node:fs/promises";
import {
  createDefaultConfig,
  defaultConfigPath,
  effectiveProfileTarget,
  loadConfig,
  saveConfig,
  type ConfigResult,
} from "./config.ts";
import { classify } from "./classifier.ts";
import { recommend } from "./policy.ts";
import { constrainCapabilities, discoverModels, type DiscoveredModel, type DiscoveryResult } from "./router.ts";
import {
  footerText,
  formatSetupTable,
  type FissionView,
  type RoutingStatus,
} from "./presentation.ts";
import { diagnoseSetup, isActiveReady, loadSetupState, probeAll, saveSetupState } from "./setup.ts";
import {
  beginPrompt,
  beginRoute,
  createRouteState,
  decideModelSelect,
  endRoute,
  expectSelection,
  expectThinkingEcho,
  observeThinkingSelect,
  resetSession,
  takeQueuedSelection,
  type ModelIdentity,
} from "./route-controller.ts";
import { appendRoutingEntry, describeRouting, formatRoutingLog, readRoutingEntries, routingLogPath, sessionSummaries, widgetRows, type RoutingLogEntry } from "./routing-log.ts";
import type {
  CanonicalProfile,
  Classification,
  FissionConfig,
  Recommendation,
  SetupState,
} from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";

export interface FissionExtensionOptions {
  configPath?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  stderr?: (message: string) => void;
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

function profileForModel(config: FissionConfig, modelId: string, discovery?: DiscoveryResult | null): CanonicalProfile | null {
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

function providerModels(config: FissionConfig, discovery: DiscoveryResult): DiscoveredModel[] {
  if (discovery.status === "ready") return discovery.models;
  return [...new Set(CANONICAL_PROFILES.map((profile) => config.profiles[profile].modelId))]
    .map((id) => ({ id, name: id, capabilities: {} }));
}

function registerProvider(pi: ExtensionAPI, config: FissionConfig, discovery: DiscoveryResult): void {
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
  // Pi merges a re-registration over the previous one and keeps any key the new config
  // omits, so a keyless -> keyed transition would retain the Authorization-stripping
  // streamSimple below. Drop the old registration first; it is a no-op when absent.
  if (typeof pi.unregisterProvider === "function") pi.unregisterProvider(config.provider.id);
  pi.registerProvider(config.provider.id, {
    name: `Pi Fission (${config.provider.id})`,
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

function asView(state: RuntimeState): FissionView {
  return state;
}

function updateFooter(state: RuntimeState, ctx: ExtensionContext): void {
  if (ctx.mode === "tui") ctx.ui.setStatus("pi-fission", footerText(asView(state)));
}

function show(ctx: ExtensionContext, message: string, level: "info" | "warning", stderr: (message: string) => void): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else stderr(`[pi-fission] ${message}\n`);
}

function words(args: string | string[] | undefined): string[] {
  if (Array.isArray(args)) return args.flatMap((value) => value.trim().split(/\s+/)).filter(Boolean);
  return typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : [];
}

function setupMappings(args: string | string[] | undefined): { mappings: Partial<Record<CanonicalProfile, string>>; error: string | null } {
  const mappings: Partial<Record<CanonicalProfile, string>> = {};
  for (const token of words(args)) {
    const separator = token.indexOf("=");
    if (separator <= 0 || separator === token.length - 1) return { mappings, error: `expected profile=model, got ${token}` };
    const profile = token.slice(0, separator) as CanonicalProfile;
    const modelId = token.slice(separator + 1);
    if (!CANONICAL_PROFILES.includes(profile)) return { mappings, error: `unknown profile ${profile}` };
    mappings[profile] = modelId;
  }
  return { mappings, error: null };
}

function applyMappings(config: FissionConfig, mappings: Partial<Record<CanonicalProfile, string>>): FissionConfig {
  return {
    ...config,
    profiles: Object.fromEntries(CANONICAL_PROFILES.map((profile) => [profile, {
      ...config.profiles[profile],
      modelId: mappings[profile] ?? config.profiles[profile].modelId,
    }])) as FissionConfig["profiles"],
  };
}

export async function createFissionExtension(pi: ExtensionAPI, options: FissionExtensionOptions = {}): Promise<void> {
  const environment = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(environment);
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  const configResult = await loadConfig(configPath);
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

  /** Route/restore bookkeeping: which phase the session is in, and which host events are
   *  echoes of our own actions rather than the user's. See route-controller.ts. */
  const route = createRouteState();
  let restorationPromise: Promise<void> | null = null;

  const setActiveModel = (identity: ModelIdentity | null): void => {
    route.activeModel = identity;
    state.activeModel = displayModel(identity);
  };

  /**
   * Per-repository profile targets, resolved against the discovered catalogue rather than
   * substituted at selection time. An override is a different model, so it has to be judged
   * as one: an override target the provider does not list makes its profile ineligible
   * (model.unavailable) so routing falls through to another profile, and one that IS listed
   * is capability-checked against what was discovered for it. Substituting the id after
   * eligibility was computed from the default target declared every override eligible and
   * failed late, at model selection.
   */
  const overriddenDiscovery = (
    config: FissionConfig,
    discovery: DiscoveryResult,
    repo?: string,
  ): Pick<DiscoveryResult, "resolvedProfiles" | "effectiveCapabilities"> => {
    const { resolvedProfiles, effectiveCapabilities } = discovery;
    if (discovery.status !== "ready" || config.projectOverrides.length === 0) return { resolvedProfiles, effectiveCapabilities };
    const resolved = { ...resolvedProfiles };
    const capabilities = { ...effectiveCapabilities };
    for (const profile of CANONICAL_PROFILES) {
      const target = effectiveProfileTarget(config, profile, repo);
      if (target === config.profiles[profile].modelId) continue;
      const discovered = discovery.models.find((model) => model.id === target);
      if (discovered) {
        resolved[profile] = target;
        capabilities[profile] = constrainCapabilities(config.profiles[profile].capabilities, discovered);
      } else {
        delete resolved[profile];
        delete capabilities[profile];
      }
    }
    return { resolvedProfiles: resolved, effectiveCapabilities: capabilities };
  };

  const reroute = (ctx?: ExtensionContext): void => {
    if (state.config.status !== "ready" || !state.discovery || !state.classification) {
      state.recommendation = null;
      return;
    }
    const overridden = overriddenDiscovery(state.config.config, state.discovery, ctx?.cwd);
    state.recommendation = recommend({
      classification: state.classification,
      config: state.config.config,
      resolvedModels: overridden.resolvedProfiles,
      effectiveCapabilities: overridden.effectiveCapabilities,
      providerReady: state.discovery.status === "ready",
    });
  };

  /** Re-discover in the background when the provider was unreachable at load, so the next prompt
   *  recovers on its own. Never awaited: a down router must not stall the turn. */
  let discoveryInFlight = false;
  let lastDiscoveryAt = Date.now();
  const RE_DISCOVERY_INTERVAL_MS = 60_000;
  const ensureDiscovery = (): void => {
    if (state.config.status !== "ready" || state.config.config.mode === "off") return;
    if (state.discovery?.status === "ready" || discoveryInFlight) return;
    if (Date.now() - lastDiscoveryAt < RE_DISCOVERY_INTERVAL_MS) return;
    const config = state.config.config;
    discoveryInFlight = true;
    lastDiscoveryAt = Date.now();
    void discoverModels(config, { fetch: options.fetch, env: environment })
      .then((result) => {
        state.discovery = result;
        if (result.status === "ready") registerProvider(pi, config, result);
      })
      .catch(() => undefined)
      .finally(() => { discoveryInFlight = false; });
  };

  const readThinkingLevel = (ctx?: ExtensionContext): PiThinkingLevel | null => {
    if (ctx?.thinkingLevel) return ctx.thinkingLevel;
    try { return pi.getThinkingLevel(); } catch { return null; }
  };

  /** Select a model on the user's behalf, leaving an expectation so the resulting
   *  model_select event is recognized as ours however late it arrives. */
  const selectInternalModel = async (model: ActivePiModel): Promise<boolean> => {
    expectSelection(route, model);
    route.selectionInFlight = true;
    route.thinkingAtSelectionStart = readThinkingLevel();
    route.thinkingEchoObserved = false;
    try {
      return await pi.setModel(model);
    } finally {
      const start = route.thinkingAtSelectionStart;
      const after = readThinkingLevel();
      // The switch moved the thinking level and the host has not told us yet; expect it.
      if (start && after && start !== after && !route.thinkingEchoObserved) {
        expectThinkingEcho(route, { model: { provider: model.provider, id: model.id }, previousLevel: start, level: after });
      }
      route.selectionInFlight = false;
      route.thinkingAtSelectionStart = null;
      route.thinkingEchoObserved = false;
    }
  };

  const applyInternalThinkingLevel = async (level: PiThinkingLevel): Promise<boolean> => {
    route.expectedThinkingLevel = level;
    try {
      pi.setThinkingLevel(level);
      await Promise.resolve();
      const observed = readThinkingLevel();
      return observed === null || observed === level;
    } catch {
      return false;
    } finally {
      if (route.expectedThinkingLevel === level) route.expectedThinkingLevel = null;
    }
  };

  const restoreRoute = async (ctx: ExtensionContext): Promise<void> => {
    if (restorationPromise) return restorationPromise;
    if (route.phase.kind !== "routed") return;
    const { restore, changedModel } = route.phase;
    restorationPromise = (async () => {
      const previous = restore.model;
      let modelReady = false;
      if (previous && changedModel) {
        route.phase = { kind: "restoring", restore, changedModel };
        route.queuedSelections = [];
        let restored = false;
        try { restored = await selectInternalModel(previous); } catch { restored = false; }

        // The user picked a model while we were putting theirs back. Honor the last such
        // pick rather than the restore point, and stop routing automatically.
        let userSelection = takeQueuedSelection(route);
        while (userSelection) {
          let retained = false;
          try { retained = await selectInternalModel(userSelection); } catch { retained = false; }
          if (!retained) {
            restored = false;
            break;
          }
          restored = true;
          route.manual = true;
          state.routingStatus = "manual";
          state.routingReason = "user selected a model";
          setActiveModel({ provider: userSelection.provider, id: userSelection.id });
          userSelection = takeQueuedSelection(route);
        }
        modelReady = restored;
      } else if (previous) {
        modelReady = true;
      }

      if (modelReady && state.routingStatus !== "manual") {
        setActiveModel(previous ? { provider: previous.provider, id: previous.id } : null);
      }
      if (modelReady) {
        const desiredThinking = route.userThinkingLevel ?? restore.thinkingLevel;
        if (desiredThinking && !(await applyInternalThinkingLevel(desiredThinking))) modelReady = false;
      }
      if (!modelReady && state.routingStatus !== "manual") {
        state.routingStatus = "restore-failed";
        state.routingReason = "previous model or thinking level could not be restored";
      }
      endRoute(route);
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

  const getSessionName = (ctx: ExtensionContext): string | undefined => {
    try {
      return ctx.sessionManager?.getSessionName?.() ?? undefined;
    } catch {
      return undefined;
    }
  };

  const recordRouting = async (ctx: ExtensionContext, previousModel: ModelIdentity | null): Promise<void> => {
    if (state.config.status !== "ready" || state.config.config.mode === "off") return;
    const kind: RoutingLogEntry["kind"] =
      state.config.config.mode === "shadow" ? "shadow"
      : state.routingStatus === "routed" ? "route"
      : state.routingStatus === "manual" ? "manual"
      : state.routingStatus === "restore-failed" ? "restore-failed"
      : "retained";
    // Both sides are provider-qualified so `switched` compares like with like. Comparing a
    // bare group id against `provider/id` made every route report a switch that never happened.
    const recommended = state.recommendation?.modelId ?? null;
    const toModel = recommended ? displayModel({ provider: state.config.config.provider.id, id: recommended }) : null;
    const fromModel = previousModel ? displayModel(previousModel) : state.activeModel;
    const entry: RoutingLogEntry = {
      version: 1,
      ts: new Date().toISOString(),
      sessionId: state.sessionId,
      sessionName: getSessionName(ctx),
      parentSessionId: environment.PI_SUBAGENT_PARENT_SESSION,
      childAgent: environment.PI_SUBAGENT_CHILD_AGENT ?? environment.PI_SUBAGENT_RUN_ID,
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

  let widgetExpanded = false;
  let widgetTimer: NodeJS.Timeout | null = null;
  let widgetCtx: ExtensionContext | null = null;
  /** Last observed routing-log stat so the polling loop skips re-parses while nothing changed. */
  let lastLogStat: { size: number; mtimeMs: number } | null = null;

  const refreshWidget = async (force = false): Promise<void> => {
    if (!widgetCtx || typeof widgetCtx.ui.setWidget !== "function") return;
    if (!force) {
      try {
        const current = await stat(routingLogPath(configPath));
        if (lastLogStat && current.size === lastLogStat.size && current.mtimeMs === lastLogStat.mtimeMs) return;
        lastLogStat = { size: current.size, mtimeMs: current.mtimeMs };
      } catch {
        // Missing log: still render the empty state.
      }
    }
    const entries = await readRoutingEntries(configPath);
    const summaries = sessionSummaries(entries, Date.now(), state.sessionId);
    widgetCtx.ui.setWidget("pi-fission-agents", widgetRows(summaries, state.sessionId, widgetExpanded));
  };

  const toggleWidget = (ctx: ExtensionContext): Promise<void> => {
    widgetExpanded = !widgetExpanded;
    const refreshed = refreshWidget(true);
    report(ctx, widgetExpanded ? "fission agents: expanded" : "fission agents: collapsed", "info");
    return refreshed;
  };

  pi.on("session_start", async (_event, ctx) => {
    resetSession(route);
    state.routingStatus = "idle";
    state.routingReason = null;
    // Phase continuity is session-scoped: a new session is not a follow-up.
    state.classification = null;
    state.sessionId = getSessionId(ctx);
    setActiveModel(modelIdentity(ctx));
    updateFooter(state, ctx);
    if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
      widgetCtx = ctx;
      await refreshWidget(true);
      if (!widgetTimer) {
        widgetTimer = setInterval(() => { void refreshWidget(); }, 5000);
        widgetTimer.unref();
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await restoreRoute(ctx);
    if (widgetTimer) { clearInterval(widgetTimer); widgetTimer = null; }
    widgetCtx = null;
    if (ctx.mode === "tui") {
      if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("pi-fission-agents", undefined);
      ctx.ui.setStatus("pi-fission", undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    beginPrompt(route);
    ensureDiscovery();
    const previousModel = modelIdentity(ctx);
    setActiveModel(previousModel);
    state.classification = classify({
      text: event.prompt,
      imageCount: event.images?.length ?? 0,
      previous: state.classification,
    });
    state.routingReason = null;
    reroute(ctx);

    if (state.config.status !== "ready" || state.config.config.mode !== "active") {
      state.routingStatus = "idle";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    if (!state.setup || !isActiveReady(state.config.config, state.setup)) {
      state.routingStatus = "setup-blocked";
      state.routingReason = "run /fission-setup";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }
    if (route.manual) {
      state.routingStatus = "manual";
      state.routingReason = "manual model selection takes precedence; run /fission-mode active to resume automatic routing";
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
      state.routingReason = !target ? "recommended model is unavailable" : "current Pi model is unavailable";
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }

    const changedModel = previous.provider !== target.provider || previous.id !== target.id;
    beginRoute(route, { model: previous, thinkingLevel: readThinkingLevel(ctx) }, changedModel);
    state.routingStatus = "routed";
    if (!changedModel) {
      setActiveModel({ provider: target.provider, id: target.id });
      await recordRouting(ctx, previousModel);
      updateFooter(state, ctx);
      return;
    }

    let selected = false;
    try { selected = await selectInternalModel(target); } catch { selected = false; }
    if (!selected) {
      endRoute(route);
      state.routingStatus = "retained";
      state.routingReason = "model selection failed";
    } else {
      setActiveModel({ provider: target.provider, id: target.id });
    }
    await recordRouting(ctx, previousModel);
    updateFooter(state, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const selected = { provider: event.model.provider, id: event.model.id };
    switch (decideModelSelect(route, event)) {
      case "queue":
        route.queuedSelections.push(event.model);
        break;
      case "override":
        route.manual = true;
        // Abandon the route entirely: the thinking level we were holding for the restore
        // belonged to a route the user just replaced.
        endRoute(route);
        state.routingStatus = "manual";
        state.routingReason = "user selected a model";
        setActiveModel(selected);
        break;
      case "adopt":
        setActiveModel(selected);
        break;
    }
    updateFooter(state, ctx);
  });

  pi.on("thinking_level_select", (event) => {
    observeThinkingSelect(route, event);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await restoreRoute(ctx);
  });

  // Three commands, not nine. The footer (mode + current route) and the ctrl+e widget
  // (per-agent live state) already answer "what is happening now" continuously, so the
  // commands that restated them were worse copies of ambient UI. What remains is one
  // command per question that the always-on surfaces cannot answer: how is it
  // configured, what has it done, and change the mode.
  pi.registerCommand("fission-routing", {
    description: "Show what routing has done: lifetime totals, then recent sessions and why each switched",
    handler: async (_args, ctx) => report(ctx, formatRoutingLog(await readRoutingEntries(configPath))),
  });
  pi.registerCommand("fission-mode", {
    description: "Show or set automatic routing mode (off, shadow, active)",
    handler: async (args, ctx) => {
      if (state.config.status !== "ready") {
        report(ctx, "fission mode: setup required · run /fission-setup", "warning");
        return;
      }
      const requested = words(args)[0];
      if (!requested) {
        report(ctx, `fission mode: ${state.config.config.mode}`);
        return;
      }
      if (requested !== "off" && requested !== "shadow" && requested !== "active") {
        report(ctx, "fission mode: must be off, shadow, or active", "warning");
        return;
      }
      if (requested === "active" && (!state.setup || !isActiveReady({ ...state.config.config, mode: "active" }, state.setup))) {
        report(ctx, "fission mode: active blocked · run /fission-setup", "warning");
        return;
      }
      const updated = { ...state.config.config, mode: requested } as FissionConfig;
      await saveConfig(configPath, updated);
      state.config = { status: "ready", path: configPath, config: updated, diagnostics: [] };
      route.manual = false;
      state.routingStatus = "idle";
      state.routingReason = null;
      updateFooter(state, ctx);
      report(ctx, `fission mode: ${requested}`);
    },
  });
  pi.registerCommand("fission-setup", {
    description: "Show the seven profile mappings and their validity; `probe` or `profile=group` to re-verify",
    handler: async (args, ctx) => {
      // Showing is the common case and is free; probing makes seven real inference calls,
      // so it happens only when asked for explicitly.
      const requested = args.trim();
      if (requested === "") {
        report(ctx, formatSetupTable(asView(state)));
        return;
      }
      const parsed = setupMappings(requested === "probe" ? "" : requested);
      if (parsed.error) {
        report(ctx, `fission setup: ${parsed.error}`, "warning");
        return;
      }
      if (state.config.status === "invalid-config") {
        report(ctx, `fission setup: refusing to overwrite invalid config · ${state.config.diagnostics.join("; ")}`, "warning");
        return;
      }
      let config = state.config.status === "ready" ? state.config.config : createDefaultConfig();
      config = { ...applyMappings(config, parsed.mappings), mode: "shadow" };
      await saveConfig(configPath, config);
      state.config = { status: "ready", path: configPath, config, diagnostics: [] };
      const discovered = await discoverModels(config, { fetch: options.fetch, env: environment });
      state.discovery = discovered;
      if (discovered.status !== "ready") {
        state.routingStatus = "setup-blocked";
        state.routingReason = discovered.diagnostic;
        updateFooter(state, ctx);
        report(ctx, `fission setup: provider unavailable · ${discovered.diagnostic}`, "warning");
        return;
      }
      const blocked = diagnoseSetup(config, discovered.models).filter((diagnostic) => !diagnostic.ok);
      if (blocked.length > 0) {
        state.routingStatus = "setup-blocked";
        state.routingReason = blocked.map((item) => `${item.profile}: ${item.issues.join(", ")}`).join(" · ");
        updateFooter(state, ctx);
        report(ctx, `fission setup: mapping blocked · ${state.routingReason}`, "warning");
        return;
      }
      const result = await probeAll(config, { fetch: options.fetch, env: environment });
      const nextSetup: SetupState = {
        version: 1,
        complete: result.complete,
        lastProbedAt: new Date().toISOString(),
        probes: result.probes,
        overrideProbes: result.overrideProbes,
      };
      await saveSetupState(configPath, nextSetup);
      state.setup = nextSetup;
      if (!result.complete) {
        state.routingStatus = "setup-blocked";
        state.routingReason = result.failures.join(", ");
        updateFooter(state, ctx);
        report(ctx, `fission setup: blocked · failed profiles ${result.failures.join(", ")}`, "warning");
        return;
      }
      config = { ...config, mode: "active" };
      await saveConfig(configPath, config);
      state.config = { status: "ready", path: configPath, config, diagnostics: [] };
      registerProvider(pi, config, discovered);
      route.manual = false;
      state.routingStatus = "idle";
      state.routingReason = null;
      updateFooter(state, ctx);
      report(ctx, "fission setup: complete · 7/7 profiles passed · automatic routing active");
    },
  });
  if (typeof pi.registerShortcut === "function") {
    // plain ctrl+e: terminal eats alt on ctrl+alt combos, and ctrl+o is pi's builtin tool-expand.
    pi.registerShortcut(Key.ctrl("e"), {
      description: "Toggle the live Pi Fission agents widget",
      handler: (ctx) => toggleWidget(ctx),
    });
  }
}

export default function piFission(pi: ExtensionAPI): void {
  void createFissionExtension(pi).catch((error) => {
    process.stderr.write(`[pi-fission] initialization failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  });
}
