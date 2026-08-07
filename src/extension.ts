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
import { workflowStorePath } from "./workflow.ts";
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
import { resolveFlickerProject, createPlanningTicket, syncFlickerStatus, writeFlickerDocument } from "./flicker-adapter.ts";
import {
  activeWorkflowForRepo,
  advanceWorkflow,
  approveWorkflow,
  cancelWorkflow,
  createWorkflowState,
  foreignOwnerForRepo,
  pauseWorkflow,
  resumeWorkflow,
  retryBlockedWorkflow,
  reopenWorkflowAt,
  runningNode,
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
import type { WorkflowNode } from "./types.ts";
import { decideBackend, nodeAgentName, delegateV2 } from "./execution.ts";
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

const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "web_search", "source_check", "fetch_content", "get_search_content",
]);
const WRITER_TOOLS = new Set([...READ_ONLY_TOOLS, "bash", "edit", "write"]);
const WRITER_NODE_KINDS = new Set(["implement", "regression"]);
const GATED_SHELL_ACTION = /(?:\bgit\s+(?:push|merge|reset\s+--hard|clean\s+-[^\s]*f)|\bgh\s+(?:pr\s+(?:create|merge)|release)|\b(?:npm|pnpm)\s+publish|\byarn\s+npm\s+publish|\bmix\s+hex\.publish|\b(?:fly|flicker)\s+deploy|\bdocker\s+push|\bkubectl\s+(?:apply|delete|rollout\s+restart)|\bhelm\s+(?:install|upgrade|uninstall)|\bterraform\s+(?:apply|destroy)|\brm\s+-[^\s]*r[^\s]*f|\bflicker\s+ticket\s+complete)\b/i;

function flickerTaskContractBody(workflow: WorkflowState): string {
  const sequence = workflow.nodes.map((node) => node.kind).join(" → ");
  return `## Goal\n\nExecute the approved Pi Fusion workflow \`${workflow.id}\` through local acceptance.\n\n## Scope and non-goals\n\nIn scope: ${sequence}. Non-goals: push, PR, merge, deploy, publish, release, and destructive actions without separate authority.\n\n## Affected surfaces and invariants\n\nRepository: \`${workflow.repo}\`. One writer: \`${workflow.envelope?.writer ?? "unassigned"}\`. Repository mutation requires this approved envelope; remote and release authority are absent.\n\n## Implementation sequence\n\n${workflow.nodes.map((node, index) => `${index + 1}. ${node.kind} via ${node.profile ?? "unassigned"}`).join("\n")}\n\n## Acceptance matrix\n\n| ID | Observable behavior | Verification | Expected result | Risk | Negative/error case |\n|---|---|---|---|---|---|\n| FUSION-WF | All graph nodes produce current evidence | Inspect workflow evidence and local Git state | Every required node passes; ticket remains in_progress without release authority | High | Missing evidence, provider failure, or stale downstream proof blocks |\n\n## Test strategy and fixtures\n\nUse node-specific tool evidence and a real local repository surface; regression must record successful verification-tool evidence.\n\n## Compatibility, rollback, and risk\n\nRetry/reopen is bounded by envelope v${workflow.envelope?.version ?? 0}; downstream evidence is invalidated when an upstream node reopens. Local Git history is the rollback surface.\n\n## Intentionally not done\n\nNo push, PR, merge, deploy, publish, release, or ticket completion.\n`;
}

function flickerImplementationNotesBody(workflow: WorkflowState): string {
  return `## Workflow\n\n- Workflow: \`${workflow.id}\`\n- Approval envelope: v${workflow.envelope?.version ?? 0}\n- Writer: \`${workflow.envelope?.writer ?? "unassigned"}\`\n- Worktree: \`${workflow.envelope?.worktree ?? workflow.repo}\`\n- Authority: ${(workflow.envelope?.authority ?? []).join(", ") || "none"}\n\n## Node evidence\n\n${workflow.nodes.map((node) => `- ${node.kind} (${node.profile ?? "unassigned"}): ${node.status}; evidence: ${node.evidence.join(", ") || "none"}${node.error ? `; error: ${node.error}` : ""}`).join("\n")}\n\n## Commands and changed files\n\nFusion intentionally does not retain raw command text, raw tool output, prompts, or code in its local telemetry. Exact command text and changed-file names must be supplied by the repository/test harness when required; this projection records only allow-listed tool evidence.\n\n## Result\n\nLocal workflow status: **${workflow.status}**. The Flicker ticket remains **in_progress** because local completion is release readiness, not merged release completion.\n\n## Residual risk and intentionally not done\n\nNo remote, merge, deploy, publish, release, destructive action, or ticket completion was authorized or performed.\n`;
}

function toolBlockReason(options: {
  activeMode: boolean;
  ready: boolean;
  classification: Classification | null;
  workflow: WorkflowState | null;
  toolName: string;
  input: unknown;
}): string | null {
  if (!options.activeMode) return null;
  const managedMutation = options.classification?.mutationIntent === "mutation" || options.workflow !== null;
  if (!managedMutation || READ_ONLY_TOOLS.has(options.toolName)) return null;
  if (!options.ready) return "Pi Fusion active setup is not ready; mutating tools are blocked";
  if (!options.workflow) return "Pi Fusion has no approved workflow; mutating tools are blocked";
  if (options.workflow.status === "awaiting-approval") return "Approve the Pi Fusion plan before repository mutation";
  if (options.workflow.status !== "running") return `Pi Fusion workflow is ${options.workflow.status}; mutating tools are blocked`;

  const node = runningNode(options.workflow);
  if (!node || !WRITER_NODE_KINDS.has(node.kind)) {
    return `Pi Fusion ${node?.kind ?? "unknown"} node is read-only; mutating tools are blocked`;
  }
  if (!WRITER_TOOLS.has(options.toolName)) {
    return `Tool ${options.toolName} is outside the approved writer tool set`;
  }
  if (options.toolName === "bash") {
    const command = typeof options.input === "object" && options.input !== null && "command" in options.input
      ? String((options.input as { command?: unknown }).command ?? "")
      : "";
    if (GATED_SHELL_ACTION.test(command)) {
      return "Remote, release, destructive, and completion actions require separate explicit authority";
    }
  }
  return null;
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
  const storePath = workflowStorePath(configPath);
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
  /** Allow-listed, content-free tool evidence collected for the current node turn. */
  let turnEvidence = new Set<string>();

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
      // In active mode with an approved workflow, the running node's semantic
      // profile wins so each stage uses its intended model.
      forceProfile: activeWorkflowNodeProfile(),
    });
  };

  const activeWorkflowNodeProfile = (): CanonicalProfile | null => {
    if (state.config.status !== "ready" || state.config.config.mode !== "active") return null;
    if (!workflow || workflow.status !== "running") return null;
    const node = runningNode(workflow);
    return node?.profile ?? null;
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
      // A read-only continuation must not discard an already approved workflow.
      // It can advance the current read-only node while preserving the same
      // session ownership and approval envelope.
      if (workflow && (workflow.status === "running" || workflow.status === "awaiting-approval" || workflow.status === "paused" || workflow.status === "blocked" || workflow.status === "recovered")) {
        state.workflow = workflow;
        return;
      }
      workflow = null;
      state.workflow = null;
      return;
    }
    if (workflow && (workflow.status === "running" || workflow.status === "awaiting-approval" || workflow.status === "paused" || workflow.status === "blocked" || workflow.status === "recovered")) return;
    const repo = ctx.cwd;
    const foreign = await foreignOwnerForRepo(repo, getSessionId(ctx), storePath);
    state.foreignOwner = foreign !== null;
    const existing = await activeWorkflowForRepo(repo, getSessionId(ctx), storePath);
    if (existing) {
      workflow = existing;
      state.workflow = existing;
      return;
    }
    // Flicker adapter selection: when the repository resolves a Flicker project,
    // the workflow is projected into Flicker truth (planning ticket + docs are
    // the plan itself and are permitted before mutation approval).
    let adapter: "session" | "flicker" = "session";
    let flickerTicketId: string | null = null;
    try {
      const resolution = await resolveFlickerProject(repo, { env: environment });
      if (resolution.ok && resolution.projectSlug) {
        adapter = "flicker";
        const ticket = await createPlanningTicket(
          repo,
          "Pi Fusion managed workflow",
          `Managed by Pi Fusion for ${repo}. Planning documents and evidence are projected into Flicker.`,
          { env: environment },
        );
        flickerTicketId = ticket.ok ? ticket.ticketId : null;
      }
    } catch {
      // Flicker unavailable is non-fatal; the workflow stays session-adapter.
    }
    workflow = createWorkflowState({
      repo,
      adapter,
      flickerTicketId,
      classification: state.classification,
      mode: state.config.config.mode,
      ownerSession: getSessionId(ctx),
      ownerPid: process.pid,
    });
    state.workflow = workflow;
    await upsertWorkflow(workflow, storePath);
  };

  const getSessionId = (ctx: ExtensionContext): string => {
    try {
      const session = ctx.sessionManager as { getSessionId?: () => string };
      return session.getSessionId?.() ?? "unknown-session";
    } catch {
      return "unknown-session";
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    setActiveModel(modelIdentity(ctx));
    const ownerSession = getSessionId(ctx);
    workflow = await activeWorkflowForRepo(ctx.cwd, ownerSession, storePath);
    state.workflow = workflow;
    state.foreignOwner = (await foreignOwnerForRepo(ctx.cwd, ownerSession, storePath)) !== null;
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
    turnEvidence = new Set<string>();
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
    if (event.isError) {
      state.outcome = "error";
    } else if (["read", "bash", "edit", "write"].includes(event.toolName)) {
      turnEvidence.add(`tool:${event.toolName}:ok`);
    }
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

  pi.on("tool_call", async (event) => {
    const config = state.config;
    const activeMode = config.status === "ready" && config.config.mode === "active";
    const ready = activeMode && setup !== null && isActiveReady(config.config, setup);
    const reason = toolBlockReason({
      activeMode,
      ready,
      classification: state.classification,
      workflow,
      toolName: event.toolName,
      input: event.input,
    });
    if (reason) return { block: true, reason, terminate: true };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Capture the settled outcome BEFORE finishOneShot: persist() resets
    // state.outcome to "unknown", so evaluating it afterwards would always
    // report "passed" and never fail/block a node.
    const settledOutcome = state.outcome;
    await finishOneShot(ctx);
    // Active workflow: a settled run completes the running node (or marks it
    // failed on error) and advances the graph to the next stage.
    if (state.config.status === "ready" && state.config.config.mode === "active" && workflow && workflow.status === "running") {
      const node = runningNode(workflow);
      if (node) {
        if (turnEvidence.size > 0) {
          workflow = {
            ...workflow,
            nodes: workflow.nodes.map((item) => item.id === node.id
              ? { ...item, evidence: [...new Set([...item.evidence, ...turnEvidence])] }
              : item),
          };
        }
        workflow = advanceWorkflow(workflow, node.id, settledOutcome === "error" ? "failed" : "passed", settledOutcome === "error" ? "provider/tool error" : undefined);
        state.workflow = workflow;
        await persistWorkflowState();
      }
      if ((workflow.status === "complete" || workflow.status === "blocked") && workflow.adapter === "flicker" && workflow.flickerTicketId) {
        const sync = await syncFlickerStatus(workflow.flickerTicketId, workflow.status, { env: environment });
        if (!sync.ok) {
          workflow = { ...workflow, status: "blocked", updatedAt: new Date().toISOString() };
          state.workflow = workflow;
          await persistWorkflowState();
        } else if (workflow.status === "complete") {
          const written = await writeFlickerDocument(workflow.flickerTicketId, "implementation_notes", "Pi Fusion implementation evidence", flickerImplementationNotesBody(workflow), { env: environment });
          if (!written.ok) {
            workflow = { ...workflow, status: "blocked", updatedAt: new Date().toISOString() };
            state.workflow = workflow;
            await persistWorkflowState();
          }
        }
      }
      await recordActiveOutcome(node, settledOutcome);
    }
    updateFooter(state, ctx);
  });

  const recordActiveOutcome = async (node: WorkflowNode | null, outcome: "success" | "error" | "unknown"): Promise<void> => {
    if (state.config.status !== "ready" || !state.recommendation) return;
    const config = state.config.config;
    try {
      await recordOutcome(config, {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        workflowId: workflow?.id ?? null,
        nodeKind: node?.kind ?? null,
        profile: state.recommendation.profile,
        backend: "direct",
        routeConfidence: state.recommendation.confidence,
        phase: state.classification?.phase ?? "unknown",
        risk: state.classification?.risk ?? "unknown",
        accepted: outcome !== "error",
        retries: 0,
        switches: 0,
        usage: state.usage,
        failure: outcome === "error" ? "provider/tool error" : null,
        tuningVersion: 0,
      }, configPath);
    } catch {
      // Outcome recording is best-effort and never breaks the session.
    }
  };

  const persistWorkflowState = async (): Promise<WorkflowState | null> => {
    if (!workflow) return null;
    await upsertWorkflow(workflow, storePath);
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
      if (workflow.adapter === "flicker" && workflow.flickerTicketId) {
        const sync = await syncFlickerStatus(workflow.flickerTicketId, workflow.status, { env: environment });
        const written = sync.ok
          ? await writeFlickerDocument(workflow.flickerTicketId, "task_contract", "Pi Fusion task contract", flickerTaskContractBody(workflow), { env: environment })
          : { ok: false, error: sync.error };
        if (!written.ok) {
          workflow = { ...workflow, status: "blocked", updatedAt: new Date().toISOString() };
          state.workflow = workflow;
          await persistWorkflowState();
          report(ctx, `fusion plan: Flicker projection blocked · ${written.error ?? "unknown error"}`, "warning");
          return;
        }
      }
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
    description: "Resume a paused workflow or retry a blocked node within its approved budget",
    handler: async (args, ctx) => {
      if (!workflow) { report(ctx, "fusion resume: no active workflow", "warning"); return; }
      const previousStatus = workflow.status;
      let reopenedKind: WorkflowNode["kind"] | null = null;
      if (previousStatus === "blocked") {
        const maxRetries = workflow.envelope?.maxRetries ?? 0;
        const requested = firstArg(args);
        if (requested && workflow.nodes.some((node) => node.kind === requested)) {
          reopenedKind = requested as WorkflowNode["kind"];
          workflow = reopenWorkflowAt(workflow, reopenedKind, maxRetries);
        } else {
          workflow = retryBlockedWorkflow(workflow, maxRetries);
        }
        if (workflow.status === "blocked") {
          report(ctx, "fusion resume: retry budget exhausted or no matching failed node", "warning");
          return;
        }
      } else {
        workflow = resumeWorkflow(workflow);
      }
      state.workflow = workflow;
      await persistWorkflowState();
      report(ctx, previousStatus === "blocked"
        ? reopenedKind ? `fusion resume: reopened ${reopenedKind}; downstream evidence invalidated` : "fusion resume: blocked node retrying"
        : "fusion resume: workflow resumed");
    },
  });
  pi.registerCommand("fusion-cancel", {
    description: "Cancel the active workflow",
    handler: async (_args, ctx) => {
      if (!workflow) { report(ctx, "fusion cancel: no active workflow", "warning"); return; }
      workflow = cancelWorkflow(workflow);
      state.workflow = workflow;
      await persistWorkflowState();
      if (workflow.adapter === "flicker" && workflow.flickerTicketId) {
        await syncFlickerStatus(workflow.flickerTicketId, workflow.status, { env: environment }).catch(() => undefined);
      }
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
      report(ctx, `fusion tune: approved · proposal recorded with rollback snapshot (policy wiring lands in a later slice) · rollback /fusion-tune-rollback ${applied.id.slice(0, 8)}`);
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
  pi.registerCommand("fusion-delegate", {
    description: "Decide and (in active mode) emit a V2 delegation for the current workflow node",
    handler: async (_args, ctx) => {
      if (!workflow || workflow.status !== "running") {
        report(ctx, "fusion delegate: no running workflow", "warning");
        return;
      }
      if (state.config.status !== "ready") { report(ctx, "fusion delegate: unconfigured", "warning"); return; }
      const node = runningNode(workflow);
      if (!node || !node.profile) { report(ctx, "fusion delegate: no running node", "warning"); return; }
      const decision = decideBackend({ node, config: state.config.config, concurrency: 0 });
      if (decision.backend !== "delegated") {
        report(ctx, `fusion delegate: direct · ${decision.reason}`);
        return;
      }
      if (state.config.config.mode !== "active") {
        report(ctx, `fusion delegate: would delegate ${node.kind} -> ${nodeAgentName(node.kind)} (${decision.reason}) · active mode required to emit`);
        return;
      }
      const result = await delegateV2({
        pi, config: state.config.config, profile: node.profile, repo: workflow.repo,
        nodeId: node.id, ownerRunId: `workflow-${workflow.id}`,
        agent: nodeAgentName(node.kind),
        task: `Perform the ${node.kind} stage of the approved Pi Fusion workflow in ${workflow.repo}.`,
        context: "fresh",
      });
      if (result.ok) {
        report(ctx, `fusion delegate: ${node.kind} -> ${nodeAgentName(node.kind)} ${result.status ?? "accepted"}${result.duplicate ? " (duplicate rejected)" : ""}`);
      } else {
        report(ctx, `fusion delegate: ${node.kind} failed · ${result.error ?? result.status ?? "unknown"}`, "warning");
      }
    },
  });
  pi.registerCommand("fusion", {
    description: "Open the Pi Fusion dashboard (mode, setup, workflow, proposals, controls)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        // Non-TUI fallback: a compact text dashboard via notify/stderr.
        report(ctx, [
          formatStatus(asView(state)),
          formatSetup(asView(state)),
          formatWorkflow(state.workflow),
          formatProposals(state.proposals),
        ].join("\n"));
        return;
      }
      const lines = [
        `Pi Fusion dashboard`,
        `mode: ${state.mode}`,
        `setup: ${state.setup?.complete ? "complete" : "incomplete"}`,
        `active model: ${state.activeModel ?? "unknown"}`,
        formatWorkflow(state.workflow),
        `proposals: ${state.proposals.length}`,
      ];
      ctx.ui.setWidget("pi-fusion-dashboard", lines);
      ctx.ui.notify("fusion dashboard shown (esc to clear: /fusion-dashboard-close)", "info");
    },
  });
  pi.registerCommand("fusion-dashboard-close", {
    description: "Clear the Pi Fusion dashboard widget",
    handler: async (_args, ctx) => {
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-fusion-dashboard", undefined);
      report(ctx, "fusion dashboard: cleared");
    },
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
