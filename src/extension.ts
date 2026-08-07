import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultConfigPath,
  loadConfig,
  saveConfig,
  telemetryPath,
  defaultSetupStatePath,
  effectiveProfileTarget,
  type ConfigResult,
} from "./config.ts";
import { classify, observeToolPhase } from "./classifier.ts";
import { recommend } from "./policy.ts";
import { discoverModels, type DiscoveredModel, type DiscoveryResult } from "./router.ts";
import {
  footerText,
  formatConfig,
  formatExplain,
  formatHistory,
  formatProposals,
  formatSetup,
  formatStatus,
  formatWorkflow,
  type FusionView,
} from "./presentation.ts";
import {
  createTelemetryRecord,
  mergeUsage,
  sanitizeUsage,
  TelemetryStore,
  type AggregateUsage,
} from "./telemetry.ts";
import { diagnoseSetup, isActiveReady, loadSetupState, probeAll, saveSetupState, type SetupDiagnostic } from "./setup.ts";
import {
  activeWorkflowForRepo,
  approveWorkflow,
  cancelWorkflow,
  createWorkflowState,
  foreignOwnerForRepo,
  pauseWorkflow,
  resumeWorkflow,
  upsertWorkflow,
  type WorkflowState,
} from "./workflow.ts";
import {
  applyProposal,
  buildTuningProposal,
  loadOutcomes,
  loadProposals,
  recordOutcome,
  rollbackProposal,
  saveProposal,
  setProposalStatus,
  type TuningProposal,
} from "./tuning.ts";
import type {
  ActiveModelCategory,
  CanonicalProfile,
  Classification,
  FusionConfig,
  Recommendation,
  RouteOnceReason,
  RouteOnceStatus,
  SetupState,
} from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";

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
  routeOnceArmed: boolean;
  routeOnceStatus: RouteOnceStatus;
  routeOnceReason: RouteOnceReason | null;
  startedAt: number | null;
  usage: AggregateUsage;
  outcome: "success" | "error" | "unknown";
  setup: SetupState | null;
  workflow: WorkflowState | null;
  foreignOwner: boolean;
  proposals: TuningProposal[];
  mode: string;
}

type ActivePiModel = NonNullable<ExtensionContext["model"]>;
type ActiveThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

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
  if (config.mode === "off") return;
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
  return {
    config: state.config,
    discovery: state.discovery,
    classification: state.classification,
    recommendation: state.recommendation,
    activeModel: state.activeModel,
    setup: state.setup,
    workflow: state.workflow,
    foreignOwner: state.foreignOwner,
    proposals: state.proposals,
    mode: state.mode,
    routeOnce: { status: state.routeOnceStatus, reason: state.routeOnceReason },
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

/** Normalize Pi command args (string[] or a single string) to a first arg. */
function firstArg(args: string | string[] | undefined): string | undefined {
  if (Array.isArray(args)) return args[0];
  if (typeof args === "string") return args.trim() || undefined;
  return undefined;
}

export async function createFusionExtension(pi: ExtensionAPI, options: FusionExtensionOptions = {}): Promise<void> {
  const environment = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(environment);
  const configResult = await loadConfig(configPath);
  let discovery: DiscoveryResult | null = null;
  let telemetry: TelemetryStore | null = null;
  let setup: SetupState | null = null;
  let workflow: WorkflowState | null = null;
  let proposals: TuningProposal[] = [];

  if (configResult.status === "ready") {
    discovery = await discoverModels(configResult.config, { fetch: options.fetch, env: environment });
    registerProvider(pi, configResult.config, discovery);
    if (configResult.config.telemetry.enabled) {
      telemetry = (options.telemetryStoreFactory ?? ((path, maxEntries) => new TelemetryStore(path, maxEntries)))(
        telemetryPath(configPath, configResult.config),
        configResult.config.telemetry.maxEntries,
      );
    }
    setup = await loadSetupState(configPath, { fetch: options.fetch });
    try {
      proposals = await loadProposals(configPath);
    } catch {
      proposals = [];
    }
  }

  const state: RuntimeState = {
    config: configResult,
    discovery,
    classification: null,
    recommendation: null,
    activeModel: null,
    activeModelCategory: "unknown",
    routeOnceArmed: false,
    routeOnceStatus: "shadow",
    routeOnceReason: null,
    startedAt: null,
    usage: {},
    outcome: "unknown",
    setup,
    workflow,
    foreignOwner: false,
    proposals,
    mode: configResult.status === "ready" ? configResult.config.mode : "invalid",
  };
  const clock = options.now ?? Date.now;
  const stderr = options.stderr ?? ((message: string) => process.stderr.write(message));
  let restoreModel: ActivePiModel | null = null;
  let routeOnceActive = false;
  let routeChangedModel = false;
  let deferTelemetryUntilSettled = false;
  let expectedInternalSelection: ModelIdentity | null = null;
  let restorationInProgress = false;
  let restorationPromise: Promise<void> | null = null;
  let userSelectionDuringRestore: ActivePiModel | null = null;
  let restoreThinkingLevel: ActiveThinkingLevel | null = null;
  let userThinkingLevel: ActiveThinkingLevel | null = null;
  let expectedInternalThinkingLevel: ActiveThinkingLevel | null = null;
  let activeInternalThinkingStart: ActiveThinkingLevel | null = null;
  let activeInternalThinkingObserved = false;
  let routeSelectionInProgress = false;
  let pendingInternalThinkingTransitions: Array<{
    model: ModelIdentity;
    previousLevel: ActiveThinkingLevel;
    level: ActiveThinkingLevel;
  }> = [];
  /** When the user explicitly overrides the model, auto-routing pauses until they rearm. */
  let userOverrideActive = false;

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
      overrideTargets: workflowTargets(),
    });
  };

  const workflowTargets = (): Partial<Record<CanonicalProfile, string>> | undefined => {
    if (state.config.status !== "ready" || !workflow) return undefined;
    const overrides: Partial<Record<CanonicalProfile, string>> = {};
    for (const profile of CANONICAL_PROFILES) {
      const target = effectiveProfileTarget(state.config.config, profile, workflow.repo);
      if (target !== state.config.config.profiles[profile].modelId) overrides[profile] = target;
    }
    return Object.keys(overrides).length ? overrides : undefined;
  };

  const persist = async (): Promise<void> => {
    if (!telemetry || !state.classification || !state.recommendation) return;
    const durationMs = state.startedAt === null ? null : Math.max(0, clock() - state.startedAt);
    const record = createTelemetryRecord({
      classification: state.classification,
      recommendation: state.recommendation,
      activeModelCategory: state.activeModelCategory,
      routeOnceStatus: state.routeOnceStatus,
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

  const takeUserSelectionDuringRestore = (): ActivePiModel | null => {
    const selected = userSelectionDuringRestore;
    userSelectionDuringRestore = null;
    return selected;
  };

  const readThinkingLevel = (ctx?: ExtensionContext): ActiveThinkingLevel | null => {
    if (ctx?.thinkingLevel) return ctx.thinkingLevel;
    try {
      return pi.getThinkingLevel();
    } catch {
      return null;
    }
  };

  const selectInternalModel = async (model: ActivePiModel): Promise<boolean> => {
    activeInternalThinkingStart = readThinkingLevel();
    activeInternalThinkingObserved = false;
    try {
      return await pi.setModel(model);
    } finally {
      const transitionStart = activeInternalThinkingStart;
      const after = readThinkingLevel();
      if (transitionStart && after && transitionStart !== after && !activeInternalThinkingObserved) {
        pendingInternalThinkingTransitions.push({
          model: { provider: model.provider, id: model.id },
          previousLevel: transitionStart,
          level: after,
        });
      }
      activeInternalThinkingStart = null;
      activeInternalThinkingObserved = false;
    }
  };

  const applyInternalThinkingLevel = async (level: ActiveThinkingLevel): Promise<boolean> => {
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

  const restoreOneShot = async (ctx: ExtensionContext): Promise<void> => {
    if (restorationPromise) return restorationPromise;
    if (!routeOnceActive) return;

    restorationPromise = (async () => {
      const previous = restoreModel;
      const originalThinking = restoreThinkingLevel;
      let modelReady = false;
      if (previous && routeChangedModel) {
        restorationInProgress = true;
        userSelectionDuringRestore = null;
        expectedInternalSelection = { provider: previous.provider, id: previous.id };
        let restored = false;
        try {
          restored = await selectInternalModel(previous);
        } catch {
          restored = false;
        }
        expectedInternalSelection = null;

        let userSelection = takeUserSelectionDuringRestore();
        while (userSelection) {
          expectedInternalSelection = { provider: userSelection.provider, id: userSelection.id };
          let retained = false;
          try {
            retained = await selectInternalModel(userSelection);
          } catch {
            retained = false;
          }
          expectedInternalSelection = null;
          if (!retained) {
            restored = false;
            state.routeOnceStatus = "restore-failed";
            state.routeOnceReason = "restore-failed";
            break;
          }
          restored = true;
          state.routeOnceStatus = "user-overrode";
          state.routeOnceReason = "user-selected-model";
          setActiveModel({ provider: userSelection.provider, id: userSelection.id });
          userSelection = takeUserSelectionDuringRestore();
        }
        restorationInProgress = false;

        if (state.routeOnceStatus !== "user-overrode" && state.routeOnceStatus !== "restore-failed") {
          if (restored) {
            state.routeOnceStatus = "restored";
            state.routeOnceReason = null;
            setActiveModel({ provider: previous.provider, id: previous.id });
          } else {
            state.routeOnceStatus = "restore-failed";
            state.routeOnceReason = "restore-failed";
          }
        }
        modelReady = restored;
      } else if (previous) {
        state.routeOnceStatus = "restored";
        state.routeOnceReason = null;
        setActiveModel({ provider: previous.provider, id: previous.id });
        modelReady = true;
      } else if (state.routeOnceStatus === "user-overrode") {
        modelReady = true;
      }

      if (modelReady && state.routeOnceStatus !== "restore-failed") {
        const desiredThinking = userThinkingLevel ?? originalThinking;
        if (desiredThinking && !(await applyInternalThinkingLevel(desiredThinking))) {
          state.routeOnceStatus = "restore-failed";
          state.routeOnceReason = "restore-failed";
        }
      }

      routeOnceActive = false;
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

    try {
      await restorationPromise;
    } finally {
      restorationPromise = null;
    }
    updateFooter(state, ctx);
  };

  const finishOneShot = async (ctx: ExtensionContext): Promise<void> => {
    await restoreOneShot(ctx);
    if (deferTelemetryUntilSettled) {
      deferTelemetryUntilSettled = false;
      await persist();
    }
    updateFooter(state, ctx);
  };

  /** Full-product: create a managed workflow for a coding question (or none for read-only). */
  const ensureWorkflow = async (ctx: ExtensionContext): Promise<void> => {
    if (state.config.status !== "ready" || !state.classification) return;
    if (state.classification.mutationIntent !== "mutation") {
      workflow = null;
      state.workflow = null;
      return;
    }
    if (workflow && (workflow.status === "running" || workflow.status === "awaiting-approval" || workflow.status === "paused")) return;
    const repo = ctx.cwd;
    const foreign = await foreignOwnerForRepo(repo, getSessionId(ctx));
    state.foreignOwner = foreign !== null;
    const existing = await activeWorkflowForRepo(repo, getSessionId(ctx));
    if (existing) {
      workflow = existing;
      state.workflow = existing;
      return;
    }
    workflow = createWorkflowState({
      repo,
      adapter: "session",
      flickerTicketId: null,
      classification: state.classification,
      mode: state.config.config.mode,
      ownerSession: getSessionId(ctx),
      ownerPid: process.pid,
    });
    state.workflow = workflow;
    await upsertWorkflow(workflow);
  };

  const getSessionId = (ctx: ExtensionContext): string => {
    try {
      const session = ctx.sessionManager as { getSessionId?: () => string };
      return session.getSessionId?.() ?? "unknown-session";
    } catch {
      return "unknown-session";
    }
  };

  pi.on("session_start", (_event, ctx) => {
    setActiveModel(modelIdentity(ctx));
    updateFooter(state, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await finishOneShot(ctx);
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-fusion", undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    setActiveModel(modelIdentity(ctx));
    state.classification = classify({ text: event.prompt, imageCount: event.images?.length ?? 0 });
    state.startedAt = clock();
    state.usage = {};
    state.outcome = "unknown";
    reroute();

    const config = state.config;
    const activeMode = config.status === "ready" && config.config.mode === "active";
    const ready = activeMode && setup !== null && isActiveReady(config.config, setup);

    if (activeMode && !ready) {
      updateFooter(state, ctx);
      return;
    }

    // Full-product workflow lifecycle only applies in active mode; shadow and
    // one-shot keep the observed routing path and never create workflow state.
    if (activeMode) {
      await ensureWorkflow(ctx);
      if (state.workflow && state.workflow.status === "awaiting-approval") {
        state.workflow = await persistWorkflowState();
        updateFooter(state, ctx);
        return;
      }
    } else {
      workflow = null;
      state.workflow = null;
      state.foreignOwner = false;
    }

    // Auto-routing in active mode: route mutation work once the plan is approved,
    // and read-only work directly, unless the user explicitly overrode the model.
    const shouldAutoRoute = activeMode && !userOverrideActive && state.recommendation?.profile && state.recommendation.modelId;
    const armed = state.routeOnceArmed || shouldAutoRoute;

    if (!armed) {
      if (!routeOnceActive && !deferTelemetryUntilSettled) {
        state.routeOnceStatus = "shadow";
        state.routeOnceReason = null;
      }
      updateFooter(state, ctx);
      return;
    }

    // Consume before any selection attempt so a failure cannot route a later surprise request.
    state.routeOnceArmed = false;
    state.routeOnceStatus = "skipped";
    state.routeOnceReason = null;

    if (state.config.status !== "ready" || state.discovery?.status !== "ready") {
      state.routeOnceReason = "provider-unavailable";
      updateFooter(state, ctx);
      return;
    }
    if (!state.recommendation?.profile || !state.recommendation.modelId) {
      state.routeOnceReason = "no-recommendation";
      updateFooter(state, ctx);
      return;
    }

    const target = ctx.modelRegistry.find(state.config.config.provider.id, state.recommendation.modelId);
    if (!target) {
      state.routeOnceReason = "model-not-found";
      updateFooter(state, ctx);
      return;
    }
    const previous = ctx.model;
    if (!previous) {
      state.routeOnceReason = "current-model-missing";
      updateFooter(state, ctx);
      return;
    }
    if (previous.provider === target.provider && previous.id === target.id) {
      restoreModel = previous;
      routeOnceActive = true;
      routeChangedModel = false;
      deferTelemetryUntilSettled = true;
      state.routeOnceStatus = "applied";
      state.routeOnceReason = "already-selected";
      setActiveModel({ provider: target.provider, id: target.id });
      updateFooter(state, ctx);
      return;
    }

    const previousThinking = readThinkingLevel(ctx);
    restoreThinkingLevel = previousThinking;
    userThinkingLevel = null;
    routeSelectionInProgress = true;
    expectedInternalSelection = { provider: target.provider, id: target.id };
    let selected = false;
    try {
      selected = await selectInternalModel(target);
    } catch {
      routeSelectionInProgress = false;
      expectedInternalSelection = null;
      if (!userThinkingLevel && previousThinking && readThinkingLevel() !== previousThinking) {
        await applyInternalThinkingLevel(previousThinking);
      }
      restoreThinkingLevel = null;
      userThinkingLevel = null;
      pendingInternalThinkingTransitions = [];
      state.routeOnceReason = "selection-error";
      updateFooter(state, ctx);
      return;
    }
    routeSelectionInProgress = false;
    if (!selected) {
      expectedInternalSelection = null;
      if (!userThinkingLevel && previousThinking && readThinkingLevel() !== previousThinking) {
        await applyInternalThinkingLevel(previousThinking);
      }
      restoreThinkingLevel = null;
      userThinkingLevel = null;
      pendingInternalThinkingTransitions = [];
      state.routeOnceReason = "selection-failed";
      updateFooter(state, ctx);
      return;
    }

    restoreModel = previous;
    routeOnceActive = true;
    routeChangedModel = true;
    deferTelemetryUntilSettled = true;
    state.routeOnceStatus = "applied";
    setActiveModel({ provider: target.provider, id: target.id });
    updateFooter(state, ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    if (state.classification) {
      state.classification = observeToolPhase(state.classification, event.toolName);
      reroute();
    }
    state.usage = mergeUsage(state.usage, sanitizeUsage(event.usage));
    if (event.isError) state.outcome = "error";
    updateFooter(state, ctx);
  });

  pi.on("after_provider_response", (event) => {
    if (event.status >= 400) state.outcome = "error";
  });

  pi.on("turn_end", async (event, ctx) => {
    const messageUsage = (event.message as { usage?: unknown }).usage;
    state.usage = mergeUsage(state.usage, sanitizeUsage(messageUsage));
    if (state.outcome === "unknown") state.outcome = "success";
    setActiveModel(modelIdentity(ctx));
    if (!deferTelemetryUntilSettled) await persist();
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
      state.routeOnceStatus = "user-overrode";
      state.routeOnceReason = "user-selected-model";
    } else if (routeOnceActive) {
      restoreModel = null;
      routeChangedModel = false;
      state.routeOnceStatus = "user-overrode";
      state.routeOnceReason = "user-selected-model";
      userOverrideActive = true;
    }
    setActiveModel(selected);
    updateFooter(state, ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const currentModel = modelIdentity(ctx);
    const currentThinking = readThinkingLevel();
    const expectedTargetIsCurrent = expectedInternalSelection !== null
      && currentModel?.provider === expectedInternalSelection.provider
      && currentModel.id === expectedInternalSelection.id;
    const internalExplicit = expectedInternalThinkingLevel === event.level;
    const activeInternalClamp = expectedTargetIsCurrent
      && activeInternalThinkingStart === event.previousLevel
      && currentThinking === event.level
      && !activeInternalThinkingObserved;
    const pendingIndex = pendingInternalThinkingTransitions.findIndex((transition) =>
      currentModel?.provider === transition.model.provider
      && currentModel.id === transition.model.id
      && transition.previousLevel === event.previousLevel
      && transition.level === event.level
      && currentThinking === event.level);
    if (internalExplicit) {
      expectedInternalThinkingLevel = null;
    } else if (activeInternalClamp) {
      activeInternalThinkingObserved = true;
    } else if (pendingIndex >= 0) {
      pendingInternalThinkingTransitions.splice(pendingIndex, 1);
    } else if (routeSelectionInProgress || routeOnceActive || restorationInProgress) {
      userThinkingLevel = event.level;
      if (routeSelectionInProgress && !expectedTargetIsCurrent) {
        activeInternalThinkingStart = event.level;
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await finishOneShot(ctx);
  });

  const persistWorkflowState = async (): Promise<WorkflowState | null> => {
    if (!workflow) return null;
    await upsertWorkflow(workflow);
    return workflow;
  };

  const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" = healthLevel(state)): void => show(ctx, message, level, stderr);

  pi.registerCommand("fusion-route-once", {
    description: "Route exactly the next task through an eligible Pi Fusion recommendation",
    handler: async (_args, ctx) => {
      userOverrideActive = false;
      if (state.routeOnceArmed || routeOnceActive || deferTelemetryUntilSettled) {
        report(ctx, `fusion: one-shot ${state.routeOnceArmed ? "already armed" : "already active"} · no additional route queued`);
        return;
      }
      state.routeOnceArmed = true;
      state.routeOnceStatus = "armed";
      state.routeOnceReason = null;
      setActiveModel(modelIdentity(ctx));
      updateFooter(state, ctx);
      report(ctx, "fusion: one-shot armed · exactly the next task will route if eligible");
    },
  });
  pi.registerCommand("fusion-mode", {
    description: "Show or set the Fusion mode (off, shadow, active)",
    handler: async (args, ctx) => {
      if (state.config.status !== "ready") {
        report(ctx, "fusion mode: unconfigured · run /fusion-setup");
        return;
      }
      const requested = firstArg(args);
      if (!requested) {
        report(ctx, `fusion mode: ${state.config.config.mode}`);
        return;
      }
      if (!["off", "shadow", "active"].includes(requested)) {
        report(ctx, "fusion mode: must be off, shadow, or active", "warning");
        return;
      }
      if (requested === "active") {
        const setupReady = isActiveReady(
          { ...state.config.config, mode: "active" },
          setup ?? { version: 1, complete: false, lastProbedAt: null, probes: {} },
        );
        if (!setupReady) {
          report(ctx, "fusion mode: active blocked · setup incomplete · run /fusion-setup", "warning");
          return;
        }
      }
      const updated = { ...state.config.config, mode: requested as FusionConfig["mode"] };
      await saveConfig(state.config.path, updated);
      state.config = { status: "ready", path: state.config.path, config: updated, diagnostics: [] };
      state.mode = requested;
      report(ctx, `fusion mode: ${requested}`);
    },
  });
  pi.registerCommand("fusion-setup", {
    description: "Probe all seven profiles and gate active readiness",
    handler: async (_args, ctx) => {
      if (state.config.status !== "ready" || !state.discovery) {
        report(ctx, "fusion setup: unavailable · no ready configuration/discovery", "warning");
        return;
      }
      const config = state.config.config;
      const diagnostics: SetupDiagnostic[] = diagnoseSetup(config, state.discovery.models);
      const blocked = diagnostics.filter((item) => !item.ok);
      if (blocked.length > 0) {
        const lines = blocked.map((item) => `  ${item.profile}: ${item.issues.join(", ")}`);
        report(ctx, `fusion setup: mapping blocked\n${lines.join("\n")}`, "warning");
        return;
      }
      const { probes, complete, failures } = await probeAll(config, { fetch: options.fetch, env: environment });
      const nextSetup: SetupState = {
        version: 1,
        complete,
        lastProbedAt: new Date().toISOString(),
        probes,
      };
      await saveSetupState(configPath, nextSetup);
      setup = nextSetup;
      state.setup = nextSetup;
      if (complete) {
        report(ctx, `fusion setup: complete · all seven profiles probed · mode ${config.mode}${isActiveReady(config, nextSetup) ? " · active ready" : ""}`);
      } else {
        const lines = failures.map((profile) => `  ${profile}: ${probes[profile]?.error ?? "failed"}`);
        report(ctx, `fusion setup: incomplete · ${failures.length} failing\n${lines.join("\n")}`, "warning");
      }
    },
  });
  pi.registerCommand("fusion-plan", {
    description: "Approve the current workflow plan (enables mutation execution)",
    handler: async (_args, ctx) => {
      if (!workflow || workflow.status !== "awaiting-approval") {
        report(ctx, "fusion plan: no workflow awaiting approval", "warning");
        return;
      }
      const config = state.config.status === "ready" ? state.config.config : null;
      workflow = approveWorkflow(workflow, {
        scope: workflow.nodes.map((node) => node.kind).join(" -> "),
        acceptance: ["contract-defined"],
        worktree: workflow.repo,
        writer: `writer-${workflow.id.slice(0, 8)}`,
        authority: ["local-commit"],
        profile: state.recommendation?.profile ?? null,
        maxFanout: config?.tuning.maxFanout ?? 4,
        maxDepth: config?.tuning.maxDepth ?? 2,
        maxRetries: config?.tuning.maxRetries ?? 3,
        maxSwitches: config?.tuning.maxSwitches ?? 4,
        budgetTokens: null,
      });
      state.workflow = workflow;
      await persistWorkflowState();
      userOverrideActive = false;
      report(ctx, `fusion plan: approved · envelope v${workflow.envelope?.version} · running`);
    },
  });
  pi.registerCommand("fusion-workflow", {
    description: "Show the active managed workflow graph",
    handler: async (_args, ctx) => report(ctx, formatWorkflow(state.workflow)),
  });
  pi.registerCommand("fusion-pause", {
    description: "Pause the active workflow",
    handler: async (_args, ctx) => {
      if (!workflow) { report(ctx, "fusion pause: no active workflow", "warning"); return; }
      workflow = pauseWorkflow(workflow);
      state.workflow = workflow;
      await persistWorkflowState();
      report(ctx, "fusion pause: workflow paused");
    },
  });
  pi.registerCommand("fusion-resume", {
    description: "Resume a paused workflow",
    handler: async (_args, ctx) => {
      if (!workflow) { report(ctx, "fusion resume: no active workflow", "warning"); return; }
      workflow = resumeWorkflow(workflow);
      state.workflow = workflow;
      await persistWorkflowState();
      report(ctx, "fusion resume: workflow resumed");
    },
  });
  pi.registerCommand("fusion-cancel", {
    description: "Cancel the active workflow",
    handler: async (_args, ctx) => {
      if (!workflow) { report(ctx, "fusion cancel: no active workflow", "warning"); return; }
      workflow = cancelWorkflow(workflow);
      state.workflow = workflow;
      await persistWorkflowState();
      report(ctx, "fusion cancel: workflow cancelled");
    },
  });
  pi.registerCommand("fusion-tune-propose", {
    description: "Build a permission-gated tuning proposal from outcomes",
    handler: async (_args, ctx) => {
      if (state.config.status !== "ready") { report(ctx, "fusion tune: unconfigured", "warning"); return; }
      const outcomes = await loadOutcomes(state.config.config, configPath);
      const proposal = buildTuningProposal({
        config: state.config.config,
        outcomes,
        description: "Automatic proposal from measured outcomes",
        kind: "circuit-breaker",
        diff: { note: "proposal-only; no policy change without approval" },
        expectedImpact: "See evidence sample before approving",
        scope: "global",
      });
      if (!proposal) {
        report(ctx, `fusion tune: insufficient evidence (${outcomes.length} < ${state.config.config.tuning.minEvidence})`, "warning");
        return;
      }
      await saveProposal(proposal, configPath);
      state.proposals = await loadProposals(configPath);
      report(ctx, `fusion tune: proposal ${proposal.id.slice(0, 8)} created · approve with /fusion-tune-approve ${proposal.id.slice(0, 8)}`);
    },
  });
  pi.registerCommand("fusion-tune-approve", {
    description: "Approve a tuning proposal (applies to future workflows only)",
    handler: async (args, ctx) => {
      const id = firstArg(args);
      const proposals = await loadProposals(configPath);
      const proposal = id
        ? proposals.find((item) => item.id.startsWith(id) && item.status === "proposed")
        : undefined;
      if (!proposal) { report(ctx, "fusion tune: no proposed proposal matches (pass an id)", "warning"); return; }
      const applied = await applyProposal(proposal, configPath);
      state.proposals = await loadProposals(configPath);
      report(ctx, `fusion tune: approved · applied to future workflows · rollback /fusion-tune-rollback ${applied.id.slice(0, 8)}`);
    },
  });
  pi.registerCommand("fusion-tune-deny", {
    description: "Deny a tuning proposal",
    handler: async (args, ctx) => {
      const id = firstArg(args);
      const proposals = await loadProposals(configPath);
      const proposal = id
        ? proposals.find((item) => item.id.startsWith(id) && item.status === "proposed")
        : undefined;
      if (!proposal) { report(ctx, "fusion tune: no proposed proposal matches (pass an id)", "warning"); return; }
      await setProposalStatus({ ...proposal, status: "denied" as const }, "denied", configPath);
      state.proposals = await loadProposals(configPath);
      report(ctx, "fusion tune: denied");
    },
  });
  pi.registerCommand("fusion-tune-rollback", {
    description: "Roll back an applied tuning proposal",
    handler: async (args, ctx) => {
      const id = firstArg(args);
      const proposals = await loadProposals(configPath);
      const proposal = id
        ? proposals.find((item) => item.id.startsWith(id) && item.status === "applied")
        : undefined;
      if (!proposal) { report(ctx, "fusion tune: no applied proposal matches (pass an id)", "warning"); return; }
      const rolled = await rollbackProposal(proposal, configPath);
      state.proposals = await loadProposals(configPath);
      report(ctx, `fusion tune: rolled back · ${rolled.id.slice(0, 8)}`);
    },
  });
  pi.registerCommand("fusion-proposals", {
    description: "List tuning proposals",
    handler: async (_args, ctx) => report(ctx, formatProposals(state.proposals)),
  });
  pi.registerCommand("fusion-setup-status", {
    description: "Show setup readiness and probe results",
    handler: async (_args, ctx) => report(ctx, formatSetup(asView(state))),
  });
  pi.registerCommand("fusion-status", {
    description: "Show Pi Fusion mode, setup, workflow, and routing health",
    handler: async (_args, ctx) => report(ctx, formatStatus(asView(state))),
  });
  pi.registerCommand("fusion-explain", {
    description: "Explain the current recommendation and route state",
    handler: async (_args, ctx) => report(ctx, formatExplain(asView(state))),
  });
  pi.registerCommand("fusion-history", {
    description: "Show recent content-free routing and workflow decisions",
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
