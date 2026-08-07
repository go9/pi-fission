import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalProfile, Phase } from "./types.ts";

/** One content-free routing decision. No prompts, code, credentials, or tool output. */
export interface RoutingLogEntry {
  version: 1;
  ts: string;
  sessionId: string;
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

/** Default routing log path, next to the Fusion config so every session shares it. */
export function routingLogPath(configPath: string): string {
  return joinPath(dirname(configPath), "pi-fusion.routing.jsonl");
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

/** Render the routing history grouped by session. */
export function formatRoutingLog(entries: RoutingLogEntry[]): string {
  if (entries.length === 0) return "fusion routing: no routing activity recorded yet";
  const sessions = new Map<string, RoutingLogEntry[]>();
  for (const entry of entries) {
    const list = sessions.get(entry.sessionId) ?? [];
    list.push(entry);
    sessions.set(entry.sessionId, list);
  }
  const lines: string[] = ["fusion routing:"];
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
