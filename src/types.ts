export const CANONICAL_PROFILES = [
  "pi-fast",
  "pi-code",
  "pi-reason",
  "pi-review",
  "pi-research",
  "pi-vision",
] as const;

export type CanonicalProfile = (typeof CANONICAL_PROFILES)[number];
export type Phase = "explore" | "implement" | "plan" | "review" | "research" | "vision" | "unknown";
export type Complexity = "low" | "medium" | "high" | "unknown";
export type Risk = "low" | "medium" | "high" | "protected" | "unknown";
export type ActiveModelCategory = CanonicalProfile | "external" | "unknown";

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

export interface FusionConfig {
  version: 1;
  enabled: boolean;
  provider: {
    id: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  profiles: Record<CanonicalProfile, ProfileConfig>;
  aliases: Record<string, CanonicalProfile>;
  telemetry: {
    enabled: boolean;
    file: string;
    maxEntries: number;
  };
}

export interface Classification {
  phase: Phase;
  complexity: Complexity;
  risk: Risk;
  requiredCapabilities: Capabilities;
  confidence: number;
  reasonCodes: string[];
}

export interface ProfileEvaluation {
  profile: CanonicalProfile;
  modelId: string;
  eligible: boolean;
  reasons: string[];
}

export interface Recommendation {
  shadow: true;
  profile: CanonicalProfile | null;
  modelId: string | null;
  confidence: number;
  retainCurrentModel: boolean;
  reasonCodes: string[];
  evaluations: ProfileEvaluation[];
}
