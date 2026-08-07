import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ApprovalEnvelope,
  CanonicalProfile,
  Classification,
  FusionConfig,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowState,
  WorkflowStatus,
} from "./types.ts";

export type { ApprovalEnvelope, CanonicalProfile, Classification, WorkflowNode, WorkflowNodeKind, WorkflowState, WorkflowStatus };
import { CANONICAL_PROFILES } from "./types.ts";
import { defaultConfigPath } from "./config.ts";

/** Map a classification to the ordered workflow nodes required for delivery. */
export function planWorkflow(classification: Classification, mutationIntent?: "read-only" | "mutation" | "unknown"): WorkflowNodeKind[] {
  const intent = mutationIntent ?? classification.mutationIntent;
  if (intent === "read-only") {
    // Read-only questions answer directly; no delivery stages.
    return [];
  }
  const nodes: WorkflowNodeKind[] = ["plan", "plan-review"];
  switch (classification.phase) {
    case "research":
      nodes.push("research", "implement");
      break;
    case "review":
      nodes.push("implement", "review");
      break;
    case "implement":
      nodes.push("implement", "review");
      break;
    case "vision":
      nodes.push("explore", "implement");
      break;
    default:
      nodes.push("explore", "research", "implement", "review");
  }
  nodes.push("regression");
  if (classification.risk === "protected" || classification.risk === "high") {
    nodes.push("release-readiness");
  }
  return nodes;
}

function nodeKindDependencies(kind: WorkflowNodeKind): string[] {
  // Order is deterministic; dependencies are previous nodes of the same workflow.
  return [];
}

export function createWorkflowState(input: {
  repo: string;
  adapter: "session" | "flicker";
  flickerTicketId: string | null;
  classification: Classification;
  mode: FusionConfig["mode"];
  ownerSession: string;
  ownerPid: number;
  now?: () => Date;
}): WorkflowState {
  const now = input.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const kinds = planWorkflow(input.classification);
  const nodes: WorkflowNode[] = kinds.map((kind, index) => ({
    id: `node-${index + 1}`,
    kind,
    profile: null,
    status: index === 0 ? "pending" : "pending",
    dependsOn: nodeKindDependencies(kind),
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    evidence: [],
  }));
  return {
    id: randomUUID(),
    repo: input.repo,
    adapter: input.adapter,
    flickerTicketId: input.flickerTicketId,
    status: kinds.length === 0 ? "complete" : "awaiting-approval",
    nodes,
    envelope: null,
    mode: input.mode,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerSession: input.ownerSession,
    ownerPid: input.ownerPid,
  };
}

export function approveWorkflow(workflow: WorkflowState, envelope: Omit<ApprovalEnvelope, "version" | "approvedAt">): WorkflowState {
  const updated: WorkflowState = {
    ...workflow,
    status: "running",
    envelope: { ...envelope, version: (workflow.envelope?.version ?? 0) + 1, approvedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  const firstPending = updated.nodes.find((node) => node.status === "pending");
  if (firstPending) {
    updated.nodes = updated.nodes.map((node) => (node.id === firstPending.id ? { ...node, status: "running", startedAt: new Date().toISOString() } : node));
  }
  return updated;
}

export function advanceWorkflow(workflow: WorkflowState, nodeId: string, status: "passed" | "failed" | "blocked", error?: string, now?: () => Date): WorkflowState {
  const timestamp = (now ?? (() => new Date()))().toISOString();
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node) return workflow;
  const updatedNodes = workflow.nodes.map((item) => {
    if (item.id !== nodeId) return item;
    return { ...item, status, finishedAt: timestamp, error };
  });
  if (status === "failed" || status === "blocked") {
    return { ...workflow, nodes: updatedNodes, status: "blocked", updatedAt: timestamp };
  }
  // Advance to the next pending node whose dependencies are satisfied.
  const next = updatedNodes.find((item) => item.status === "pending" && item.dependsOn.every((dep) => {
    const depNode = updatedNodes.find((candidate) => candidate.id === dep);
    return depNode?.status === "passed";
  }));
  const finalNodes = next
    ? updatedNodes.map((item) => (item.id === next.id ? { ...item, status: "running" as const, startedAt: timestamp } : item))
    : updatedNodes;
  const allDone = finalNodes.every((item) => item.status === "passed" || item.status === "skipped" || item.status === "cancelled");
  return {
    ...workflow,
    nodes: finalNodes,
    status: allDone ? "complete" : workflow.status,
    updatedAt: timestamp,
  };
}

export function cancelWorkflow(workflow: WorkflowState, now?: () => Date): WorkflowState {
  const timestamp = (now ?? (() => new Date()))().toISOString();
  return {
    ...workflow,
    status: "cancelled",
    nodes: workflow.nodes.map((node) => (node.status === "pending" || node.status === "running" ? { ...node, status: "cancelled" as const, finishedAt: timestamp } : node)),
    updatedAt: timestamp,
  };
}

export function pauseWorkflow(workflow: WorkflowState): WorkflowState {
  if (workflow.status !== "running") return workflow;
  return { ...workflow, status: "paused", updatedAt: new Date().toISOString() };
}

export function resumeWorkflow(workflow: WorkflowState): WorkflowState {
  if (workflow.status !== "paused") return workflow;
  return { ...workflow, status: "running", updatedAt: new Date().toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Session adapter: workflow truth persists under the Pi agent data directory, keyed by repo. */
export function workflowStorePath(configPath = defaultConfigPath()): string {
  return join(dirname(configPath), "pi-fusion.workflows.json");
}

export async function loadWorkflows(path = workflowStorePath()): Promise<WorkflowState[]> {
  try {
    const text = await readFile(path, "utf8");
    const raw: unknown = JSON.parse(text);
    if (Array.isArray(raw)) return raw.filter(isRecord) as unknown as WorkflowState[];
  } catch {
    // Missing or malformed store is treated as empty.
  }
  return [];
}

export async function saveWorkflows(workflows: WorkflowState[], path = workflowStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(workflows, null, 2)}\n`, "utf8");
}

export async function upsertWorkflow(workflow: WorkflowState, path = workflowStorePath()): Promise<void> {
  const workflows = await loadWorkflows(path);
  const index = workflows.findIndex((item) => item.id === workflow.id);
  if (index >= 0) workflows[index] = workflow;
  else workflows.push(workflow);
  await saveWorkflows(workflows, path);
}

/** Active workflows for a repository in the current session. */
export async function activeWorkflowForRepo(repo: string, ownerSession: string, path = workflowStorePath()): Promise<WorkflowState | null> {
  const workflows = await loadWorkflows(path);
  return workflows.find((item) => item.repo === repo && item.ownerSession === ownerSession && (item.status === "running" || item.status === "paused" || item.status === "awaiting-approval")) ?? null;
}

/** Concurrent-session ownership warning: another session owns a live workflow on this repo. */
export async function foreignOwnerForRepo(repo: string, ownerSession: string, path = workflowStorePath()): Promise<WorkflowState | null> {
  const workflows = await loadWorkflows(path);
  return workflows.find((item) => item.repo === repo && item.ownerSession !== ownerSession && (item.status === "running" || item.status === "paused" || item.status === "awaiting-approval")) ?? null;
}
