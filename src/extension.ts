import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
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
import { resolveFlickerProject, createPlanningTicket, findPlanningTicket, readFlickerDocument, readFlickerTicketStatus, syncFlickerStatus, writeFlickerDocument } from "./flicker-adapter.ts";
import {
  activeWorkflowForRepo,
  advanceWorkflow,
  canonicalRepository,
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
  withRepoWorkflowLock,
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

const execFileAsync = promisify(execFile);
type AllowedShellKind = "local" | "commit" | "verification";

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const finish = () => { if (word) { words.push(word); word = ""; } };
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "single") { escaped = true; continue; }
    if (char === "'" && quote !== "double") { quote = quote === "single" ? null : "single"; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? null : "double"; continue; }
    if (quote !== "single" && /[;$`|&<>\n\r(){}]/.test(char)) return null;
    if (!quote && /\s/.test(char)) { finish(); continue; }
    word += char;
  }
  if (quote || escaped) return null;
  finish();
  return words.length > 0 ? words : null;
}

function allowedShellCommand(command: string): AllowedShellKind | null {
  const raw = shellWords(command);
  if (!raw) return null;
  const words = [...raw];
  if (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return null;
  const executable = words.shift();
  if (!executable || executable.includes("/")) return null;
  const verb = words[0] ?? "";
  const allowVerb = (verbs: string[]) => verbs.includes(verb);

  if (executable === "git") {
    const args = words.slice(1);
    if (args.some((item) => /^(?:--git-dir|--work-tree|--exec-path|--config-env|--ext-diff)/.test(item) || isAbsolute(item) || item === ".." || item.startsWith("../"))) return null;
    if (allowVerb(["status", "diff", "log", "show", "rev-parse"])) return "local";
    if (verb === "add" && args.length > 0 && args.every((item) => item === "." || (!item.startsWith("-") && !isAbsolute(item) && item !== ".." && !item.startsWith("../")))) return "local";
    if (verb === "commit" && args.length === 2 && ["-m", "--message"].includes(args[0]!)) return "commit";
    return null;
  }
  if (executable === "npm" || executable === "pnpm") {
    if (verb === "test" && words.length === 1) return "verification";
    if (verb === "run" && words.length === 2 && /^test(?::[A-Za-z0-9_.-]+)?$/.test(words[1] ?? "")) return "verification";
    if (verb === "run" && words.length === 2 && /^(?:check|typecheck)(?::[A-Za-z0-9_.-]+)?$/.test(words[1] ?? "")) return "local";
    if (allowVerb(["pack", "audit"]) && words.length === 1) return "local";
    return null;
  }
  if (executable === "mix") {
    if (verb === "test" && words.length === 1) return "verification";
    if (allowVerb(["compile", "format"]) && words.length === 1) return "local";
    return null;
  }
  if (executable === "cargo") return verb === "test" && words.length === 1 ? "verification" : allowVerb(["check", "build", "fmt", "clippy"]) && words.length === 1 ? "local" : null;
  if (executable === "go") return verb === "test" && words.length === 2 && words[1] === "./..." ? "verification" : allowVerb(["build", "fmt", "vet"]) && words.length === 1 ? "local" : null;
  if (executable === "make") return words.length > 0 && words.every((item) => /^test$/.test(item)) ? "verification" : words.length > 0 && words.every((item) => /^(?:check|typecheck)$/.test(item)) ? "local" : null;
  if (["grep", "test", "diff", "cmp", "wc"].includes(executable)) return "local";
  if (["pwd", "ls", "cat", "head", "tail", "sort", "uniq"].includes(executable)) return "local";
  if (executable === "find" && !words.some((item) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(item))) return "local";
  return null;
}

function inputPath(input: unknown): string | null {
  return typeof input === "object" && input !== null && "path" in input && typeof (input as { path?: unknown }).path === "string"
    ? (input as { path: string }).path
    : null;
}

function pathWithinWorktree(workflow: WorkflowState, path: string): boolean {
  const root = resolve(workflow.envelope?.worktree ?? workflow.repo);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const lexical = relative(root, target);
  if (lexical !== "" && (lexical.startsWith("..") || isAbsolute(lexical))) return false;
  try {
    const canonicalRoot = realpathSync(root);
    let cursor = root;
    for (const segment of lexical.split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) return false;
      } catch {
        break;
      }
    }
    let existing = target;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    const canonicalExisting = realpathSync(existing);
    const canonical = relative(canonicalRoot, canonicalExisting);
    return canonical === "" || (!canonical.startsWith("..") && !isAbsolute(canonical));
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxedShellCommand(workflow: WorkflowState, command: string): string | null {
  if (!existsSync("/usr/bin/sandbox-exec")) return null;
  const root = realpathSync(workflow.envelope?.worktree ?? workflow.repo);
  const temp = realpathSync(tmpdir());
  const profile = `(version 1)\n(deny default)\n(allow process*)\n(allow file-read*)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow signal)\n(allow ipc-posix-shm)\n(allow network-bind)\n(allow network-inbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(temp)}) (literal "/dev/null"))`;
  return `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/sh -lc ${shellQuote(command)}`;
}

async function gitHead(repo: string): Promise<string | null> {
  try { return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim() || null; } catch { return null; }
}

async function gitStatus(repo: string): Promise<string | null> {
  try { return (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo })).stdout; } catch { return null; }
}

export async function commitChangedFiles(repo: string, previousHead: string | null, previousStatus: string | null): Promise<boolean> {
  try {
    if (previousStatus !== "") return false;
    const current = await gitHead(repo);
    if (!current || !previousHead || current === previousHead) return false;
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${previousHead}..${current}`], { cwd: repo });
    if (stdout.trim().length === 0) return false;
    return previousStatus !== null && await gitStatus(repo) === previousStatus;
  } catch {
    return false;
  }
}

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
  if (options.workflow.pendingProjection) return `Flicker ${options.workflow.pendingProjection.kind} projection is pending; mutating tools are blocked`;
  if (options.workflow.status === "awaiting-approval") return "Approve the Pi Fusion plan before repository mutation";
  if (options.workflow.status !== "running") return `Pi Fusion workflow is ${options.workflow.status}; mutating tools are blocked`;

  const node = runningNode(options.workflow);
  if (!node || !WRITER_NODE_KINDS.has(node.kind)) {
    return `Pi Fusion ${node?.kind ?? "unknown"} node is read-only; mutating tools are blocked`;
  }
  if (!WRITER_TOOLS.has(options.toolName)) {
    return `Tool ${options.toolName} is outside the approved writer tool set`;
  }
  if (options.toolName === "edit" || options.toolName === "write") {
    const path = inputPath(options.input);
    if (!path || !pathWithinWorktree(options.workflow, path)) return "Write/edit path is outside the approved worktree";
  }
  if (options.toolName === "bash") {
    const command = typeof options.input === "object" && options.input !== null && "command" in options.input
      ? String((options.input as { command?: unknown }).command ?? "")
      : "";
    if (!allowedShellCommand(command)) {
      return "Shell command is outside the approved local command allowlist; remote, release, destructive, chained, and interpreter commands require separate authority";
    }
  }
  return null;
}

function evidenceForTool(workflow: WorkflowState | null, toolName: string, input: unknown): string[] {
  if (!workflow) return [];
  if ((toolName === "write" || toolName === "edit")) {
    const path = inputPath(input);
    return path && pathWithinWorktree(workflow, path) ? [`mutation:${toolName}:in-worktree`] : [];
  }
  if (toolName === "bash") {
    const command = typeof input === "object" && input !== null && "command" in input
      ? String((input as { command?: unknown }).command ?? "")
      : "";
    const kind = allowedShellCommand(command);
    if (kind === "verification") return ["verification:test-command:ok"];
    if (kind === "commit") return [];
    return kind === "local" ? ["tool:bash:ok"] : [];
  }
  if (toolName === "read") return ["tool:read:ok"];
  return [];
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  let nodeStartHead: string | null = null;
  let nodeStartStatus: string | null = null;
  const shellCommands = new Map<string, string>();

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

  const attachFlickerTicket = async (candidate: WorkflowState): Promise<WorkflowState> => {
    if (candidate.adapter !== "flicker" || candidate.flickerTicketId) return candidate;
    const found = await findPlanningTicket(candidate.repo, candidate.id, { env: environment });
    if (!found.ok) {
      const first = candidate.nodes[0];
      return {
        ...candidate,
        status: "blocked",
        nodes: first ? candidate.nodes.map((node) => node.id === first.id ? { ...node, status: "failed" as const, error: `Flicker ticket lookup failed: ${found.error ?? "unknown error"}` } : node) : candidate.nodes,
      };
    }
    const ticket = found.ticketId
      ? found
      : await createPlanningTicket(
          candidate.repo,
          "Pi Fusion managed workflow",
          `Pi Fusion workflow: ${candidate.id}\n\nManaged by Pi Fusion for ${candidate.repo}. Planning documents and evidence are projected into Flicker.`,
          { env: environment },
        );
    if (ticket.ok && ticket.ticketId) {
      return {
        ...candidate,
        flickerTicketId: ticket.ticketId,
        status: candidate.envelope ? candidate.status : "awaiting-approval",
        nodes: candidate.nodes.map((node) => node.status === "failed" && node.error?.startsWith("Flicker ticket")
          ? { ...node, status: "pending" as const, finishedAt: null, error: undefined }
          : node),
        updatedAt: new Date().toISOString(),
      };
    }
    const first = candidate.nodes[0];
    return {
      ...candidate,
      status: "blocked",
      nodes: first
        ? candidate.nodes.map((node) => node.id === first.id ? { ...node, status: "failed", finishedAt: new Date().toISOString(), error: ticket.error ?? "Flicker ticket creation failed" } : node)
        : candidate.nodes,
      updatedAt: new Date().toISOString(),
    };
  };

  const ensureFlickerDocument = async (ticketId: string, kind: string, title: string, marker: string, body: string): Promise<{ ok: boolean; error?: string }> => {
    const current = await readFlickerDocument(ticketId, kind, { env: environment });
    if (!current.ok) return { ok: false, error: current.error };
    const tagged = `<!-- ${marker} -->`;
    if (current.document?.body.includes(tagged)) return { ok: true };
    if (current.document) return { ok: false, error: `Concurrent Flicker ${kind} head v${current.document.version ?? "unknown"}; refusing replacement` };
    return writeFlickerDocument(ticketId, kind, title, `${tagged}\n${body}`, { env: environment });
  };

  const projectPendingFlicker = async (candidate: WorkflowState): Promise<{ workflow: WorkflowState; ok: boolean; error?: string }> => {
    const pending = candidate.pendingProjection;
    if (!pending) return { workflow: candidate, ok: true };
    if (pending.kind === "cancel" && !candidate.flickerTicketId) {
      const found = await findPlanningTicket(candidate.repo, candidate.id, { env: environment });
      if (!found.ok) return { workflow: { ...candidate, status: "blocked" }, ok: false, error: found.error };
      if (!found.ticketId) return { workflow: { ...candidate, status: "cancelled", pendingProjection: null, updatedAt: new Date().toISOString() }, ok: true };
      candidate = { ...candidate, flickerTicketId: found.ticketId };
    }
    let attached = await attachFlickerTicket(candidate);
    if (!attached.flickerTicketId) return { workflow: { ...attached, status: "blocked" }, ok: false, error: "Flicker ticket unavailable" };
    const ticketId = attached.flickerTicketId;
    let activePending = attached.pendingProjection ?? pending;
    let result: { ok: boolean; error?: string };
    if ((activePending.kind === "approve" || activePending.kind === "complete") && !activePending.documentWritten) {
      const marker = activePending.documentMarker ?? `pi-fusion:${attached.id}:${activePending.kind}:v${attached.envelope?.version ?? 0}`;
      const kind = activePending.kind === "approve" ? "task_contract" : "implementation_notes";
      const title = activePending.kind === "approve" ? "Pi Fusion task contract" : "Pi Fusion implementation evidence";
      const body = activePending.kind === "approve" ? flickerTaskContractBody(attached) : flickerImplementationNotesBody({ ...attached, status: "complete" });
      const written = await ensureFlickerDocument(ticketId, kind, title, marker, body);
      if (!written.ok) return { workflow: { ...attached, status: "blocked" }, ok: false, error: written.error };
      activePending = { ...activePending, documentMarker: marker, documentWritten: true };
      attached = { ...attached, pendingProjection: activePending };
      await upsertWorkflow(attached, storePath);
    }
    if (activePending.kind === "approve") {
      result = await syncFlickerStatus(ticketId, "running", { env: environment });
    } else if (activePending.kind === "complete") {
      result = await syncFlickerStatus(ticketId, "complete", { env: environment });
    } else {
      result = await syncFlickerStatus(ticketId, "cancelled", { env: environment });
    }
    if (!result.ok) return { workflow: { ...attached, status: "blocked" }, ok: false, error: result.error };
    const status: WorkflowState["status"] = pending.kind === "approve" ? "running" : pending.kind === "complete" ? "complete" : "cancelled";
    attached = { ...attached, status, pendingProjection: null, updatedAt: new Date().toISOString() };
    return { workflow: attached, ok: true };
  };

  /** Full-product: create a managed workflow for a coding question (or none for read-only). */
  const ensureWorkflow = async (ctx: ExtensionContext): Promise<void> => {
    if (state.config.status !== "ready" || !state.classification) return;
    if (state.classification.mutationIntent !== "mutation") {
      // A read-only continuation must not discard an already approved workflow.
      // It can advance the current read-only node while preserving the same
      // session ownership and approval envelope.
      if (workflow && (workflow.status === "planning" || workflow.status === "running" || workflow.status === "awaiting-approval" || workflow.status === "paused" || workflow.status === "blocked" || workflow.status === "recovered")) {
        state.workflow = workflow;
        return;
      }
      workflow = null;
      state.workflow = null;
      return;
    }
    if (workflow && (workflow.status === "planning" || workflow.status === "running" || workflow.status === "awaiting-approval" || workflow.status === "paused" || workflow.status === "blocked" || workflow.status === "recovered")) return;
    const repo = await canonicalRepository(ctx.cwd);
    await withRepoWorkflowLock(repo, storePath, async () => {
      const foreign = await foreignOwnerForRepo(repo, getSessionId(ctx), storePath);
      state.foreignOwner = foreign !== null;
      if (foreign) {
        workflow = null;
        state.workflow = null;
        return;
      }
      const existing = await activeWorkflowForRepo(repo, getSessionId(ctx), storePath);
      if (existing) {
        workflow = await attachFlickerTicket(existing);
        state.workflow = workflow;
        await upsertWorkflow(workflow, storePath);
        return;
      }
      // Persist the workflow identity before any remote ticket creation. The
      // workflow id is the idempotency marker used to recover an orphaned ticket.
      let adapter: "session" | "flicker" = "session";
      let flickerResolutionError: string | null = null;
      try {
        const resolution = await resolveFlickerProject(repo, { env: environment });
        if (resolution.ok && resolution.projectSlug) adapter = "flicker";
        else if (existsSync(join(repo, "flicker.toml"))) {
          adapter = "flicker";
          flickerResolutionError = resolution.error ?? "Flicker project resolution failed";
        }
      } catch (error) {
        if (existsSync(join(repo, "flicker.toml"))) {
          adapter = "flicker";
          flickerResolutionError = (error as Error).message;
        }
      }
      workflow = createWorkflowState({
        repo,
        adapter,
        flickerTicketId: null,
        classification: state.classification!,
        mode: state.config.status === "ready" ? state.config.config.mode : "off",
        ownerSession: getSessionId(ctx),
        ownerPid: process.pid,
      });
      if (adapter === "flicker") workflow = { ...workflow, status: "planning" };
      if (flickerResolutionError) {
        const first = workflow.nodes[0];
        workflow = {
          ...workflow,
          status: "blocked",
          nodes: first ? workflow.nodes.map((node) => node.id === first.id ? { ...node, status: "failed" as const, error: `Flicker project resolution failed: ${flickerResolutionError}` } : node) : workflow.nodes,
        };
      }
      state.workflow = workflow;
      await upsertWorkflow(workflow, storePath);
      if (!flickerResolutionError) workflow = await attachFlickerTicket(workflow);
      state.workflow = workflow;
      await upsertWorkflow(workflow, storePath);
    });
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
    const repo = await canonicalRepository(ctx.cwd);
    await withRepoWorkflowLock(repo, storePath, async () => {
      workflow = await activeWorkflowForRepo(repo, ownerSession, storePath);
      state.foreignOwner = (await foreignOwnerForRepo(repo, ownerSession, storePath)) !== null;
      if (workflow?.adapter === "flicker") {
        if (workflow.pendingProjection?.kind === "cancel") {
          const projected = await projectPendingFlicker(workflow);
          workflow = projected.workflow;
        } else {
          workflow = await attachFlickerTicket(workflow);
          if (workflow.pendingProjection) {
            const projected = await projectPendingFlicker(workflow);
            workflow = projected.workflow;
          }
        }
        if (workflow.flickerTicketId && !workflow.pendingProjection) {
          const remote = await readFlickerTicketStatus(workflow.flickerTicketId, { env: environment });
          const drift = remote.ok && (
            remote.status === "done"
            || (workflow.status === "awaiting-approval" && remote.status !== "backlog")
            || (["running", "paused", "blocked", "recovered"].includes(workflow.status) && remote.status !== "in_progress")
          );
          if (!remote.ok || drift) {
            const node = runningNode(workflow) ?? workflow.nodes.find((item) => item.status === "pending");
            workflow = {
              ...workflow,
              status: "blocked",
              updatedAt: new Date().toISOString(),
              nodes: node ? workflow.nodes.map((item) => item.id === node.id ? { ...item, status: "failed" as const, error: `Flicker reconciliation required: ${remote.error ?? `remote status ${remote.status}`}` } : item) : workflow.nodes,
            };
          }
        }
        await upsertWorkflow(workflow, storePath);
      }
      state.workflow = workflow;
    });
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
    nodeStartHead = null;
    nodeStartStatus = null;
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
      if (workflow?.status === "running" && runningNode(workflow)?.kind === "implement") {
        const worktree = workflow.envelope?.worktree ?? ctx.cwd;
        nodeStartHead = await gitHead(worktree);
        nodeStartStatus = await gitStatus(worktree);
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

  pi.on("tool_result", async (event, ctx) => {
    if (state.classification) {
      state.classification = observeToolPhase(state.classification, event.toolName);
      reroute();
    }
    state.usage = mergeUsage(state.usage, sanitizeUsage(event.usage));
    const originalShell = event.toolName === "bash" ? shellCommands.get(event.toolCallId) : undefined;
    if (event.toolName === "bash") shellCommands.delete(event.toolCallId);
    const evidenceInput = originalShell === undefined ? event.input : { command: originalShell };
    if (event.isError) {
      state.outcome = "error";
    } else {
      for (const evidence of evidenceForTool(workflow, event.toolName, evidenceInput)) turnEvidence.add(evidence);
      if (event.toolName === "bash" && workflow && originalShell !== undefined) {
        if (allowedShellCommand(originalShell) === "commit" && await commitChangedFiles(workflow.envelope?.worktree ?? workflow.repo, nodeStartHead, nodeStartStatus)) {
          turnEvidence.add("git:commit:changed-files");
        }
      }
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
    if (activeMode && workflow && event.toolName === "bash") {
      const original = typeof event.input === "object" && event.input !== null && "command" in event.input
        ? String((event.input as { command?: unknown }).command ?? "")
        : "";
      const sandboxed = sandboxedShellCommand(workflow, original);
      if (!sandboxed) return { block: true, reason: "Local shell sandbox is unavailable", terminate: true };
      shellCommands.set(event.toolCallId, original);
      (event.input as { command: string }).command = sandboxed;
    }
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
        if (node.kind === "implement" && !await commitChangedFiles(workflow.envelope?.worktree ?? workflow.repo, nodeStartHead, nodeStartStatus)) {
          turnEvidence.delete("git:commit:changed-files");
          workflow = { ...workflow, nodes: workflow.nodes.map((item) => item.id === node.id ? { ...item, evidence: item.evidence.filter((entry) => entry !== "git:commit:changed-files") } : item) };
        }
        if (turnEvidence.size > 0) {
          workflow = {
            ...workflow,
            nodes: workflow.nodes.map((item) => item.id === node.id
              ? { ...item, evidence: [...new Set([...item.evidence, ...turnEvidence])] }
              : item),
          };
        }
        let advanced = advanceWorkflow(workflow, node.id, settledOutcome === "error" ? "failed" : "passed", settledOutcome === "error" ? "provider/tool error" : undefined);
        if (advanced.status === "complete" && advanced.adapter === "flicker") {
          advanced = { ...advanced, pendingProjection: { kind: "complete", createdAt: new Date().toISOString(), documentMarker: `pi-fusion:${advanced.id}:complete:v${advanced.envelope?.version ?? 0}`, documentWritten: false } };
          workflow = advanced;
          state.workflow = workflow;
          await persistWorkflowState();
          const projected = await projectPendingFlicker(advanced);
          advanced = projected.workflow;
        }
        workflow = advanced;
        state.workflow = workflow;
        await persistWorkflowState();
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
      const approved = approveWorkflow(workflow, {
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
      workflow = approved.adapter === "flicker"
        ? { ...approved, pendingProjection: { kind: "approve", createdAt: new Date().toISOString(), documentMarker: `pi-fusion:${approved.id}:approve:v${approved.envelope?.version ?? 0}`, documentWritten: false } }
        : approved;
      state.workflow = workflow;
      await persistWorkflowState();
      if (workflow.pendingProjection) {
        const projected = await projectPendingFlicker(workflow);
        workflow = projected.workflow;
        state.workflow = workflow;
        await persistWorkflowState();
        if (!projected.ok) {
          report(ctx, `fusion plan: Flicker projection blocked · ${projected.error ?? "unknown error"}`, "warning");
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
      const requested = firstArg(args);
      if (!workflow && requested === "takeover") {
        let takeoverMessage = "fusion resume: no foreign workflow to take over";
        await withRepoWorkflowLock(ctx.cwd, storePath, async () => {
          const foreign = await foreignOwnerForRepo(ctx.cwd, getSessionId(ctx), storePath);
          if (!foreign) return;
          if (processIsAlive(foreign.ownerPid)) {
            takeoverMessage = "fusion resume: foreign owner is still active; takeover refused";
            return;
          }
          workflow = { ...foreign, ownerSession: getSessionId(ctx), ownerPid: process.pid, updatedAt: new Date().toISOString() };
          state.workflow = workflow;
          state.foreignOwner = false;
          await persistWorkflowState();
          takeoverMessage = "fusion resume: stale workflow ownership reconciled; run /fusion-resume to continue";
        });
        report(ctx, takeoverMessage, takeoverMessage.includes("reconciled") ? "info" : "warning");
        return;
      }
      if (!workflow) { report(ctx, "fusion resume: no active workflow", "warning"); return; }
      if (workflow.pendingProjection) {
        const projected = await projectPendingFlicker(workflow);
        workflow = projected.workflow;
        state.workflow = workflow;
        await persistWorkflowState();
        report(ctx, projected.ok ? `fusion resume: Flicker ${workflow.status} projection reconciled` : `fusion resume: Flicker projection still blocked · ${projected.error ?? "unknown error"}`, projected.ok ? "info" : "warning");
        return;
      }
      const previousStatus = workflow.status;
      let reopenedKind: WorkflowNode["kind"] | null = null;
      if (previousStatus === "blocked") {
        if (workflow.adapter === "flicker" && !workflow.flickerTicketId) {
          const resolutionFailure = workflow.nodes.find((node) => node.status === "failed" && node.error?.startsWith("Flicker project resolution failed:"));
          if (resolutionFailure) {
            const resolution = await resolveFlickerProject(workflow.repo, { env: environment });
            if (!resolution.ok || !resolution.projectSlug) { report(ctx, `fusion resume: Flicker project resolution still blocked · ${resolution.error ?? "unknown error"}`, "warning"); return; }
            workflow = {
              ...workflow,
              status: "planning",
              nodes: workflow.nodes.map((node) => node.id === resolutionFailure.id ? { ...node, status: "pending" as const, error: undefined } : node),
            };
          }
          workflow = await attachFlickerTicket(workflow);
          state.workflow = workflow;
          await persistWorkflowState();
          if (workflow.status === "awaiting-approval") {
            report(ctx, "fusion resume: Flicker ticket recovered; run /fusion-plan to approve");
            return;
          }
        }
        const projectionFailure = workflow.nodes.find((node) => node.status === "failed" && node.error?.startsWith("Flicker projection failed:"));
        if (projectionFailure && workflow.adapter === "flicker" && workflow.flickerTicketId) {
          const written = await writeFlickerDocument(workflow.flickerTicketId, "task_contract", "Pi Fusion task contract", flickerTaskContractBody(workflow), { env: environment });
          const sync = written.ok
            ? await syncFlickerStatus(workflow.flickerTicketId, "running", { env: environment })
            : { ok: false, error: written.error };
          if (!sync.ok) { report(ctx, `fusion resume: Flicker projection still blocked · ${sync.error ?? "unknown error"}`, "warning"); return; }
        }
        const maxRetries = workflow.envelope?.maxRetries ?? 0;
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
      let cancelled = cancelWorkflow(workflow);
      if (cancelled.adapter === "flicker") cancelled = { ...cancelled, pendingProjection: { kind: "cancel", createdAt: new Date().toISOString(), documentMarker: null, documentWritten: true } };
      workflow = cancelled;
      state.workflow = workflow;
      await persistWorkflowState();
      if (cancelled.pendingProjection) {
        const projected = await projectPendingFlicker(cancelled);
        workflow = projected.workflow;
        state.workflow = workflow;
        await persistWorkflowState();
        if (!projected.ok) { report(ctx, `fusion cancel: Flicker reconciliation failed · ${projected.error ?? "unknown error"}`, "warning"); return; }
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
