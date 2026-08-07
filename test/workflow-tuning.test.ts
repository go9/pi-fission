import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classify } from "../src/classifier.ts";
import {
  activeWorkflowForRepo,
  advanceWorkflow,
  approveWorkflow,
  cancelWorkflow,
  createWorkflowState,
  foreignOwnerForRepo,
  loadWorkflows,
  pauseWorkflow,
  planWorkflow,
  resumeWorkflow,
  retryBlockedWorkflow,
  reopenWorkflowAt,
  saveWorkflows,
  upsertWorkflow,
  withRepoWorkflowLock,
} from "../src/workflow.ts";
import { recordOutcome, buildTuningProposal, loadProposals, saveProposal, applyProposal, rollbackProposal, loadOutcomes } from "../src/tuning.ts";
import type { CanonicalProfile, OutcomeRecord } from "../src/types.ts";
import { validConfig } from "../test-support/helpers.ts";

describe("workflow planning and runtime", () => {
  it("plans no delivery stages for read-only questions", () => {
    const classification = classify({ text: "Explain how this function works" });
    assert.deepEqual(planWorkflow(classification), []);
  });

  it("plans delivery stages for mutation questions", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    const kinds = planWorkflow(classification);
    assert.ok(kinds.includes("plan"));
    assert.ok(kinds.includes("implement"));
    assert.ok(kinds.includes("review"));
    assert.ok(kinds.includes("regression"));
  });

  it("adds release-readiness for protected work", () => {
    const classification = classify({ text: "Implement an authentication and permissions migration" });
    const kinds = planWorkflow(classification);
    assert.ok(kinds.includes("release-readiness"));
  });

  it("approval envelope advances the workflow and gates mutation", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    assert.equal(workflow.status, "awaiting-approval");
    assert.equal(workflow.envelope, null);
    workflow = approveWorkflow(workflow, {
      scope: "implement helper", acceptance: ["tests pass"], worktree: "/repo", writer: "w1",
      authority: ["local-commit"], profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 3, maxSwitches: 4, budgetTokens: null,
    });
    assert.equal(workflow.status, "running");
    assert.ok(workflow.envelope);
    assert.equal(workflow.envelope?.version, 1);
    assert.equal(workflow.nodes.find((node) => node.status === "running")?.kind, "plan");
  });

  it("advances nodes in order and blocks on failure", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    workflow = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 3, maxSwitches: 4, budgetTokens: null,
    });
    const first = workflow.nodes.find((node) => node.status === "running");
    assert.ok(first);
    workflow = advanceWorkflow(workflow, first!.id, "failed", "tests red");
    assert.equal(workflow.status, "blocked");
  });

  it("refuses to pass implement and regression nodes without tool evidence", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    workflow = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 3, maxSwitches: 4, budgetTokens: null,
    });
    workflow = advanceWorkflow(workflow, workflow.nodes.find((node) => node.status === "running")!.id, "passed");
    workflow = advanceWorkflow(workflow, workflow.nodes.find((node) => node.status === "running")!.id, "passed");
    const implement = workflow.nodes.find((node) => node.status === "running")!;
    assert.equal(implement.kind, "implement");
    workflow = advanceWorkflow(workflow, implement.id, "passed");
    assert.equal(workflow.status, "blocked");
    assert.equal(workflow.nodes.find((node) => node.id === implement.id)?.error, "missing in-worktree mutation or changed-files commit evidence");

    workflow = retryBlockedWorkflow(workflow, 3);
    workflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === implement.id ? { ...node, evidence: ["mutation:write:in-worktree", "git:commit:changed-files"] } : node),
    };
    workflow = advanceWorkflow(workflow, implement.id, "passed");
    assert.equal(workflow.nodes.find((node) => node.id === implement.id)?.status, "passed");
    workflow = advanceWorkflow(workflow, workflow.nodes.find((node) => node.status === "running")!.id, "passed");
    const regression = workflow.nodes.find((node) => node.status === "running")!;
    assert.equal(regression.kind, "regression");
    workflow = advanceWorkflow(workflow, regression.id, "passed");
    assert.equal(workflow.status, "blocked");
    assert.equal(workflow.nodes.find((node) => node.id === regression.id)?.error, "missing regression evidence");
  });

  it("reopens an upstream node and invalidates downstream evidence", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    workflow = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 2, maxSwitches: 4, budgetTokens: null,
    });
    workflow = advanceWorkflow(workflow, workflow.nodes.find((node) => node.status === "running")!.id, "passed");
    workflow = advanceWorkflow(workflow, workflow.nodes.find((node) => node.status === "running")!.id, "passed");
    const implement = workflow.nodes.find((node) => node.status === "running")!;
    workflow = { ...workflow, nodes: workflow.nodes.map((node) => node.id === implement.id ? { ...node, evidence: ["mutation:write:in-worktree", "git:commit:changed-files"] } : node) };
    workflow = advanceWorkflow(workflow, implement.id, "passed");
    const review = workflow.nodes.find((node) => node.status === "running")!;
    workflow = advanceWorkflow(workflow, review.id, "failed", "missing file");
    assert.equal(reopenWorkflowAt(workflow, "regression", 2), workflow, "cannot bypass an upstream failure by reopening a downstream node");
    workflow = reopenWorkflowAt(workflow, "implement", 2);
    assert.equal(workflow.status, "running");
    assert.equal(workflow.nodes.find((node) => node.kind === "implement")?.status, "running");
    assert.equal(workflow.nodes.find((node) => node.kind === "implement")?.reopenCount, 1);
    assert.deepEqual(workflow.nodes.find((node) => node.kind === "implement")?.evidence, []);
    assert.ok(workflow.nodes.filter((node) => ["review", "regression"].includes(node.kind)).every((node) => node.status === "pending" && node.evidence.length === 0));
  });

  it("retries a blocked node only within the approved retry cap", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    workflow = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 1, maxSwitches: 4, budgetTokens: null,
    });
    const first = workflow.nodes.find((node) => node.status === "running")!;
    workflow = advanceWorkflow(workflow, first.id, "failed", "transient provider error");
    workflow = retryBlockedWorkflow(workflow, 1, () => new Date("2026-01-01T00:00:00Z"));
    assert.equal(workflow.status, "running");
    assert.equal(workflow.nodes.find((node) => node.id === first.id)?.status, "running");
    assert.equal(workflow.nodes.find((node) => node.id === first.id)?.retryCount, 1);
    assert.deepEqual(workflow.nodes.find((node) => node.id === first.id)?.evidence, []);
    workflow = advanceWorkflow(workflow, first.id, "failed", "still failing");
    assert.equal(retryBlockedWorkflow(workflow, 1), workflow, "exhausted retry returns the unchanged blocked workflow");
    assert.equal(reopenWorkflowAt(workflow, first.kind, 1), workflow, "retry and reopen share one monotonic attempt budget");
  });

  it("pause, resume, and cancel transitions are idempotent and reversible", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    let workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    workflow = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 3, maxSwitches: 4, budgetTokens: null,
    });
    workflow = pauseWorkflow(workflow);
    assert.equal(workflow.status, "paused");
    workflow = resumeWorkflow(workflow);
    assert.equal(workflow.status, "running");
    workflow = cancelWorkflow(workflow);
    assert.equal(workflow.status, "cancelled");
    assert.ok(workflow.nodes.every((node) => node.status !== "running"));
  });

  it("serializes cross-process-style repository ownership checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fusion-lock-"));
    const storePath = join(dir, "workflows.json");
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 4 }, () => withRepoWorkflowLock("/repo", storePath, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    })));
    assert.equal(maxActive, 1);
  });

  it("session store persists workflows and warns on foreign ownership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fusion-workflow-"));
    const storePath = join(dir, "workflows.json");
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    const workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    await upsertWorkflow(workflow, storePath);
    const loaded = await loadWorkflows(storePath);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, workflow.id);
    const mine = await activeWorkflowForRepo("/repo", "s1", storePath);
    assert.equal(mine?.id, workflow.id);
    const foreign = await foreignOwnerForRepo("/repo", "s2", storePath);
    assert.ok(foreign, "a second session sees the first session's active workflow as foreign ownership");

    let blocked = approveWorkflow(workflow, {
      scope: "x", acceptance: [], worktree: "/repo", writer: "w1", authority: ["local-commit"],
      profile: "code", maxFanout: 4, maxDepth: 2, maxRetries: 1, maxSwitches: 4, budgetTokens: null,
    });
    blocked = advanceWorkflow(blocked, blocked.nodes.find((node) => node.status === "running")!.id, "failed", "provider error");
    await upsertWorkflow(blocked, storePath);
    assert.equal((await activeWorkflowForRepo("/repo", "s1", storePath))?.status, "blocked", "blocked workflow remains recoverable after restart");
    assert.equal((await foreignOwnerForRepo("/repo", "s2", storePath))?.status, "blocked", "blocked workflow still owns the repository");
    await saveWorkflows([], storePath);
    assert.equal((await loadWorkflows(storePath)).length, 0);
  });
});

describe("permission-gated tuning", () => {
  function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
    return {
      schemaVersion: 1, timestamp: "2026-01-01T00:00:00.000Z", workflowId: null, nodeKind: null,
      profile: "code", backend: "direct", routeConfidence: 0.9, phase: "implement", risk: "medium",
      accepted: true, retries: 0, switches: 0, usage: {}, failure: null, tuningVersion: 0,
      ...overrides,
    };
  }

  it("requires sufficient evidence before proposing a tuning change", async () => {
    const config = validConfig();
    const sparse = Array.from({ length: 2 }, () => outcome());
    const proposal = buildTuningProposal({
      config, outcomes: sparse, description: "x", kind: "circuit-breaker",
      diff: { maxRetries: 2 }, expectedImpact: "lower retry", scope: "global",
    });
    assert.equal(proposal, null, "below minEvidence produces no proposal");
  });

  it("proposes with evidence, requires explicit approval, and rolls back atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-fusion-tuning-"));
    const configPath = join(dir, "pi-fusion.json");
    const config = validConfig();
    await recordOutcome(config, outcome(), configPath);
    const outcomes = await loadOutcomes(config, configPath);
    assert.equal(outcomes.length, 1);
    const configWithEvidence = validConfig({ tuning: { ...config.tuning, minEvidence: 1 } });
    const proposal = buildTuningProposal({
      config: configWithEvidence, outcomes, description: "lower retry ceiling", kind: "retry",
      diff: { maxRetries: 2 }, expectedImpact: "bounded retries", scope: "global",
    });
    assert.ok(proposal);
    assert.equal(proposal.status, "proposed");
    await saveProposal(proposal!, configPath);
    assert.equal((await loadProposals(configPath)).length, 1);
    const applied = await applyProposal(proposal!, configPath);
    assert.equal(applied.status, "applied");
    assert.equal(applied.applied, true);
    assert.ok(applied.rollback, "rollback snapshot is captured before future-only application");
    const rolled = await rollbackProposal(applied, configPath);
    assert.equal(rolled.status, "rolled-back");
    assert.equal(rolled.applied, false);
  });
});

describe("workflow node profile mapping and forced routing", () => {
  it("assigns every workflow node a semantic profile", () => {
    const classification = classify({ text: "Implement a TypeScript helper and tests" });
    const workflow = createWorkflowState({
      repo: "/repo", adapter: "session", flickerTicketId: null, classification,
      mode: "active", ownerSession: "s1", ownerPid: 1,
    });
    for (const node of workflow.nodes) {
      assert.ok(node.profile, `node ${node.kind} has a profile`);
    }
    assert.equal(workflow.nodes.find((node) => node.kind === "plan")?.profile, "reason");
    assert.equal(workflow.nodes.find((node) => node.kind === "implement")?.profile, "code");
    assert.equal(workflow.nodes.find((node) => node.kind === "review")?.profile, "review");
  });

  it("forceProfile routes through the workflow node profile when eligible", async () => {
    const { recommend } = await import("../src/policy.ts");
    const allModels = Object.fromEntries(
      ["fast", "code", "reason", "review", "research", "vision", "design"].map((p) => [p, p]),
    ) as Record<CanonicalProfile, string>;
    const classification = classify({ text: "implement a code fix" });
    const route = recommend({
      classification, config: validConfig(), resolvedModels: allModels, providerReady: true,
      forceProfile: "review",
    });
    assert.equal(route.profile, "review");
    assert.ok(route.reasonCodes.includes("policy.workflow-node"));
  });
});
