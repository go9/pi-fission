import {
  CANONICAL_PROFILES,
  type CanonicalProfile,
  type Capabilities,
  type Classification,
  type FissionConfig,
  type Recommendation,
} from "./types.ts";

const PHASE_PREFERENCE: Record<Classification["phase"], CanonicalProfile> = {
  clarify: "fast",
  explore: "fast",
  research: "research",
  plan: "reason",
  "plan-review": "review",
  implement: "code",
  review: "review",
  regression: "review",
  release: "reason",
  vision: "vision",
  design: "design",
  unknown: "fast",
};

const FALLBACK_ORDER: CanonicalProfile[] = [
  "fast",
  "code",
  "reason",
  "review",
  "research",
  "vision",
  "design",
];

export function capabilityGaps(required: Capabilities, available: Capabilities): string[] {
  const gaps: string[] = [];
  if (required.tools && !available.tools) gaps.push("capability.tools");
  if (required.reasoning && !available.reasoning) gaps.push("capability.reasoning");
  if (required.image && !available.image) gaps.push("capability.image");
  if (required.structuredOutput && !available.structuredOutput) gaps.push("capability.structured-output");
  if (available.contextWindow < required.contextWindow) gaps.push("capability.context-window");
  return gaps;
}

export interface PolicyInput {
  classification: Classification;
  config: FissionConfig;
  resolvedModels: Partial<Record<CanonicalProfile, string>>;
  effectiveCapabilities?: Partial<Record<CanonicalProfile, Capabilities>>;
  providerReady: boolean;
  /** When set (active workflow node), route through this profile if eligible. */
  forceProfile?: CanonicalProfile | null;
}

export function recommend(input: PolicyInput): Recommendation {
  const { classification, config, resolvedModels, effectiveCapabilities, providerReady } = input;
  const evaluations = CANONICAL_PROFILES.map((profile) => {
    const modelId = resolvedModels[profile] ?? config.profiles[profile].modelId;
    const available = effectiveCapabilities?.[profile] ?? config.profiles[profile].capabilities;
    const gaps = capabilityGaps(classification.requiredCapabilities, available);
    if (!resolvedModels[profile]) gaps.unshift("model.unavailable");
    return { profile, modelId, eligible: gaps.length === 0, reasons: gaps };
  });

  if (!providerReady) {
    return {
      profile: null,
      modelId: null,
      confidence: 0,
      reasonCodes: ["provider.unavailable"],
      evaluations,
    };
  }

  // This floor is load-bearing beyond its own decision: the classifier's continuation decay
  // has no counter of its own and relies on crossing this exact threshold to stop inheriting
  // a stale phase (see CONTINUATION_DECAY). The comparison is inclusive of 0.5 because the
  // decayed chain lands exactly on it (0.7 minus four 0.05 steps, rounded), and nothing else
  // ever classifies at precisely 0.5 — so the fifth continued turn is the one that stops.
  // Moving this threshold changes how many follow-up turns keep routing. "a chain stops
  // routing once it outruns its evidence" in classifier-policy.test.ts pins the relationship
  // and will fail if this moves.
  if (classification.confidence <= 0.5 || classification.phase === "unknown") {
    return {
      profile: null,
      modelId: null,
      confidence: classification.confidence,
      reasonCodes: [...classification.reasonCodes, "policy.low-confidence"],
      evaluations,
    };
  }

  const forced = input.forceProfile ? evaluations.find((item) => item.profile === input.forceProfile) : undefined;
  if (forced?.eligible) {
    return {
      profile: forced.profile,
      modelId: forced.modelId,
      confidence: classification.confidence,
      reasonCodes: [...classification.reasonCodes, "policy.workflow-node"],
      evaluations,
    };
  }
  if (forced) {
    return {
      profile: null,
      modelId: null,
      confidence: classification.confidence,
      reasonCodes: [...classification.reasonCodes, "policy.workflow-node-ineligible"],
      evaluations,
    };
  }

  const preferred = classification.risk === "protected" ? "reason" : PHASE_PREFERENCE[classification.phase];
  const order = [preferred, ...FALLBACK_ORDER.filter((profile) => profile !== preferred)];
  const selected = order
    .map((profile) => evaluations.find((item) => item.profile === profile))
    .find((item) => item?.eligible);

  if (!selected) {
    return {
      profile: null,
      modelId: null,
      confidence: classification.confidence,
      reasonCodes: [...classification.reasonCodes, "policy.no-eligible-profile"],
      evaluations,
    };
  }

  return {
    profile: selected.profile,
    modelId: selected.modelId,
    confidence: classification.confidence,
    reasonCodes: [
      ...classification.reasonCodes,
      selected.profile === preferred ? "policy.preferred" : "policy.capability-fallback",
    ],
    evaluations,
  };
}
