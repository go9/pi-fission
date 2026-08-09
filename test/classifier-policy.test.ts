import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/classifier.ts";
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

  it("mutation-intent phrasing routes to implement, not clarify or explore", () => {
    const prompts = [
      "How do I fix this bug in the login form?",
      "How can we add pagination to the table?",
      "What is the best way to refactor this module?",
      "quick fix for the crash in the parser",
      "make a small change to fix the bug",
      "find and fix the memory leak",
    ];
    for (const text of prompts) {
      const classification = classify({ text });
      assert.equal(classification.phase, "implement", `"${text}" should classify as implement, got ${classification.phase}`);
      assert.equal(classification.mutationIntent, "mutation");
    }
  });

  it("genuine clarifying questions without mutation verbs still route to clarify", () => {
    const classification = classify({ text: "How do I use this API?" });
    assert.equal(classification.phase, "clarify");
    assert.equal(classification.mutationIntent, "read-only");
  });

  it("a mutation on a protected topic still escalates to protected risk and the reason profile", () => {
    const classification = classify({ text: "Implement an authentication and permissions migration" });
    assert.equal(classification.risk, "protected");
    assert.equal(classification.mutationIntent, "mutation");
    const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.equal(route.profile, "reason");
  });

  it("a read-only question about a protected topic is not escalated", () => {
    for (const text of [
      "Explain how our authentication works",
      "What does the deploy script do?",
      "How does the billing migration work?",
    ]) {
      const classification = classify({ text });
      assert.equal(classification.mutationIntent, "read-only", text);
      assert.notEqual(classification.risk, "protected", `"${text}" is a question, not a risky operation`);
      const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
      assert.notEqual(route.profile, "reason", `"${text}" must not burn the reason profile`);
    }
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

describe("design phase", () => {
  it("design-flavored image prompts route to the design profile, not generic vision", () => {
    const classification = classify({ text: "Design a mockup for the settings screen", imageCount: 1 });
    assert.equal(classification.phase, "design");
    const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.equal(route.profile, "design");
  });

  it("generic image prompts without design language still route to vision", () => {
    const classification = classify({ text: "check this screenshot for a rendering bug", imageCount: 1 });
    assert.equal(classification.phase, "vision");
    const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
    assert.equal(route.profile, "vision");
  });

  it("text-only UI work reaches the design profile without an attached image", () => {
    for (const text of [
      "Design a mockup for the settings screen",
      "Redesign the inventory page UI",
      "Improve the UX layout of this wireframe",
      "Inspect the inventory pages and improve their usability",
    ]) {
      const classification = classify({ text });
      assert.equal(classification.phase, "design", text);
      assert.equal(classification.requiredCapabilities.image, false, "a text prompt must not demand image capability");
      const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
      assert.equal(route.profile, "design", text);
    }
  });

  it("architecture planning and UI implementation are not stolen by the design phase", () => {
    assert.equal(classify({ text: "Design an architecture plan and trade-offs" }).phase, "plan");
    assert.equal(classify({ text: "Implement the new settings screen layout" }).phase, "implement");
  });

  describe("phase continuity across a session", () => {
    const previous = classify({ text: "Implement a TypeScript helper and tests" });

    it("a follow-up with no phase vocabulary continues the established phase and still routes", () => {
      for (const text of ["ok do that", "now the other one", "yes please", "same for the second file"]) {
        const classification = classify({ text, previous });
        assert.equal(classification.phase, "implement", text);
        assert.ok(classification.reasonCodes.includes("phase.continued"), text);
        const route = recommend({ classification, config: validConfig(), resolvedModels: allModels, providerReady: true });
        assert.equal(route.profile, "code", text);
      }
    });

    it("a continued turn inherits capabilities and mutation intent, not just the phase name", () => {
      const classification = classify({ text: "ok do that", previous });
      assert.equal(classification.mutationIntent, previous.mutationIntent);
      assert.deepEqual(classification.requiredCapabilities, previous.requiredCapabilities);
      assert.equal(classification.risk, previous.risk);
    });

    it("an inherited phase never outranks an observed one", () => {
      const continued = classify({ text: "ok do that", previous });
      assert.ok(continued.confidence < previous.confidence);
      // The weakest direct match must still beat a continuation.
      const weakestDirect = classify({ text: "what is this" });
      assert.equal(weakestDirect.phase, "clarify");
      assert.ok(continued.confidence < weakestDirect.confidence);
    });

    it("a follow-up that names its own phase is classified on its own terms", () => {
      const classification = classify({ text: "now review this pull request", previous });
      assert.equal(classification.phase, "review");
      assert.ok(!classification.reasonCodes.includes("phase.continued"));
    });

    it("continuity does not manufacture a phase out of nothing", () => {
      assert.equal(classify({ text: "perhaps something" }).phase, "unknown");
      const unknownPrevious = classify({ text: "perhaps something" });
      const afterUnknown = classify({ text: "ok do that", previous: unknownPrevious });
      assert.equal(afterUnknown.phase, "unknown");
      // The log must not claim a phase was continued when none was ever established.
      assert.ok(!afterUnknown.reasonCodes.includes("phase.continued"));
      assert.equal(classify({ text: "", previous }).phase, "unknown");
      assert.ok(classify({ text: "", previous }).reasonCodes.includes("input.empty"));
    });

    it("confidence decays along a chain and never drifts up", () => {
      let current = classify({ text: "keep going", previous });
      for (let turn = 0; turn < 4; turn += 1) {
        const next = classify({ text: "keep going", previous: current });
        assert.equal(next.phase, "implement");
        assert.ok(next.confidence < current.confidence, `turn ${turn} must lose confidence`);
        current = next;
      }
    });

    it("a chain stops routing once it outruns its evidence", () => {
      const config = validConfig();
      let current = previous;
      const routed: boolean[] = [];
      for (let turn = 0; turn < 10; turn += 1) {
        current = classify({ text: "keep going", previous: current });
        routed.push(recommend({ classification: current, config, resolvedModels: allModels, providerReady: true }).profile !== null);
      }
      assert.ok(routed[0], "an immediate follow-up must still route");
      assert.ok(!routed[routed.length - 1], "a long chain must stop assuming the phase holds");
      // Once it gives up it must stay given up, not oscillate back into routing.
      const firstGiveUp = routed.indexOf(false);
      assert.ok(routed.slice(firstGiveUp).every((value) => value === false));
    });

    it("an escalated risk level is not inherited indefinitely", () => {
      const protectedTurn = classify({ text: "Implement an authentication and permissions migration" });
      assert.equal(protectedTurn.risk, "protected");
      let current = protectedTurn;
      for (let turn = 0; turn < 10; turn += 1) current = classify({ text: "ok", previous: current });
      const route = recommend({ classification: current, config: validConfig(), resolvedModels: allModels, providerReady: true });
      assert.equal(route.profile, null, "protected risk must not pin the expensive profile forever");
    });
  });
});
