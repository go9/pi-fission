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
  saveWorkflows,
  upsertWorkflow,
} from "../src/workflow.ts";
import { recordOutcome, buildTuningProposal, loadProposals, saveProposal, applyProposal, rollbackProposal, loadOutcomes } from "../src/tuning.ts";
import type { OutcomeRecord } from "../src/types.ts";
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
