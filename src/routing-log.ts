import { appendFile, readFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CanonicalProfile, Phase } from "./types.ts";

/** One content-free routing decision. No prompts, code, credentials, or tool output. */
export interface RoutingLogEntry {
  version: 1;
  ts: string;
  sessionId: string;
  sessionName?: string;
  /** Root session id this subagent belongs to (from PI_SUBAGENT_PARENT_SESSION). */
  parentSessionId?: string;
  /** Subagent name (from PI_SUBAGENT_CHILD_AGENT) or the run id. */
  childAgent?: string;
  cwd?: string;
  kind: "route" | "retained" | "manual" | "restore-failed" | "shadow";
  phase: Phase | "unknown";
  profile: CanonicalProfile | null;
  /** Provider-qualified `provider/id`, so fromModel and toModel are comparable. */
  fromModel: string | null;
  /** Provider-qualified `provider/id`; the model that was (or would be) selected. */
  toModel: string | null;
  switched: boolean;
  reason: string;
  reasonCodes: string[];
  confidence: number | null;
}

const PHASE_PHRASE: Record<Phase, string> = {
  clarify: "clarifying the request",
  explore: "exploring the codebase",
  research: "researching",
  plan: "planning",
  "plan-review": "reviewing the plan",
  implement: "writing code",
  review: "reviewing the work",
  regression: "running regression checks",
  release: "preparing release",
  vision: "analyzing images",
  design: "reviewing the design",
  unknown: "classifying the request",
};

/** Human-readable reason for a routing decision. */
export function describeRouting(kind: RoutingLogEntry["kind"], phase: Phase | "unknown", reasonCodes: string[]): string {
  switch (kind) {
    case "manual":
      return "user selected a model";
    case "restore-failed":
      return "previous model or thinking level could not be restored";
    case "retained":
      return reasonCodes.length > 0 ? reasonCodes.join(", ") : "no eligible route";
    case "shadow":
      return `would route: ${PHASE_PHRASE[phase]}`;
    case "route":
      return PHASE_PHRASE[phase];
  }
}

/** Entries store provider-qualified ids; the views show the group name alone. */
function shortModel(model: string | null): string | null {
  if (!model) return null;
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(separator + 1) : model;
}

/**
 * Which model the session is actually running. Only a `route` moved it: every other kind
 * still carries a toModel, because the recommendation is recorded whether or not it was
 * applied — a `retained` entry ("model selection failed", "recommended model is
 * unavailable") and a `restore-failed` one both name a model the session never reached.
 * Reading toModel for those reported the recommendation as the live model.
 */
function currentModelOf(entry: RoutingLogEntry): string | null {
  return entry.kind === "route" ? (entry.toModel ?? entry.fromModel) : entry.fromModel;
}

/** Default routing log path, next to the Fission config so every session shares it. */
export function routingLogPath(configPath: string): string {
  return join(dirname(configPath), "pi-fission.routing.jsonl");
}

/** Rewrite the log once it passes this size, keeping the most recent entries. */
const MAX_LOG_BYTES = 1_000_000;
const KEEP_ENTRIES = 1_000;

/**
 * Bound the log so it cannot grow forever. Best-effort: a concurrent append from
 * another session between the read and the rename is lost, which is an acceptable
 * trade for an observability log that every session writes to.
 */
async function pruneRoutingLog(path: string): Promise<void> {
  try {
    const { size } = await stat(path);
    if (size <= MAX_LOG_BYTES) return;
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
    if (lines.length <= KEEP_ENTRIES) return;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${lines.slice(-KEEP_ENTRIES).join("\n")}\n`, "utf8");
    await rename(temporary, path);
  } catch {
    // A too-large log is better than a broken session.
  }
}

/** Append one routing entry (single small O_APPEND write; best-effort, never throws). */
export async function appendRoutingEntry(configPath: string, entry: RoutingLogEntry): Promise<void> {
  const path = routingLogPath(configPath);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    await pruneRoutingLog(path);
  } catch {
    // Logging is best-effort and must never break the session.
  }
}

/** Read all valid routing entries, skipping malformed lines. */
export async function readRoutingEntries(configPath: string): Promise<RoutingLogEntry[]> {
  const path = routingLogPath(configPath);
  try {
    const text = await readFile(path, "utf8");
    const entries: RoutingLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RoutingLogEntry;
        if (parsed && parsed.version === 1 && typeof parsed.sessionId === "string" && parsed.ts) entries.push(parsed);
      } catch {
        // Skip malformed lines from concurrent writers.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function formatModel(model: string | null): string {
  return model ?? "unknown";
}

/** Per-session live summary derived from the latest routing entry in an active window. */
export interface SessionSummary {
  sessionId: string;
  sessionName: string | null;
  agent: string | null;
  currentModel: string | null;
  profile: CanonicalProfile | null;
  phase: Phase | "unknown";
  reason: string;
  lastTs: string;
}

const ACTIVE_WINDOW_MS = 15 * 60_000;

/**
 * Latest entry per session, filtered to a recent window so finished workers drop out.
 * When `scopeSessionId` is given, only the session itself plus its subagents (entries
 * stamped with that session as parent) are summarized; sibling windows stay out.
 */
export function sessionSummaries(entries: RoutingLogEntry[], now: number = Date.now(), scopeSessionId?: string): SessionSummary[] {
  const bySession = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    if (scopeSessionId && entry.sessionId !== scopeSessionId && entry.parentSessionId !== scopeSessionId) continue;
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  }
  const summaries: SessionSummary[] = [];
  for (const [sessionId, list] of bySession) {
    const latest = list[list.length - 1]!;
    const ts = Date.parse(latest.ts);
    if (!Number.isFinite(ts) || now - ts > ACTIVE_WINDOW_MS) continue;
    summaries.push({
      sessionId,
      sessionName: latest.sessionName ?? null,
      agent: latest.childAgent ?? null,
      currentModel: shortModel(currentModelOf(latest)),
      profile: latest.profile,
      phase: latest.phase,
      reason: latest.reason,
      lastTs: latest.ts,
    });
  }
  summaries.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  return summaries;
}

function sessionLabel(summary: SessionSummary, mainSessionId: string): string {
  if (summary.sessionId === mainSessionId) return "main";
  if (summary.agent) return summary.agent;
  if (summary.sessionName) return summary.sessionName;
  // No stable name: short phase label, not a throwaway id. The reason column already
  // carries the human activity summary.
  const phase = summary.phase === "unknown" ? null : summary.phase;
  return phase ?? `worker ${summary.sessionId.slice(0, 8)}`;
}

/** Widget rows: one compact line collapsed, per-agent rows expanded. */
export function widgetRows(summaries: SessionSummary[], mainSessionId: string, expanded: boolean): string[] {
  const count = summaries.length;
  if (!expanded) {
    const main = summaries.find((summary) => summary.sessionId === mainSessionId);
    const mainModel = main?.currentModel ? ` · main ${main.currentModel}` : "";
    return [`fission: ${count} agent${count === 1 ? "" : "s"} routing${mainModel} · ctrl+e for details`];
  }
  const rows: string[] = [`fission workers (${count}) · ctrl+e to collapse`];
  if (count === 0) rows.push("  (no active sessions in the last 15 minutes)");
  for (const summary of summaries) {
    const model = summary.currentModel ?? "unknown";
    rows.push(`  ${sessionLabel(summary, mainSessionId)} · ${model} · ${summary.reason}`);
  }
  return rows;
}

/** How many sessions `/fission-routing` renders before truncating. */
const MAX_RENDERED_SESSIONS = 10;

/**
 * Lifetime totals across every recorded session — what routing has actually done.
 *
 * This is the header of the routing view rather than its own command: it is the same
 * JSONL at a different zoom level, and splitting one question across two commands is
 * what made the old surface feel redundant.
 */
export function formatStats(entries: RoutingLogEntry[]): string[] {
  if (entries.length === 0) return [];
  const sessions = new Set(entries.map((entry) => entry.sessionId));
  const routed = entries.filter((entry) => entry.kind === "route");
  const byProfile = new Map<string, number>();
  for (const entry of routed) {
    if (entry.profile) byProfile.set(entry.profile, (byProfile.get(entry.profile) ?? 0) + 1);
  }

  // A manual pick landing on the very next decision of the same session, on a model other
  // than the routed one, is the user overruling that route. It is the only quality signal
  // the log can carry without recording prompt content. The model the user actually chose
  // is the manual entry's fromModel — its toModel is only what fission would have
  // recommended at that prompt — so that is what the route's target is compared against.
  const overrides = new Map<string, number>();
  const bySession = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  }
  for (const list of bySession.values()) {
    list.forEach((entry, index) => {
      const next = list[index + 1];
      if (entry.kind !== "route" || !entry.profile || !next) return;
      if (next.kind === "manual" && next.fromModel !== entry.toModel) {
        overrides.set(entry.profile, (overrides.get(entry.profile) ?? 0) + 1);
      }
    });
  }

  const first = entries[0]!.ts.slice(0, 10);
  const share = Math.round((routed.length / entries.length) * 100);
  const spread = [...byProfile.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([profile, count]) => `${profile} ${count}`)
    .join(" · ");

  const lines = [
    `fission: ${entries.length} prompts · ${routed.length} routed (${share}%) · ${sessions.size} sessions · since ${first}`,
  ];
  if (spread) lines.push(`  ${spread}`);
  const totalOverrides = [...overrides.values()].reduce((sum, count) => sum + count, 0);
  if (totalOverrides > 0) {
    const worst = [...overrides.entries()].sort(([, left], [, right]) => right - left)[0]!;
    lines.push(`  you overrode ${totalOverrides} route${totalOverrides === 1 ? "" : "s"} (most often ${worst[0]}, ${worst[1]})`);
  }
  return lines;
}

/** Render lifetime totals, then the recent history grouped by session, most recent first. */
export function formatRoutingLog(entries: RoutingLogEntry[], maxSessions = MAX_RENDERED_SESSIONS): string {
  if (entries.length === 0) return "fission routing: no routing activity recorded yet";
  const sessions = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    const list = sessions.get(entry.sessionId) ?? [];
    list.push(entry);
    sessions.set(entry.sessionId, list);
  }
  const ordered = [...sessions.entries()]
    .sort(([, left], [, right]) => right[right.length - 1]!.ts.localeCompare(left[left.length - 1]!.ts));
  const shown = ordered.slice(0, maxSessions);
  const omitted = ordered.length - shown.length;
  const lines: string[] = [...formatStats(entries), ""];
  for (const [sessionId, list] of shown) {
    const latest = list[list.length - 1]!;
    const current = formatModel(shortModel(currentModelOf(latest)));
    const cwd = latest.cwd ? ` · ${latest.cwd}` : "";
    lines.push(`  session ${sessionId}${cwd}`);
    lines.push(`    now: ${current}${latest.profile ? ` (${latest.profile})` : ""}`);
    const switches = list.filter((entry) => entry.kind === "route" && entry.switched).slice(-3);
    if (switches.length > 0) {
      for (const entry of switches) {
        lines.push(`    switched to ${formatModel(shortModel(entry.toModel))} because ${entry.reason}${entry.confidence !== null ? ` · ${Math.round(entry.confidence * 100)}%` : ""}`);
      }
    } else {
      lines.push(`    last: ${latest.reason}`);
    }
  }
  if (omitted > 0) lines.push(`  (${omitted} older session${omitted === 1 ? "" : "s"} not shown)`);
  return lines.join("\n");
}
