import type { Capabilities, Classification, MutationIntent, Phase } from "./types.ts";

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
/** UI/product-design surface language. Deliberately excludes the bare word "design" —
 *  "design an architecture" is planning — and "interface", which is a TypeScript keyword. */
const DESIGN = /\b(ui|ux|mockup|mock-?up|wireframe|prototype|layout|usability|screen|styling|stylesheet|css|front-?end|visual design|design system|redesign)\b/i;
const IMPLEMENT = /\b(implement|code|fix|bug|refactor|test|build|change|add|create|typescript|javascript|python|elixir)\b/i;
const EXPLORE = /\b(explore|inspect|look at|find|locate|list|show|understand|summari[sz]e|quick|small)\b/i;
// what'?s / how'?s: the apostrophe is optional so both "what's the deal" and the
// already-supported bare "whats" match the same alternative.
const CLARIFY = /\b(clarify|explain (the|what|how|why)|what does|how does|why does|tell me about|how (do|are|is|can|should|would|will) (i|we|you)|what (is|are|about)|what'?s|how'?s|how can|how do|how are)\b/i;
const MUTATION = /\b(implement|code|fix|bug|refactor|build|change|add|create|write|edit|update|remove|delete|migrate|commit|push|merge|deploy)\b/i;
/** Questions about how existing code behaves. Read-only even when they name a mutation
 *  verb as a noun ("what does the deploy script do"). */
const EXPOSITORY = /\b(what does|how does|why does|tell me about|explain (the|what|how|why))\b/i;

function requirements(overrides: Partial<Capabilities>): Capabilities {
  return { ...EMPTY_CAPABILITIES, ...overrides };
}

function mutationIntentOf(text: string): MutationIntent {
  if (!text) return "unknown";
  if (EXPOSITORY.test(text)) return "read-only";
  return MUTATION.test(text) ? "mutation" : "read-only";
}

function result(
  phase: Phase,
  complexity: Classification["complexity"],
  risk: Classification["risk"],
  confidence: number,
  reasonCodes: string[],
  requiredCapabilities: Capabilities,
  mutationIntent: MutationIntent,
): Classification {
  return { phase, complexity, risk, confidence, reasonCodes, requiredCapabilities, mutationIntent };
}

/** Confidence carried by a turn that was classified only by what came before it.
 *  Below every direct pattern match (the weakest is CLARIFY at 0.8) so an inherited
 *  phase never outranks an observed one, and above the policy floor of 0.5 so an
 *  ordinary follow-up still routes. */
const CONTINUATION_CONFIDENCE = 0.7;

/** Each further turn without fresh evidence is one step more distant from the thing that
 *  was actually observed, so an inherited phase loses confidence as the chain grows. The
 *  decay is what bounds the chain: confidence reaches the policy's own 0.5 floor after five
 *  continued turns (0.7, 0.65, 0.6, 0.55, 0.5) and routing stops assuming, with no separate
 *  counter or threshold. The result is rounded to two decimals so that landing exactly on
 *  0.5 is exact arithmetic, not a float accident the policy's `<=` happens to catch — binary
 *  floating point can't represent 0.05 exactly, so repeated subtraction alone gives
 *  0.49999999999999994, one ULP below the floor. Real logs contain a 39-turn chain, so an
 *  undecayed inheritance would pin a phase — and its risk level, and the expensive profile
 *  that follows from it — far past its evidence. */
const CONTINUATION_DECAY = 0.05;
const CONTINUED = "phase.continued";

export interface ClassifierInput {
  text?: string;
  imageCount?: number;
  /** The previous turn's classification in this session, if any. An agentic session is
   *  a conversation: "ok do that", "now the other one" and "why?" carry no phase
   *  vocabulary of their own, and treating each as a cold start throws away the only
   *  signal available. Must be cleared when the session resets. */
  previous?: Classification | null;
}

export function classify(input: ClassifierInput): Classification {
  const text = input.text?.normalize("NFKC").trim() ?? "";
  const intent = mutationIntentOf(text);

  if ((input.imageCount ?? 0) > 0 || /\b(image|screenshot|diagram|photo|visual|vision)\b/i.test(text)) {
    const phase: Phase = DESIGN.test(text) ? "design" : "vision";
    return result(phase, "medium", PROTECTED.test(text) ? "protected" : "medium", 0.98, [`input.image`, `phase.${phase}`], requirements({
      tools: true,
      reasoning: true,
      image: true,
      contextWindow: 64_000,
    }), intent);
  }

  // A protected topic escalates only when the request intends to change something.
  // "Explain how our authentication works" is a question, not a risky operation, and
  // forcing it onto the reason profile is pure cost.
  const protectedRisk = PROTECTED.test(text) && intent !== "read-only";
  if (protectedRisk) {
    const phase: Phase = REVIEW.test(text) ? "review" : PLAN.test(text) ? "plan" : IMPLEMENT.test(text) ? "implement" : "plan";
    return result(phase, "high", "protected", 0.96, ["risk.protected", `phase.${phase}`], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }), intent);
  }

  if (REVIEW.test(text)) {
    return result("review", "high", "high", 0.94, ["phase.review"], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }), intent);
  }
  if (RESEARCH.test(text)) {
    return result("research", "medium", "medium", 0.91, ["phase.research"], requirements({
      tools: true,
      reasoning: true,
      contextWindow: 128_000,
    }), intent);
  }
  // Before PLAN, which also matches the bare word "design". Gated on a UI surface noun so
  // "design an architecture" stays planning, and on the absence of an implementation verb so
  // "implement the settings screen layout" stays code.
  if (DESIGN.test(text) && !IMPLEMENT.test(text)) {
    return result("design", "high", "medium", 0.9, ["phase.design"], requirements({
      tools: true,
      reasoning: true,
      contextWindow: 128_000,
    }), intent);
  }
  if (PLAN.test(text)) {
    return result("plan", "high", "medium", 0.93, ["phase.plan"], requirements({
      reasoning: true,
      structuredOutput: true,
      contextWindow: 128_000,
    }), intent);
  }
  if (IMPLEMENT.test(text)) {
    return result("implement", "medium", "medium", 0.9, ["phase.implement"], requirements({
      tools: true,
      reasoning: true,
      structuredOutput: true,
      contextWindow: 64_000,
    }), intent);
  }
  if (EXPLORE.test(text)) {
    return result("explore", "low", "low", 0.87, ["phase.explore"], requirements({ tools: true, contextWindow: 32_000 }), intent);
  }
  if (CLARIFY.test(text)) {
    return result("clarify", "low", "low", 0.8, ["phase.clarify"], requirements({ contextWindow: 32_000 }), intent);
  }

  // Nothing in this turn names a phase. If the session already established one, the
  // turn is a follow-up within that work, which is a far better answer than "unknown".
  // Inherit the whole shape — capabilities and mutation intent included — because a
  // prompt with no phase vocabulary has no capability or intent signal either.
  const previous = input.previous;
  if (text && previous && previous.phase !== "unknown") {
    const confidence = previous.reasonCodes.includes(CONTINUED)
      ? Number((previous.confidence - CONTINUATION_DECAY).toFixed(2))
      : Math.min(previous.confidence, CONTINUATION_CONFIDENCE);
    return result(
      previous.phase,
      previous.complexity,
      previous.risk,
      confidence,
      ["input.ambiguous", CONTINUED, `phase.${previous.phase}`],
      previous.requiredCapabilities,
      previous.mutationIntent,
    );
  }

  return result("unknown", "unknown", "unknown", 0.25, [text ? "input.ambiguous" : "input.empty"], requirements({}), intent);
}
