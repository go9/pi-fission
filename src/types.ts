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
export type MutationIntent = "read-only" | "mutation" | "unknown";
export type ActiveThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  repo: string;
  profiles: Partial<Record<CanonicalProfile, string>>;
}

/** Retained in config v2 solely for backwards compatibility. Fission no longer tunes itself. */
export interface TuningConfig {
  enabled: boolean;
  file: string;
  maxEntries: number;
  minEvidence: number;
  maxFanout: number;
  maxDepth: number;
  maxRetries: number;
  maxSwitches: number;
}

export interface FissionConfig {
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
  /** Retained in config v2 for compatibility; the router does not record prompts or outcomes. */
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

export interface ProbeResult {
  profile: CanonicalProfile;
  modelId: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  probedAt: string;
  keyless: boolean;
}

export interface SetupState {
  version: 1;
  complete: boolean;
  lastProbedAt: string | null;
  probes: Partial<Record<CanonicalProfile, ProbeResult>>;
}
