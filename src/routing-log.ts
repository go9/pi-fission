import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
  kind: "route" | "retained" | "manual" | "restore-failed";
  phase: Phase | "unknown";
  profile: CanonicalProfile | null;
  fromModel: string | null;
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
    case "route":
      return PHASE_PHRASE[phase];
  }
}

/** Default routing log path, next to the Fission config so every session shares it. */
export function routingLogPath(configPath: string): string {
  return joinPath(dirname(configPath), "pi-fission.routing.jsonl");
}

function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

/** Append one routing entry (single small O_APPEND write; best-effort, never throws). */
export async function appendRoutingEntry(configPath: string, entry: RoutingLogEntry): Promise<void> {
  const path = routingLogPath(configPath);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
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
      currentModel: latest.kind === "manual" ? latest.fromModel : (latest.toModel ?? latest.fromModel),
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
  return summary.sessionName ?? `sub ${summary.sessionId.slice(0, 8)}`;
}

/** Widget rows: one compact line collapsed, per-agent rows expanded. */
export function widgetRows(summaries: SessionSummary[], mainSessionId: string, expanded: boolean): string[] {
  const count = summaries.length;
  if (!expanded) {
    return [`fission: ${count} agent${count === 1 ? "" : "s"} routing · ctrl+alt+f for details`];
  }
  const rows: string[] = [`fission workers (${count}) · ctrl+alt+f to collapse`];
  if (count === 0) rows.push("  (no active sessions in the last 15 minutes)");
  for (const summary of summaries) {
    const model = summary.currentModel ?? "unknown";
    rows.push(`  ${sessionLabel(summary, mainSessionId).padEnd(18)} ${model} · ${summary.reason}${summary.profile ? ` (${summary.profile})` : ""}`);
  }
  return rows;
}

/** Text version for /fission-agents (works in every Pi mode). */
export function formatAgents(summaries: SessionSummary[], mainSessionId: string): string {
  if (summaries.length === 0) return "fission agents: no active sessions in the last 15 minutes";
  const lines = [`fission agents: ${summaries.length} active`];
  for (const summary of summaries) {
    lines.push(`  ${sessionLabel(summary, mainSessionId)} — ${summary.currentModel ?? "unknown"} · ${summary.reason}${summary.profile ? ` (${summary.profile})` : ""}`);
  }
  return lines.join("\n");
}

/** Render the routing history grouped by session. */
export function formatRoutingLog(entries: RoutingLogEntry[]): string {
  if (entries.length === 0) return "fission routing: no routing activity recorded yet";
  const sessions = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    const list = sessions.get(entry.sessionId) ?? [];
    list.push(entry);
    sessions.set(entry.sessionId, list);
  }
  const lines: string[] = ["fission routing:"];
  for (const [sessionId, list] of sessions) {
    const latest = list[list.length - 1]!;
    const current = latest.kind === "manual" ? formatModel(latest.fromModel) : formatModel(latest.toModel ?? latest.fromModel);
    const cwd = latest.cwd ? ` · ${latest.cwd}` : "";
    lines.push(`  session ${sessionId}${cwd}`);
    lines.push(`    now: ${current}${latest.profile ? ` (${latest.profile})` : ""}`);
    const switches = list.filter((entry) => entry.kind === "route" && entry.switched).slice(-3);
    if (switches.length > 0) {
      for (const entry of switches) {
        lines.push(`    switched to ${formatModel(entry.toModel)} because ${entry.reason}${entry.confidence !== null ? ` · ${Math.round(entry.confidence * 100)}%` : ""}`);
      }
    } else {
      lines.push(`    last: ${latest.reason}`);
    }
  }
  return lines.join("\n");
}
