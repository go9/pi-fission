import type { Capabilities, Classification, Phase } from "./types.ts";

const EMPTY_CAPABILITIES: Capabilities = {
  tools: false,
  reasoning: false,
  image: false,
  structuredOutput: false,
  contextWindow: 16_000,
};

const PROTECTED = /\b(auth(?:entication|orization)?|permission|secret|credential|billing|payment|money|migration|production|deploy|release|publish|delete|destructive|concurren(?:cy|t)|security|encryption)\b/i;
const REVIEW = /\b(review|audit|critique|regression|verify|validate|find bugs?|pull request|\bpr\b)\b/i;
const RESEARCH = /\b(research|investigate|compare|upstream|documentation|docs|web|sources?|prior art)\b/i;
const PLAN = /\b(plan|architect(?:ure)?|design|strategy|approach|trade-?offs?|proposal)\b/i;
const IMPLEMENT = /\b(implement|code|fix|bug|refactor|test|build|change|add|create|typescript|javascript|python|elixir)\b/i;
const EXPLORE = /\b(explore|inspect|look at|find|locate|list|show|understand|summari[sz]e|quick|small)\b/i;

function requirements(overrides: Partial<Capabilities>): Capabilities {
  return { ...EMPTY_CAPABILITIES, ...overrides };
}

function result(
  phase: Phase,
  complexity: Classification["complexity"],
  risk: Classification["risk"],
  confidence: number,
  reasonCodes: string[],
  requiredCapabilities: Capabilities,
): Classification {
  return { phase, complexity, risk, confidence, reasonCodes, requiredCapabilities };
}

export interface ClassifierInput {
  text?: string;
  imageCount?: number;
}

export function classify(input: ClassifierInput): Classification {
  const text = input.text?.normalize("NFKC").trim() ?? "";

  if ((input.imageCount ?? 0) > 0 || /\b(image|screenshot|diagram|photo|visual|vision)\b/i.test(text)) {
    return result("vision", "medium", PROTECTED.test(text) ? "protected" : "medium", 0.98, ["input.image"], requirements({
      tools: true,
      reasoning: true,
      image: true,
      contextWindow: 64_000,
    }));
  }

  const protectedRisk = PROTECTED.test(text);
  if (protectedRisk) {
    const phase: Phase = REVIEW.test(text) ? "review" : PLAN.test(text) ? "plan" : IMPLEMENT.test(text) ? "implement" : "plan";
    return result(phase, "high", "protected", 0.96, ["risk.protected", `phase.${phase}`], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }));
  }

  if (REVIEW.test(text)) {
    return result("review", "high", "high", 0.94, ["phase.review"], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }));
  }
  if (RESEARCH.test(text)) {
    return result("research", "medium", "medium", 0.91, ["phase.research"], requirements({
      tools: true,
      reasoning: true,
      contextWindow: 128_000,
    }));
  }
  if (PLAN.test(text)) {
    return result("plan", "high", "medium", 0.93, ["phase.plan"], requirements({
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }));
  }
  if (IMPLEMENT.test(text)) {
    return result("implement", "medium", "medium", 0.9, ["phase.implement"], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 64_000,
    }));
  }
  if (EXPLORE.test(text)) {
    return result("explore", "low", "low", 0.87, ["phase.explore"], requirements({ tools: true, contextWindow: 32_000 }));
  }

  return result("unknown", "unknown", "unknown", 0.25, [text ? "input.ambiguous" : "input.empty"], requirements({}));
}

export function observeToolPhase(current: Classification, toolName: string): Classification {
  const normalized = toolName.toLowerCase();
  let phase: Phase | null = null;
  if (/^(edit|write|apply_patch)$/.test(normalized)) phase = "implement";
  else if (/^(browser|web|search|fetch)$/.test(normalized)) phase = "research";
  else if (/^(image|vision)$/.test(normalized)) phase = "vision";
  else if (/^(test|review)$/.test(normalized)) phase = "review";
  else if (/^(read|grep|find|ls)$/.test(normalized) && current.phase === "unknown") phase = "explore";
  if (!phase || phase === current.phase) return current;

  const observed = classify({ text: phase });
  return {
    ...observed,
    confidence: Math.max(0.7, Math.min(current.confidence, 0.85)),
    risk: current.risk === "protected" ? "protected" : observed.risk,
    reasonCodes: [...new Set([...current.reasonCodes.filter((code) => code.startsWith("risk.")), `observed.${phase}`])],
  };
}
