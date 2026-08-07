import type { ConfigResult } from "./config.ts";
import type { DiscoveryResult } from "./router.ts";
import type { Classification, Recommendation, RouteOnceReason, RouteOnceStatus } from "./types.ts";
import type { TelemetryRecord } from "./telemetry.ts";

export interface FusionView {
  config: ConfigResult;
  discovery: DiscoveryResult | null;
  classification: Classification | null;
  recommendation: Recommendation | null;
  activeModel: string | null;
  routeOnce?: { status: RouteOnceStatus; reason: RouteOnceReason | null };
}

function routeOnce(view: FusionView): { status: RouteOnceStatus; reason: RouteOnceReason | null } {
  return view.routeOnce ?? { status: "shadow", reason: null };
}

function routeLabel(view: FusionView): string {
  const route = routeOnce(view);
  if (route.status === "shadow") return "shadow";
  if (route.reason) return `one-shot ${route.status} (${route.reason})`;
  return `one-shot ${route.status}`;
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

type Health = "invalid-config" | "unavailable" | "low-confidence" | "no-eligible-profile" | "ready";

function health(view: FusionView): Health {
  if (view.config.status !== "ready" || !view.config.config?.enabled) return "invalid-config";
  if (view.discovery?.status !== "ready") return "unavailable";
  if (view.recommendation?.reasonCodes.includes("policy.no-eligible-profile")) return "no-eligible-profile";
  if (view.recommendation?.reasonCodes.includes("policy.low-confidence")) return "low-confidence";
  return "ready";
}

export function footerText(view: FusionView): string {
  const state = health(view);
  const route = routeOnce(view);
  if (route.status === "armed") return "fusion: one-shot armed · next task";
  if (route.status === "restored") return "fusion: one-shot restored · shadow ready";
  if (route.status === "restore-failed") return "fusion: one-shot restore-failed · check model";
  if (route.status === "user-overrode") return "fusion: one-shot cancelled · user model retained";
  if (state === "invalid-config") return `fusion: ${routeLabel(view)} · invalid-config`;
  if (state === "unavailable") return `fusion: ${routeLabel(view)} · unavailable`;
  if (state === "low-confidence") return `fusion: ${routeLabel(view)} · uncertain · current model retained`;
  if (state === "no-eligible-profile") return `fusion: ${routeLabel(view)} · no-eligible-profile · current model retained`;
  if (!view.classification || !view.recommendation?.profile) return `fusion: ${routeLabel(view)} · ready`;
  return `fusion: ${routeLabel(view)} · ${view.classification.phase} → ${view.recommendation.profile}`;
}

export function formatStatus(view: FusionView): string {
  const state = health(view);
  const active = view.activeModel ?? "unknown";
  const route = routeLabel(view);
  if (state === "invalid-config") {
    return `fusion: ${route} · invalid-config · ${view.config.diagnostics.join("; ")} · active Pi model: ${active}`;
  }
  if (state === "unavailable") {
    return `fusion: ${route} · unavailable · ${view.discovery?.diagnostic ?? "discovery not started"} · active Pi model: ${active}`;
  }
  if (!view.classification || !view.recommendation) {
    return `fusion: ${route} · ready · no recommendation yet · active Pi model: ${active}`;
  }
  if (state === "low-confidence") {
    return `fusion: ${route} · low-confidence (${percent(view.recommendation.confidence)}) · current model retained · active Pi model: ${active}`;
  }
  if (state === "no-eligible-profile") {
    return `fusion: ${route} · no-eligible-profile (${percent(view.recommendation.confidence)}) · required capability floor is unmet or profiles are unresolved · current model retained · active Pi model: ${active}`;
  }
  return `fusion: ${route} · ready · ${view.classification.phase} → recommended ${view.recommendation.profile} (${percent(view.recommendation.confidence)}) · active Pi model: ${active}`;
}

export function formatExplain(view: FusionView): string {
  if (view.config.status !== "ready") {
    return `fusion explain: ${routeLabel(view)} · invalid-config · ${view.config.diagnostics.join("; ")}`;
  }
  if (view.discovery?.status !== "ready") {
    return `fusion explain: ${routeLabel(view)} · unavailable · ${view.discovery?.diagnostic ?? "discovery not started"}`;
  }
  if (!view.classification || !view.recommendation) {
    return `fusion explain: ${routeLabel(view)} · empty · submit a task to create a recommendation`;
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
  return `fusion explain: ${routeLabel(view)} · ${route} · confidence ${percent(view.recommendation.confidence)} · reasons ${view.recommendation.reasonCodes.join(", ")} · requires ${required} · eligible ${eligible} · rejected ${rejected} · active Pi model ${view.activeModel ?? "unknown"}`;
}

export function formatHistory(records: readonly TelemetryRecord[]): string {
  if (records.length === 0) return "fusion history: shadow · empty · no content-free decisions recorded";
  const lines = records.map((record) => {
    const route = record.recommendedProfile
      ?? (record.reasonCodes.includes("policy.no-eligible-profile") ? "no-eligible-profile" : "current-model-retained");
    return `${record.timestamp} · ${record.phase} → ${route} · ${percent(record.confidence)} · ${record.outcome} · route ${record.routeOnceStatus ?? "shadow"} · active ${record.activeModelCategory}`;
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
  return `fusion config: shadow-default · one-shot available · path ${view.config.path} · provider ${config.provider.id} · profiles ${Object.keys(config.profiles).length} · aliases ${Object.keys(config.aliases).length} · discovery ${discovery}${unresolved} · ${authentication}`;
}
