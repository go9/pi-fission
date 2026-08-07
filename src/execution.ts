import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CanonicalProfile,
  FusionConfig,
  WorkflowNode,
} from "./types.ts";
import { effectiveProfileTarget } from "./config.ts";

/**
 * pi-subagents execution adapter.
 *
 * Composes the installed pi-subagents public surfaces:
 * - V2 delegation over the shared `pi.events` bus for owned foreground leaves
 *   (fresh/fork context, explicit model, ownership ids, cancellation, usage).
 * - V1/ordinary async acceptance paths are handled by later slices; this
 *   adapter exposes a deterministic decision function and a V2 producer.
 *
 * The protocol constants mirror pi-subagents 0.37.2 `src/api/delegation.ts`.
 */
export const SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION = 2 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export type ExecutionBackend = "direct" | "delegated";

/** Deterministic decision: when fresh context / independence / parallelism is
 *  valuable, delegate; otherwise stay direct in the parent. */
export function decideBackend(input: {
  node: WorkflowNode;
  config: FusionConfig;
  concurrency: number;
}): { backend: ExecutionBackend; reason: string } {
  const { node, config } = input;
  if (node.kind === "explore" || node.kind === "research" || node.kind === "review" || node.kind === "plan-review") {
    // Read-only specialist work benefits from fresh context and parallelism.
    if (input.concurrency < config.tuning.maxFanout) {
      return { backend: "delegated", reason: "fresh-context-read" };
    }
    return { backend: "direct", reason: "fanout-at-cap" };
  }
  // Implementation and regression stay with the one writer (direct parent path
  // in this slice; a writer agent backend is a later execution slice).
  return { backend: "direct", reason: "one-writer" };
}

/** The pi-subagents agent name for a workflow node kind. */
export function nodeAgentName(kind: WorkflowNode["kind"]): string {
  switch (kind) {
    case "clarify": return "delegate";
    case "explore": return "scout";
    case "research": return "researcher";
    case "plan": return "planner";
    case "plan-review": return "reviewer";
    case "implement": return "worker";
    case "review": return "reviewer";
    case "regression": return "reviewer";
    case "release-readiness": return "reviewer";
  }
}

export interface DelegateV2Input {
  pi: ExtensionAPI;
  config: FusionConfig;
  profile: CanonicalProfile;
  repo: string;
  nodeId: string;
  ownerRunId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
}

export interface DelegateV2Result {
  ok: boolean;
  status?: string;
  output?: string;
  error?: string;
  usage?: Record<string, unknown>;
  duplicate?: boolean;
}

/**
 * Emit a V2 delegation request over the shared event bus and resolve the
 * terminal response. This composes pi-subagents' own responder: the request
 * event carries ownership ids, an explicit model, budgets, and a result
 * contract, and the responder emits a terminal response with usage.
 */
export async function delegateV2(input: DelegateV2Input): Promise<DelegateV2Result> {
  const requestId = randomUUID();
  const model = input.model ?? effectiveProfileTarget(input.config, input.profile, input.repo);
  const request = {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId,
    ownerRunId: input.ownerRunId,
    nodeId: input.nodeId,
    agent: input.agent,
    task: input.task,
    context: input.context,
    cwd: input.repo,
    model,
    thinking: input.thinking,
    timeoutMs: input.timeoutMs,
    result: { kind: "text" as const },
  };

  return await new Promise<DelegateV2Result>((resolve) => {
    const bus = input.pi.events as { on?(event: string, handler: (event: unknown) => void): void; off?(event: string, handler: (event: unknown) => void): void; emit?(event: string, payload: unknown): void };
    const timeout = setTimeout(() => {
      bus?.off?.(SUBAGENT_DELEGATION_RESPONSE_EVENT, onEvent);
      resolve({ ok: false, error: "delegation timed out", status: "timeout" });
    }, input.timeoutMs ?? 120_000);

    const onEvent = (event: unknown): void => {
      const message = event as { type?: string; requestId?: string };
      if (message?.type !== SUBAGENT_DELEGATION_RESPONSE_EVENT) return;
      if (message.requestId !== requestId) return;
      clearTimeout(timeout);
      bus?.off?.(SUBAGENT_DELEGATION_RESPONSE_EVENT, onEvent);
      const response = message as {
        status?: string;
        output?: string;
        error?: string;
        usage?: Record<string, unknown>;
      };
      resolve({
        ok: response.status === "success" || response.status === "accepted",
        status: response.status,
        output: response.output,
        error: response.error,
        usage: response.usage,
        duplicate: response.status === "duplicate_node",
      });
    };

    // pi.events is the shared bus; dispatch is fire-and-forget on the host.
    if (!bus?.on) {
      resolve({ ok: false, error: "pi-subagents event bus unavailable", status: "unavailable" });
      return;
    }
    bus.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, onEvent);
    bus.emit?.(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  });
}

/** Cancel an in-flight V2 delegation by request id. */
export function cancelDelegation(pi: ExtensionAPI, requestId: string): void {
  const bus = pi.events as { emit?(event: string, payload: unknown): void };
  bus?.emit?.(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId });
}
