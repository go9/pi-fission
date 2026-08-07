import type { ConfigResult } from "./config.ts";
import type { DiscoveryResult } from "./router.ts";
import type { SetupState } from "./types.ts";
import type { Classification, Recommendation, RouteOnceReason, RouteOnceStatus, WorkflowState } from "./types.ts";
import type { TelemetryRecord } from "./telemetry.ts";
import type { TuningProposal } from "./types.ts";
import type { ProbeResult } from "./setup.ts";

export interface FusionView {
  config: ConfigResult;
  discovery: DiscoveryResult | null;
  classification: Classification | null;
  recommendation: Recommendation | null;
  activeModel: string | null;
  setup: SetupState | null;
  workflow: WorkflowState | null;
  foreignOwner: boolean;
  proposals: TuningProposal[];
  mode: string;
  routeOnce?: { status: RouteOnceStatus; reason: RouteOnceReason | null };
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

type Health = "invalid-config" | "unavailable" | "setup-blocked" | "low-confidence" | "no-eligible-profile" | "ready";

function health(view: FusionView): Health {
  if (view.config.status !== "ready" || !view.config.config) return "invalid-config";
  if (view.config.config.mode === "off") return "invalid-config";
  if (view.discovery?.status !== "ready") return "unavailable";
  if (view.config.config.mode === "active" && (!view.setup?.complete || !Object.values(view.setup.probes ?? {}).every((probe) => probe?.ok))) return "setup-blocked";
  if (view.recommendation?.reasonCodes.includes("policy.no-eligible-profile")) return "no-eligible-profile";
  if (view.recommendation?.reasonCodes.includes("policy.low-confidence")) return "low-confidence";
  return "ready";
}

export function footerText(view: FusionView): string {
  const state = health(view);
  const mode = view.config.status === "ready" ? view.config.config.mode : "invalid";
  if (state === "invalid-config") return "fusion: shadow · invalid-config";
  if (state === "unavailable") return "fusion: shadow · unavailable";
  if (state === "setup-blocked") return `fusion: ${mode} · setup-blocked · active not ready`;
  if (state === "low-confidence") return "fusion: shadow · uncertain · current model retained";
  if (state === "no-eligible-profile") return "fusion: shadow · no-eligible-profile · current model retained";
  const workflow = view.workflow;
  const workflowText = workflow ? ` · ${workflow.status}` : "";
  const foreign = view.foreignOwner ? " · ⚠ other-session-active" : "";
  if (!view.classification || !view.recommendation?.profile) return `fusion: ${mode} · ready${workflowText}${foreign}`;
  return `fusion: ${mode} · ${view.classification.phase} → ${view.recommendation.profile}${workflowText}${foreign}`;
}

function oneShotText(view: FusionView): string {
  const status = view.routeOnce?.status;
  if (!status || status === "shadow") return "";
  return ` · one-shot ${status}${view.routeOnce?.reason ? ` (${view.routeOnce.reason})` : ""}`;
}

export function formatStatus(view: FusionView): string {
  const state = health(view);
  const active = view.activeModel ?? "unknown";
  const mode = view.config.status === "ready" ? view.config.config.mode : "invalid";
  const oneShot = oneShotText(view);
  if (state === "invalid-config") {
    return `fusion: ${mode} · invalid-config · ${view.config.diagnostics.join("; ")} · active Pi model: ${active}`;
  }
  if (state === "unavailable") {
    return `fusion: ${mode} · unavailable · ${view.discovery?.diagnostic ?? "discovery not started"}${oneShot} · active Pi model: ${active}`;
  }
  if (state === "setup-blocked") {
    const failing = view.setup ? Object.entries(view.setup.probes).filter(([, probe]) => probe && !probe.ok).map(([profile]) => profile).join(", ") : "unknown";
    return `fusion: active · setup-blocked · profiles failing probe: ${failing} · active Pi model: ${active}`;
  }
  if (!view.classification || !view.recommendation) {
    const workflow = view.workflow ? ` · workflow ${view.workflow.status} (${view.workflow.nodes.length} nodes)` : "";
    return `fusion: ${mode} · ready · no recommendation yet${workflow}${oneShot} · active Pi model: ${active}`;
  }
  if (state === "low-confidence") {
    return `fusion: ${mode} · low-confidence (${percent(view.recommendation.confidence)}) · current model retained${oneShot} · active Pi model: ${active}`;
  }
  if (state === "no-eligible-profile") {
    return `fusion: ${mode} · no-eligible-profile (${percent(view.recommendation.confidence)}) · required capability floor is unmet or profiles are unresolved · current model retained${oneShot} · active Pi model: ${active}`;
  }
  const workflow = view.workflow ? ` · workflow ${view.workflow.status} (${view.workflow.nodes.length} nodes)` : "";
  const foreign = view.foreignOwner ? " · ⚠ other-session-active" : "";
  return `fusion: ${mode} · ready · ${view.classification.phase} → recommended ${view.recommendation.profile} (${percent(view.recommendation.confidence)})${workflow}${oneShot}${foreign} · active Pi model: ${active}`;
}

export function formatSetup(view: FusionView): string {
  if (view.config.status !== "ready") return "fusion setup: unconfigured · run /fusion-setup";
  const setup = view.setup;
  if (!setup || !setup.complete) {
    const probes = Object.entries(setup?.probes ?? {}).map(([profile, probe]) => `${profile}=${probe?.ok ? "ok" : probe?.error ?? "unprobed"}`).join(" · ");
    return `fusion setup: incomplete · mode ${view.config.config.mode} · ${probes || "no probes run"}`;
  }
  return `fusion setup: complete · mode ${view.config.config.mode} · active ${setup.complete ? "ready" : "blocked"} · last probed ${setup.lastProbedAt ?? "never"}`;
}

export function formatWorkflow(workflow: WorkflowState | null): string {
  if (!workflow) return "fusion workflow: none active";
  const lines = workflow.nodes.map((node) => `  ${node.status.padEnd(14)} ${node.kind}${node.profile ? ` → ${node.profile}` : ""}${node.error ? ` · ${node.error}` : ""}`);
  const envelope = workflow.envelope ? ` · envelope v${workflow.envelope.version}` : " · awaiting approval";
  return `fusion workflow: ${workflow.id.slice(0, 8)} · ${workflow.status}${envelope} · adapter ${workflow.adapter}${workflow.flickerTicketId ? ` · ticket #${workflow.flickerTicketId}` : ""}\n${lines.join("\n")}`;
}

export function formatExplain(view: FusionView): string {
  if (view.config.status !== "ready") {
    return `fusion explain: shadow · invalid-config · ${view.config.diagnostics.join("; ")}`;
  }
  if (view.discovery?.status !== "ready") {
    return `fusion explain: shadow · unavailable · ${view.discovery?.diagnostic ?? "discovery not started"}`;
  }
  if (!view.classification || !view.recommendation) {
    return "fusion explain: shadow · empty · submit a task to create a recommendation";
  }
  const required = Object.entries(view.classification.requiredCapabilities)
    .filter(([, value]) => value === true || (typeof value === "number" && value > 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const eligible = view.recommendation.evaluations.filter((item) => item.eligible).map((item) => item.profile).join(", ") || "none";
  const rejected = view.recommendation.evaluations
    .filter((item) => !item.eligible)
    .map((item) => `${item.profile}[${item.reasons.join(",")}]`)
    .join("; ") || "none";
  let route: string;
  if (view.recommendation.profile) route = `recommended ${view.recommendation.profile}/${view.recommendation.modelId}`;
  else if (view.recommendation.reasonCodes.includes("policy.no-eligible-profile")) route = "no-eligible-profile; current model retained";
  else route = "low-confidence; current model retained";
  const mutation = view.classification.mutationIntent;
  const oneShot = oneShotText(view);
  return `fusion explain: ${view.config.config.mode} · ${route} · confidence ${percent(view.recommendation.confidence)} · mutation ${mutation} · reasons ${view.recommendation.reasonCodes.join(", ")} · requires ${required} · eligible ${eligible} · rejected ${rejected}${oneShot} · active Pi model ${view.activeModel ?? "unknown"}`;
}

export function formatHistory(records: readonly TelemetryRecord[]): string {
  if (records.length === 0) return "fusion history: shadow · empty · no content-free decisions recorded";
  const lines = records.map((record) => {
    const route = record.recommendedProfile ?? (record.reasonCodes.includes("policy.no-eligible-profile") ? "no-eligible-profile" : "current-model-retained");
    return `${record.timestamp} · ${record.phase} → ${route} · ${percent(record.confidence)} · ${record.outcome} · active ${record.activeModelCategory}`;
  });
  return `fusion history: shadow · ${records.length} recent\n${lines.join("\n")}`;
}

export function formatConfig(view: FusionView): string {
  if (view.config.status !== "ready") {
    return `fusion config: shadow · ${view.config.status === "unconfigured" ? "invalid-config" : view.config.status} · path ${view.config.path} · ${view.config.diagnostics.join("; ")}`;
  }
  const config = view.config.config;
  const discovery = view.discovery?.status ?? "not-started";
  const unresolved = view.discovery?.unresolvedProfiles.length
    ? ` · unresolved ${view.discovery.unresolvedProfiles.join(",")}`
    : "";
  const authentication = config.provider.apiKey
    ? "API key env reference configured (value hidden)"
    : "keyless loopback authentication";
  return `fusion config: ${config.mode} · ready · path ${view.config.path} · provider ${config.provider.id} · profiles ${Object.keys(config.profiles).length} · aliases ${Object.keys(config.aliases).length} · discovery ${discovery}${unresolved} · ${authentication} · overrides ${config.projectOverrides.length}`;
}

export function formatProposals(proposals: readonly TuningProposal[]): string {
  if (proposals.length === 0) return "fusion tune: no proposals · run /fusion-tune-propose after sufficient evidence";
  const lines = proposals.map((proposal) =>
    `  ${proposal.status.padEnd(10)} ${proposal.kind} · ${proposal.scope}${proposal.repo ? `/${proposal.repo}` : ""} · evidence ${proposal.evidenceSample} · ${proposal.description.slice(0, 80)}`);
  return `fusion tune: ${proposals.length} proposal(s)\n${lines.join("\n")}`;
}

export function formatProbeResult(probe: ProbeResult | undefined, profile: string): string {
  if (!probe) return `${profile}: unprobed`;
  return `${profile}: ${probe.ok ? "ok" : "FAIL"} · ${probe.modelId}${probe.keyless ? " · keyless" : ""}${probe.error ? ` · ${probe.error}` : ""}${probe.latencyMs !== undefined ? ` · ${probe.latencyMs}ms` : ""}`;
}
