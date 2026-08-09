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
  if (view.discovery?.status !== "ready") return `fission: ${mode} · provider unavailable`;
  if (view.routingStatus === "setup-blocked") return "fission: setup blocked";
  if (view.routingStatus === "restore-failed") return "fission: restore failed · select a model manually";
  if (view.routingStatus === "manual") return `fission: manual model · ${view.activeModel ?? "unknown"}`;
  const route = selectedRoute(view);
  if (route) {
    if (view.routingStatus === "retained") return `fission: retained current · ${route}`;
    return `fission: ${mode} · ${route}`;
  }
  return `fission: ${mode} · ready`;
}

/**
 * The seven mappings and their live validity as ONE table.
 *
 * These were two commands (`/fission-config`, `/fission-setup-status`) and that was the
 * wrong split: a mapping is a declaration and a probe is the evidence for it, so reading
 * either alone tells you nothing actionable — you had to run both. Rendering them as
 * columns of one table is what the two commands were always trying to say together.
 */
export function formatSetupTable(view: FissionView): string {
  if (view.config.status === "unconfigured") return `fission setup: required · run /fission-setup probe · config ${view.config.path}`;
  if (view.config.status !== "ready") return `fission setup: invalid config · ${view.config.path} · ${view.config.diagnostics.join("; ")}`;

  const config = view.config.config;
  const probes = view.setup?.probes ?? {};
  const entries = Object.entries(config.profiles);
  const verified = entries.filter(([profile]) => probes[profile as keyof typeof probes]?.ok).length;

  const reachability = view.discovery?.status === "ready"
    ? null
    : view.discovery?.diagnostic ?? "provider not reached yet";
  const health = reachability ? ` · ${reachability}` : "";
  const probedAt = view.setup?.lastProbedAt ? ` · last probed ${view.setup.lastProbedAt}` : "";
  const remedy = verified === entries.length ? "" : " · run /fission-setup probe";

  const width = Math.max(...entries.map(([, target]) => target.modelId.length));
  const rows = entries.map(([profile, target]) => {
    const probe = probes[profile as keyof typeof probes];
    // Absent is NOT failure: an unprobed mapping is unverified, and saying "failed" would
    // report a claim we never tested.
    const status = !probe ? "not probed" : probe.ok ? "ok" : `FAILED  ${probe.error ?? "probe failed"}`;
    return `  ${profile.padEnd(9)} ${target.modelId.padEnd(width)}  ${status}`;
  });

  return [
    `fission setup: ${config.mode} · ${config.provider.baseUrl} · ${verified}/${entries.length} verified${probedAt}${health}${remedy}`,
    "",
    ...rows,
  ].join("\n");
}

