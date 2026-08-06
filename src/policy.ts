import {
  CANONICAL_PROFILES,
  type CanonicalProfile,
  type Capabilities,
  type Classification,
  type FusionConfig,
  type Recommendation,
} from "./types.ts";

const PHASE_PREFERENCE: Record<Classification["phase"], CanonicalProfile> = {
  explore: "pi-fast",
  implement: "pi-code",
  plan: "pi-reason",
  review: "pi-review",
  research: "pi-research",
  vision: "pi-vision",
  unknown: "pi-fast",
};

const FALLBACK_ORDER: CanonicalProfile[] = [
  "pi-fast",
  "pi-code",
  "pi-reason",
  "pi-review",
  "pi-research",
  "pi-vision",
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
  config: FusionConfig;
  resolvedModels: Partial<Record<CanonicalProfile, string>>;
  providerReady: boolean;
}

export function recommend(input: PolicyInput): Recommendation {
  const { classification, config, resolvedModels, providerReady } = input;
  const evaluations = CANONICAL_PROFILES.map((profile) => {
    const modelId = resolvedModels[profile] ?? config.profiles[profile].modelId;
    const gaps = capabilityGaps(classification.requiredCapabilities, config.profiles[profile].capabilities);
    if (!resolvedModels[profile]) gaps.unshift("model.unavailable");
    return { profile, modelId, eligible: gaps.length === 0, reasons: gaps };
  });

  if (!providerReady) {
    return {
      shadow: true,
      profile: null,
      modelId: null,
      confidence: 0,
      retainCurrentModel: true,
      reasonCodes: ["provider.unavailable"],
      evaluations,
    };
  }

  if (classification.confidence < 0.5 || classification.phase === "unknown") {
    return {
      shadow: true,
      profile: null,
      modelId: null,
      confidence: classification.confidence,
      retainCurrentModel: true,
      reasonCodes: [...classification.reasonCodes, "policy.low-confidence"],
      evaluations,
    };
  }

  const preferred = classification.risk === "protected" ? "pi-reason" : PHASE_PREFERENCE[classification.phase];
  const order = [preferred, ...FALLBACK_ORDER.filter((profile) => profile !== preferred)];
  const selected = order
    .map((profile) => evaluations.find((item) => item.profile === profile))
    .find((item) => item?.eligible);

  if (!selected) {
    return {
      shadow: true,
      profile: null,
      modelId: null,
      confidence: classification.confidence,
      retainCurrentModel: true,
      reasonCodes: [...classification.reasonCodes, "policy.no-eligible-profile"],
      evaluations,
    };
  }

  return {
    shadow: true,
    profile: selected.profile,
    modelId: selected.modelId,
    confidence: classification.confidence,
    retainCurrentModel: true,
    reasonCodes: [
      ...classification.reasonCodes,
      selected.profile === preferred ? "policy.preferred" : "policy.capability-fallback",
    ],
    evaluations,
  };
}
