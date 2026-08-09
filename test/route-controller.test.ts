import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beginPrompt,
  beginRoute,
  createRouteState,
  decideModelSelect,
  endRoute,
  expectSelection,
  observeThinkingSelect,
  takeQueuedSelection,
  type RouteState,
} from "../src/route-controller.ts";

const model = (id: string, provider = "9router") => ({ provider, id }) as any;

/** A state that has seen a prompt, which is what makes an unexplained selection an override. */
function afterPrompt(): RouteState {
  const state = createRouteState();
  beginPrompt(state);
  return state;
}

describe("route controller", () => {
  it("recognizes our own selection no matter how much time has passed", () => {
    const state = afterPrompt();
    expectSelection(state, model("original", "existing"));
    const realNow = Date.now;
    try {
      // The decision consults no clock at all. The implementation this replaced gave up
      // after 3000ms and then read its own restore echo as a manual override, which
      // silently disabled automatic routing for the rest of the session.
      Date.now = () => realNow() + 86_400_000;
      assert.equal(decideModelSelect(state, { model: model("original", "existing"), source: "set" }), "adopt");
    } finally {
      Date.now = realNow;
    }
  });

  it("retires exactly one expectation per event, so a repeated switch is not over-absorbed", () => {
    const state = afterPrompt();
    // Two switches to the same group in one turn -- route, restore, route again -- owe us
    // two echoes. Clearing every match on the first would leave the second unaccounted for.
    expectSelection(state, model("code"));
    expectSelection(state, model("code"));
    assert.equal(decideModelSelect(state, { model: model("code"), source: "set" }), "adopt");
    assert.equal(decideModelSelect(state, { model: model("code"), source: "set" }), "adopt");
    // The third event has no expectation left to claim: the user really did pick it.
    assert.equal(decideModelSelect(state, { model: model("code"), source: "set" }), "override");
  });

  it("queues a user selection that lands mid-restore instead of losing or obeying it", () => {
    const state = afterPrompt();
    beginRoute(state, { model: model("original", "existing"), thinkingLevel: "high" }, true);
    state.phase = { kind: "restoring", restore: { model: model("original", "existing"), thinkingLevel: "high" }, changedModel: true };
    expectSelection(state, model("original", "existing"));

    // Our own restore echo is still recognized while restoring.
    assert.equal(decideModelSelect(state, { model: model("original", "existing"), source: "set" }), "adopt");
    // Anything else during the restore is the user, deferred until the restore finishes.
    assert.equal(decideModelSelect(state, { model: model("review"), source: "set" }), "queue");

    state.queuedSelections.push(model("review"));
    assert.deepEqual(takeQueuedSelection(state), model("review"));
    assert.equal(takeQueuedSelection(state), null);
  });

  it("never reads the host re-applying a model as a user decision", () => {
    const state = afterPrompt();
    assert.equal(decideModelSelect(state, { model: model("anything"), source: "restore" }), "adopt");
  });

  it("treats a selection before the first prompt as a startup default", () => {
    const state = createRouteState();
    assert.equal(decideModelSelect(state, { model: model("deepseek", "opencode-go"), source: "set" }), "adopt");
    // ...but an explicit cycle is a user action whenever it happens.
    assert.equal(decideModelSelect(createRouteState(), { model: model("x"), source: "cycle" }), "override");
  });

  it("drops stale expectations at the next prompt so a real user pick is honored", () => {
    const state = afterPrompt();
    expectSelection(state, model("code"));
    // The host never delivered the echo. A new turn makes anything still owed us stale,
    // which bounds the expectation without appealing to wall-clock time.
    beginPrompt(state);
    assert.equal(decideModelSelect(state, { model: model("code"), source: "set" }), "override");
  });

  it("records a user thinking-level change during a route and ignores its own", () => {
    const state = afterPrompt();
    beginRoute(state, { model: model("original", "existing"), thinkingLevel: "high" }, true);

    // Ours: an explicit level we asked for.
    state.expectedThinkingLevel = "medium";
    observeThinkingSelect(state, { previousLevel: "high", level: "medium" });
    assert.equal(state.userThinkingLevel, null, "our own level change is not a user preference");
    assert.equal(state.expectedThinkingLevel, null, "the expectation is retired once matched");

    // Theirs: nothing of ours explains it while a route is in progress.
    observeThinkingSelect(state, { previousLevel: "high", level: "low" });
    assert.equal(state.userThinkingLevel, "low");
  });

  it("ignores thinking-level changes outside a route", () => {
    const state = afterPrompt();
    observeThinkingSelect(state, { previousLevel: "high", level: "low" });
    assert.equal(state.userThinkingLevel, null, "with no route in flight there is nothing to restore");
  });

  it("ends a route without stranding the level it was holding for the restore", () => {
    const state = afterPrompt();
    beginRoute(state, { model: model("original", "existing"), thinkingLevel: "high" }, true);
    observeThinkingSelect(state, { previousLevel: "high", level: "low" });
    assert.equal(state.userThinkingLevel, "low");

    endRoute(state);
    assert.equal(state.phase.kind, "idle");
    assert.equal(state.userThinkingLevel, null, "a level from an abandoned route must not leak into the next one");
  });
});
