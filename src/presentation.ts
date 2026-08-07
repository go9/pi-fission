import type { ConfigResult } from "./config.ts";
import type { DiscoveryResult } from "./router.ts";
import type {
  Classification,
  ProbeResult,
  Recommendation,
  SetupState,
} from "./types.ts";

export type RoutingStatus = "idle" | "routed" | "retained" | "manual" | "restore-failed" | "setup-blocked";

export interface FusionView {
  config: ConfigResult;
  discovery: DiscoveryResult | null;
  classification: Classification | null;
  recommendation: Recommendation | null;
  activeModel: string | null;
  setup: SetupState | null;
  routingStatus: RoutingStatus;
  routingReason: string | null;
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function configuredMode(view: FusionView): string {
  return view.config.status === "ready" ? view.config.config.mode : "unconfigured";
}

function selectedRoute(view: FusionView): string | null {
  if (!view.classification || !view.recommendation?.profile || !view.recommendation.modelId) return null;
  return `${view.classification.phase} → ${view.recommendation.profile} · ${view.recommendation.modelId}`;
}

export function footerText(view: FusionView): string {
  if (view.config.status === "unconfigured") return "fusion: setup required";
  if (view.config.status !== "ready") return "fusion: invalid config";
  const mode = configuredMode(view);
  if (mode === "off") return "fusion: off";
  if (view.discovery?.status !== "ready") return `fusion: ${mode} · 9Router unavailable`;
  if (view.routingStatus === "setup-blocked") return "fusion: setup blocked";
  if (view.routingStatus === "restore-failed") return "fusion: restore failed · check /fusion-status";
  if (view.routingStatus === "manual") return `fusion: manual model · ${view.activeModel ?? "unknown"}`;
  const route = selectedRoute(view);
  if (route) {
    if (view.routingStatus === "retained") return `fusion: retained current · ${route}`;
    return `fusion: ${mode} · ${route}`;
  }
  return `fusion: ${mode} · ready`;
}

export function formatStatus(view: FusionView): string {
  if (view.config.status === "unconfigured") return `fusion: setup required · run /fusion-setup · config ${view.config.path}`;
  if (view.config.status !== "ready") return `fusion: invalid-config · ${view.config.diagnostics.join("; ")}`;
  const discovery = view.discovery?.status === "ready" ? "9Router ready" : view.discovery?.diagnostic ?? "discovery not started";
  const setup = view.setup?.complete ? "7/7 probes passed" : "setup incomplete";
  const route = selectedRoute(view) ?? "no route yet";
  const reason = view.routingReason ? ` · ${view.routingReason}` : "";
  return `fusion: ${view.config.config.mode} · ${discovery} · ${setup} · ${view.routingStatus} · ${route}${reason} · Pi model ${view.activeModel ?? "unknown"}`;
}

export function formatConfig(view: FusionView): string {
  if (view.config.status !== "ready") return `fusion config: ${view.config.status} · ${view.config.path} · ${view.config.diagnostics.join("; ")}`;
  const config = view.config.config;
  const mappings = Object.entries(config.profiles).map(([profile, target]) => `  ${profile.padEnd(9)} ${target.modelId}`).join("\n");
  return `fusion config: ${config.mode} · ${config.provider.baseUrl} · profiles 7\n${mappings}`;
}

export function formatExplain(view: FusionView): string {
  if (!view.classification || !view.recommendation) return `fusion explain: ${view.discovery?.diagnostic ?? "no request classified yet"}`;
  const recommendation = view.recommendation;
  const selected = recommendation.profile && recommendation.modelId
    ? `${recommendation.profile} → ${recommendation.modelId}`
    : "current model retained";
  return `fusion explain: ${view.classification.phase} · ${view.classification.risk} risk · ${selected} · confidence ${percent(recommendation.confidence)} · ${recommendation.reasonCodes.join(", ")}`;
}

export function formatSetup(view: FusionView): string {
  if (view.config.status !== "ready") return "fusion setup: required · run /fusion-setup";
  if (!view.setup?.complete) {
    const failures = Object.entries(view.setup?.probes ?? {})
      .filter(([, probe]) => probe && !probe.ok)
      .map(([profile, probe]) => `${profile}=${probe?.error ?? "failed"}`);
    return `fusion setup: incomplete${failures.length ? ` · ${failures.join(" · ")}` : " · run /fusion-setup"}`;
  }
  return `fusion setup: complete · 7/7 profiles · ${view.config.config.mode} · ${view.setup.lastProbedAt ?? "unknown time"}`;
}

export function formatProbeResult(probe: ProbeResult | undefined, profile: string): string {
  if (!probe) return `${profile}: unprobed`;
  return `${profile}: ${probe.ok ? "ok" : "FAIL"} · ${probe.modelId}${probe.error ? ` · ${probe.error}` : ""}${probe.latencyMs !== undefined ? ` · ${probe.latencyMs}ms` : ""}`;
}
