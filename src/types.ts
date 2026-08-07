export const CANONICAL_PROFILES = [
  "fast",
  "code",
  "reason",
  "review",
  "research",
  "vision",
  "design",
] as const;

export type CanonicalProfile = (typeof CANONICAL_PROFILES)[number];
export type Phase = "clarify" | "explore" | "research" | "plan" | "plan-review" | "implement" | "review" | "regression" | "release" | "vision" | "unknown";
export type Complexity = "low" | "medium" | "high" | "unknown";
export type Risk = "low" | "medium" | "high" | "protected" | "unknown";
export type Mode = "off" | "shadow" | "active";
export type ActiveModelCategory = CanonicalProfile | "external" | "unknown";
export type MutationIntent = "read-only" | "mutation" | "unknown";

export interface Capabilities {
  tools: boolean;
  reasoning: boolean;
  image: boolean;
  structuredOutput: boolean;
  contextWindow: number;
}

export interface ProfileConfig {
  modelId: string;
  capabilities: Capabilities;
}

export interface ProjectOverride {
  /** Absolute repository path (normalized). */
  repo: string;
  profiles: Partial<Record<CanonicalProfile, string>>;
}

export interface TuningConfig {
  enabled: boolean;
  file: string;
  maxEntries: number;
  minEvidence: number;
  /** Hard caps tuning may never exceed. */
  maxFanout: number;
  maxDepth: number;
  maxRetries: number;
  maxSwitches: number;
}

export interface FusionConfig {
  version: 2;
  mode: Mode;
  provider: {
    id: string;
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
  };
  profiles: Record<CanonicalProfile, ProfileConfig>;
  aliases: Record<string, CanonicalProfile>;
  projectOverrides: ProjectOverride[];
  telemetry: {
    enabled: boolean;
    file: string;
    maxEntries: number;
  };
  tuning: TuningConfig;
}

export interface Classification {
  phase: Phase;
  complexity: Complexity;
  risk: Risk;
  requiredCapabilities: Capabilities;
  confidence: number;
  reasonCodes: string[];
  mutationIntent: MutationIntent;
}

export interface ProfileEvaluation {
  profile: CanonicalProfile;
  modelId: string;
  eligible: boolean;
  reasons: string[];
}

export interface Recommendation {
  profile: CanonicalProfile | null;
  modelId: string | null;
  confidence: number;
  reasonCodes: string[];
  evaluations: ProfileEvaluation[];
}

export type RouteOnceStatus =
  | "shadow"
  | "armed"
  | "applied"
  | "skipped"
  | "restored"
  | "restore-failed"
  | "user-overrode";
export type RouteOnceReason =
  | "already-selected"
  | "current-model-missing"
  | "model-not-found"
  | "no-recommendation"
  | "provider-unavailable"
  | "restore-failed"
  | "selection-error"
  | "selection-failed"
  | "user-selected-model";

/** Result of a real minimal inference probe against a profile's target. */
export interface ProbeResult {
  profile: CanonicalProfile;
  modelId: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  probedAt: string;
  /** True when the target endpoint required no API key (valid keyless loopback). */
  keyless: boolean;
}

/** Durable setup state that gates active readiness. */
export interface SetupState {
  version: 1;
  complete: boolean;
  lastProbedAt: string | null;
  probes: Partial<Record<CanonicalProfile, ProbeResult>>;
}

/** A typed node in the bounded coding-workflow graph. */
export type WorkflowNodeKind =
  | "clarify"
  | "explore"
  | "research"
  | "plan"
  | "plan-review"
  | "implement"
  | "review"
  | "regression"
  | "release-readiness";

export type WorkflowNodeStatus = "pending" | "running" | "waiting-approval" | "approved" | "passed" | "failed" | "blocked" | "cancelled" | "skipped";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  profile: CanonicalProfile | null;
  status: WorkflowNodeStatus;
  dependsOn: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  evidence: string[];
  retryCount: number;
  reopenCount: number;
  error?: string;
}

/** Versioned approval envelope: fixed vs bounded-adaptive fields. */
export interface ApprovalEnvelope {
  version: number;
  approvedAt: string;
  scope: string;
  acceptance: string[];
  worktree: string;
  writer: string;
  authority: string[];
  profile: CanonicalProfile | null;
  maxFanout: number;
  maxDepth: number;
  maxRetries: number;
  maxSwitches: number;
  budgetTokens: number | null;
}

export type WorkflowStatus = "planning" | "awaiting-approval" | "running" | "paused" | "cancelled" | "blocked" | "complete" | "recovered";

export interface PendingFlickerProjection {
  kind: "approve" | "complete" | "cancel";
  createdAt: string;
}

export interface WorkflowState {
  id: string;
  repo: string;
  adapter: "session" | "flicker";
  flickerTicketId: string | null;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  envelope: ApprovalEnvelope | null;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  ownerSession: string;
  ownerPid: number;
  pendingProjection: PendingFlickerProjection | null;
}

/** A pin fixes a user choice until explicitly cleared. */
export interface Pin {
  scope: "session" | "repo";
  key: string;
  value: string;
  createdAt: string;
}

export type TuningKind = "confidence-threshold" | "escalation" | "fanout" | "retry" | "dwell" | "circuit-breaker" | "node-sequence";

export interface TuningProposal {
  id: string;
  createdAt: string;
  kind: TuningKind;
  scope: "global" | "project";
  repo?: string;
  description: string;
  diff: Record<string, unknown>;
  expectedImpact: string;
  evidenceSample: number;
  applied: boolean;
  appliedAt: string | null;
  rollback: Record<string, unknown> | null;
  status: "proposed" | "approved" | "denied" | "applied" | "rolled-back";
}

/** Content-free outcome record used for learning. */
export interface OutcomeRecord {
  schemaVersion: 1;
  timestamp: string;
  workflowId: string | null;
  nodeKind: WorkflowNodeKind | null;
  profile: CanonicalProfile | null;
  backend: "direct" | "delegated" | null;
  routeConfidence: number;
  phase: Phase;
  risk: Risk;
  accepted: boolean | null;
  retries: number;
  switches: number;
  usage: AggregateUsage;
  failure: string | null;
  tuningVersion: number;
}

export type ActiveThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AggregateUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}
