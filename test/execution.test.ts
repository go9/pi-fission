import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideBackend, nodeAgentName, delegateV2, SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT } from "../src/execution.ts";
import type { FusionConfig, WorkflowNode } from "../src/types.ts";
import { validConfig } from "../test-support/helpers.ts";

function node(kind: WorkflowNode["kind"]): WorkflowNode {
  return { id: "n1", kind, profile: "code", status: "running", dependsOn: [], createdAt: "x", startedAt: null, finishedAt: null, evidence: [], retryCount: 0, reopenCount: 0 };
}

function fakePi(respond: (request: unknown) => void) {
  const handlers = new Map<string, (event: unknown) => void>();
  const bus = {
    on(event: string, handler: (event: unknown) => void) { handlers.set(event, handler); },
    off(event: string) { handlers.delete(event); },
    emit(event: string, payload: unknown) {
      if (event === SUBAGENT_DELEGATION_REQUEST_EVENT) setImmediate(() => respond(payload));
      else if (event === SUBAGENT_DELEGATION_RESPONSE_EVENT) {
        const handler = handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT);
        if (handler) setImmediate(() => handler(payload));
      }
    },
  };
  return { api: { events: bus }, bus, handlers };
}

describe("execution backend decision", () => {
  it("delegates read-only specialist nodes under the fanout cap", () => {
    const config = validConfig();
    for (const kind of ["explore", "research", "review", "plan-review"] as const) {
      const decision = decideBackend({ node: node(kind), config, concurrency: 0 });
      assert.equal(decision.backend, "delegated", kind);
      assert.equal(decision.reason, "fresh-context-read");
    }
  });

  it("stays direct for writer work and at fanout cap", () => {
    const config = validConfig();
    assert.equal(decideBackend({ node: node("implement"), config, concurrency: 0 }).backend, "direct");
    assert.equal(decideBackend({ node: node("regression"), config, concurrency: 0 }).backend, "direct");
    const atCap = decideBackend({ node: node("research"), config, concurrency: config.tuning.maxFanout });
    assert.equal(atCap.backend, "direct");
    assert.equal(atCap.reason, "fanout-at-cap");
  });

  it("maps node kinds to pi-subagents agent names", () => {
    assert.equal(nodeAgentName("explore"), "scout");
    assert.equal(nodeAgentName("research"), "researcher");
    assert.equal(nodeAgentName("plan"), "planner");
    assert.equal(nodeAgentName("implement"), "worker");
    assert.equal(nodeAgentName("review"), "reviewer");
  });
});

describe("V2 delegation protocol producer", () => {
  it("emits a V2 request and resolves the terminal response with usage", async () => {
    const config = validConfig();
    let captured: unknown = null;
    const runtime = fakePi((request) => {
      captured = request;
      // Respond synchronously on the same bus.
      const response = {
        type: SUBAGENT_DELEGATION_RESPONSE_EVENT,
        requestId: (request as { requestId: string }).requestId,
        status: "success",
        output: "fresh scout result",
        usage: { tokens: 120 },
      };
      runtime.bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, response);
    });
    const result = await delegateV2({
      pi: runtime.api as never, config, profile: "research", repo: "/repo",
      nodeId: "n1", ownerRunId: "workflow-1", agent: "researcher",
      task: "research x", context: "fresh",
    });
    assert.equal(result.ok, true);
    assert.equal(result.output, "fresh scout result");
    assert.deepEqual(result.usage, { tokens: 120 });
    const request = captured as Record<string, unknown>;
    assert.equal(request.version, 2);
    assert.equal(request.ownerRunId, "workflow-1");
    assert.equal(request.nodeId, "n1");
    assert.equal(request.model, config.profiles.research.modelId);
  });

  it("reports duplicate_node and timeout as failures", async () => {
    const config = validConfig();
    const runtime = fakePi((request) => {
      runtime.bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        type: SUBAGENT_DELEGATION_RESPONSE_EVENT,
        requestId: (request as { requestId: string }).requestId,
        status: "duplicate_node",
      });
    });
    const dup = await delegateV2({
      pi: runtime.api as never, config, profile: "code", repo: "/repo",
      nodeId: "n1", ownerRunId: "w", agent: "worker", task: "x", context: "fresh",
    });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.ok, false);
  });
});
