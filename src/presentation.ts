import type { ConfigResult } from "./config.ts";
import type { DiscoveryResult } from "./router.ts";
import type {
  Classification,
  ProbeResult,
  Recommendation,
  SetupState,
} from "./types.ts";

export type RoutingStatus = "idle" | "routed" | "retained" | "manual" | "restore-failed" | "setup-blocked";

export interface FissionView {
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

function configuredMode(view: FissionView): string {
  return view.config.status === "ready" ? view.config.config.mode : "unconfigured";
}

function selectedRoute(view: FissionView): string | null {
  if (!view.classification || !view.recommendation?.profile || !view.recommendation.modelId) return null;
  return `${view.classification.phase} → ${view.recommendation.profile} · ${view.recommendation.modelId}`;
}

export function footerText(view: FissionView): string {
  if (view.config.status === "unconfigured") return "fission: setup required";
  if (view.config.status !== "ready") return "fission: invalid config";
  const mode = configuredMode(view);
  if (mode === "off") return "fission: off";
  if (view.discovery?.status !== "ready") return `fission: ${mode} · 9Router unavailable`;
  if (view.routingStatus === "setup-blocked") return "fission: setup blocked";
  if (view.routingStatus === "restore-failed") return "fission: restore failed · check /fission-status";
  if (view.routingStatus === "manual") return `fission: manual model · ${view.activeModel ?? "unknown"}`;
  const route = selectedRoute(view);
  if (route) {
    if (view.routingStatus === "retained") return `fission: retained current · ${route}`;
    return `fission: ${mode} · ${route}`;
  }
  return `fission: ${mode} · ready`;
}

export function formatStatus(view: FissionView): string {
  if (view.config.status === "unconfigured") return `fission: setup required · run /fission-setup · config ${view.config.path}`;
  if (view.config.status !== "ready") return `fission: invalid-config · ${view.config.diagnostics.join("; ")}`;
  const discovery = view.discovery?.status === "ready" ? "9Router ready" : view.discovery?.diagnostic ?? "discovery not started";
  const setup = view.setup?.complete ? "7/7 probes passed" : "setup incomplete";
  const route = selectedRoute(view) ?? "no route yet";
  const reason = view.routingReason ? ` · ${view.routingReason}` : "";
  return `fission: ${view.config.config.mode} · ${discovery} · ${setup} · ${view.routingStatus} · ${route}${reason} · Pi model ${view.activeModel ?? "unknown"}`;
}

export function formatConfig(view: FissionView): string {
  if (view.config.status !== "ready") return `fission config: ${view.config.status} · ${view.config.path} · ${view.config.diagnostics.join("; ")}`;
  const config = view.config.config;
  const mappings = Object.entries(config.profiles).map(([profile, target]) => `  ${profile.padEnd(9)} ${target.modelId}`).join("\n");
  return `fission config: ${config.mode} · ${config.provider.baseUrl} · profiles 7\n${mappings}`;
}

export function formatExplain(view: FissionView): string {
  if (!view.classification || !view.recommendation) return `fission explain: ${view.discovery?.diagnostic ?? "no request classified yet"}`;
  const recommendation = view.recommendation;
  const selected = recommendation.profile && recommendation.modelId
    ? `${recommendation.profile} → ${recommendation.modelId}`
    : "current model retained";
  return `fission explain: ${view.classification.phase} · ${view.classification.risk} risk · ${selected} · confidence ${percent(recommendation.confidence)} · ${recommendation.reasonCodes.join(", ")}`;
}

export function formatSetup(view: FissionView): string {
  if (view.config.status !== "ready") return "fission setup: required · run /fission-setup";
  if (!view.setup?.complete) {
    const failures = Object.entries(view.setup?.probes ?? {})
      .filter(([, probe]) => probe && !probe.ok)
      .map(([profile, probe]) => `${profile}=${probe?.error ?? "failed"}`);
    return `fission setup: incomplete${failures.length ? ` · ${failures.join(" · ")}` : " · run /fission-setup"}`;
  }
  return `fission setup: complete · 7/7 profiles · ${view.config.config.mode} · ${view.setup.lastProbedAt ?? "unknown time"}`;
}

export function formatProbeResult(probe: ProbeResult | undefined, profile: string): string {
  if (!probe) return `${profile}: unprobed`;
  return `${profile}: ${probe.ok ? "ok" : "FAIL"} · ${probe.modelId}${probe.error ? ` · ${probe.error}` : ""}${probe.latencyMs !== undefined ? ` · ${probe.latencyMs}ms` : ""}`;
}
