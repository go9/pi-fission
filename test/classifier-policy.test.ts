import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, observeToolPhase } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import type { CanonicalProfile } from "../src/types.ts";
import { validConfig } from "../test-support/helpers.ts";

const allModels = Object.fromEntries([
  "fast", "code", "reason", "review", "research", "vision", "design",
].map((profile) => [profile, profile])) as Record<CanonicalProfile, string>;

describe("deterministic classifier and policy", () => {
  const cases = [
    ["explore", "Quickly explore and list the relevant files", "explore", "fast"],
    ["routine code", "Implement a TypeScript helper and tests", "implement", "code"],
    ["architecture plan", "Design an architecture plan and trade-offs", "plan", "reason"],
    ["review", "Review this pull request for regressions", "review", "review"],
    ["research", "Research upstream documentation and compare approaches", "research", "research"],
    ["vision", "Inspect this screenshot for visual problems", "vision", "vision"],
    ["protected risk", "Implement an authentication and permissions migration", "implement", "reason"],
  ] as const;

  for (const [name, text, phase, profile] of cases) {
    it(`classifier and policy route ${name}`, () => {
      const first = classify({ text });
      const second = classify({ text });
      assert.deepEqual(first, second);
      assert.equal(first.phase, phase);
      const route = recommend({ classification: first, config: validConfig(), resolvedModels: allModels, providerReady: true });
      assert.equal(route.profile, profile);
    });
  }

  it("classifier and policy retain the current model for ambiguous input", () => {
    const classification = classify({ text: "perhaps something" });
    const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.equal(classification.phase, "unknown");
    assert.ok(classification.confidence < 0.5);
    assert.equal(route.profile, null);
    assert.ok(route.reasonCodes.includes("policy.low-confidence"));
  });

  it("read-only questions are classified with read-only mutation intent", () => {
    const classification = classify({ text: "Explain how this function works" });
    assert.equal(classification.mutationIntent, "read-only");
  });

  it("implementation questions are classified with mutation intent", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    assert.equal(classification.mutationIntent, "mutation");
  });

  it("tool observations merge requirements monotonically and preserve protected risk", () => {
    const protectedVision = classify({
      text: "Review this authentication screenshot with structured validation",
      imageCount: 1,
    });
    assert.equal(protectedVision.risk, "protected");
    assert.equal(protectedVision.requiredCapabilities.image, true);
    const afterEdit = observeToolPhase(protectedVision, "edit");
    assert.equal(afterEdit.phase, "implement");
    assert.equal(afterEdit.risk, "protected");
    assert.equal(afterEdit.requiredCapabilities.image, true);
    assert.equal(afterEdit.requiredCapabilities.structuredOutput, true);
    assert.equal(afterEdit.requiredCapabilities.tools, true);
    assert.ok(afterEdit.requiredCapabilities.contextWindow >= protectedVision.requiredCapabilities.contextWindow);
    const afterReview = observeToolPhase(afterEdit, "review");
    assert.equal(afterReview.requiredCapabilities.image, true);
    assert.equal(afterReview.requiredCapabilities.structuredOutput, true);
    assert.equal(afterReview.risk, "protected");
  });
});

describe("capability policy", () => {
  it("capability floors prevent vision routing to text-only profiles", () => {
    const classification = classify({ text: "check this image", imageCount: 1 });
    const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.equal(route.profile, "vision", "vision is preferred for image work");
    for (const evaluation of route.evaluations.filter((item) => item.profile !== "vision" && item.profile !== "design")) {
      assert.equal(evaluation.eligible, false, `${evaluation.profile} should be ineligible for image work`);
      assert.ok(evaluation.reasons.includes("capability.image"));
    }
    // design is intentionally image-capable (UI/visual work) and must be eligible.
    const design = route.evaluations.find((item) => item.profile === "design");
    assert.equal(design?.eligible, true);
  });

  it("capability floors cover tools, reasoning, structured output, and context", () => {
    const config = validConfig();
    const classification = classify({ text: "review and validate this pull request" });
    const route = recommend({ classification, config, resolvedModels: allModels, providerReady: true });
    const fast = route.evaluations.find((item) => item.profile === "fast");
    assert.deepEqual(fast?.reasons, ["capability.reasoning", "capability.structured-output", "capability.context-window"]);
  });
});
