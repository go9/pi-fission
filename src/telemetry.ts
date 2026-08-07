import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ActiveModelCategory, Classification, Phase, Recommendation, RouteOnceStatus } from "./types.ts";
import { CANONICAL_PROFILES } from "./types.ts";

const PHASES = new Set<Phase>(["explore", "implement", "plan", "review", "research", "vision", "unknown"]);
const REASON_CODES = new Set([
  "input.image", "input.ambiguous", "input.empty",
  "risk.protected",
  "phase.explore", "phase.implement", "phase.plan", "phase.review", "phase.research", "phase.vision",
  "observed.explore", "observed.implement", "observed.review", "observed.research", "observed.vision",
  "provider.unavailable",
  "policy.low-confidence", "policy.no-eligible-profile", "policy.preferred", "policy.capability-fallback",
]);
const PROFILES = new Set<string>(CANONICAL_PROFILES);
const ACTIVE_MODEL_CATEGORIES = new Set<string>([...CANONICAL_PROFILES, "external", "unknown"]);
const ROUTE_ONCE_STATUSES = new Set<RouteOnceStatus>([
  "shadow", "armed", "applied", "skipped", "restored", "restore-failed", "user-overrode",
]);

export interface AggregateUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface TelemetryRecord {
  schemaVersion: 1;
  timestamp: string;
  phase: Phase;
  recommendedProfile: string | null;
  reasonCodes: string[];
  confidence: number;
  activeModelCategory: ActiveModelCategory;
  routeOnceStatus?: RouteOnceStatus;
  usage: AggregateUsage;
  durationMs: number | null;
  outcome: "success" | "error" | "unknown";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function sanitizeActiveModelCategory(value: unknown): ActiveModelCategory {
  return typeof value === "string" && ACTIVE_MODEL_CATEGORIES.has(value)
    ? value as ActiveModelCategory
    : "unknown";
}

export function sanitizeUsage(value: unknown): AggregateUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const usage = value as Record<string, unknown>;
  const result: AggregateUsage = {};
  const inputTokens = finiteNonNegative(usage.inputTokens ?? usage.input);
  const outputTokens = finiteNonNegative(usage.outputTokens ?? usage.output);
  const cacheReadTokens = finiteNonNegative(usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWriteTokens = finiteNonNegative(usage.cacheWriteTokens ?? usage.cacheWrite);
  const cost = finiteNonNegative(usage.cost ?? (typeof usage.cost === "object" && usage.cost !== null ? (usage.cost as Record<string, unknown>).total : undefined));
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) result.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens;
  if (cost !== undefined) result.cost = cost;
  return result;
}

export function mergeUsage(left: AggregateUsage, right: AggregateUsage): AggregateUsage {
  const result: AggregateUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"] as const) {
    const value = (left[key] ?? 0) + (right[key] ?? 0);
    if (value > 0) result[key] = value;
  }
  return result;
}

export function createTelemetryRecord(input: {
  classification: Classification;
  recommendation: Recommendation;
  activeModelCategory?: unknown;
  routeOnceStatus?: unknown;
  usage?: unknown;
  durationMs?: unknown;
  outcome?: unknown;
  now?: Date;
}): TelemetryRecord {
  return {
    schemaVersion: 1,
    timestamp: (input.now ?? new Date()).toISOString(),
    phase: PHASES.has(input.classification.phase) ? input.classification.phase : "unknown",
    recommendedProfile: input.recommendation.profile && PROFILES.has(input.recommendation.profile)
      ? input.recommendation.profile
      : null,
    reasonCodes: [...new Set(input.recommendation.reasonCodes.filter((code) => REASON_CODES.has(code)))].slice(0, 8),
    confidence: Math.max(0, Math.min(1, finiteNonNegative(input.recommendation.confidence) ?? 0)),
    activeModelCategory: sanitizeActiveModelCategory(input.activeModelCategory),
    routeOnceStatus: typeof input.routeOnceStatus === "string" && ROUTE_ONCE_STATUSES.has(input.routeOnceStatus as RouteOnceStatus)
      ? input.routeOnceStatus as RouteOnceStatus
      : "shadow",
    usage: sanitizeUsage(input.usage),
    durationMs: finiteNonNegative(input.durationMs) ?? null,
    outcome: input.outcome === "success" || input.outcome === "error" ? input.outcome : "unknown",
  };
}

function isTelemetryRecord(value: unknown): value is TelemetryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<TelemetryRecord>;
  return item.schemaVersion === 1
    && typeof item.timestamp === "string"
    && typeof item.phase === "string"
    && PHASES.has(item.phase as Phase)
    && (item.recommendedProfile === null || (typeof item.recommendedProfile === "string" && PROFILES.has(item.recommendedProfile)))
    && Array.isArray(item.reasonCodes)
    && item.reasonCodes.every((reason) => typeof reason === "string" && REASON_CODES.has(reason))
    && typeof item.confidence === "number"
    && sanitizeActiveModelCategory(item.activeModelCategory) === item.activeModelCategory
    && (item.routeOnceStatus === undefined || ROUTE_ONCE_STATUSES.has(item.routeOnceStatus))
    && typeof item.usage === "object"
    && (item.durationMs === null || finiteNonNegative(item.durationMs) !== undefined)
    && (item.outcome === "success" || item.outcome === "error" || item.outcome === "unknown");
}

async function assertSafeRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error("telemetry path must not be a symbolic link");
    if (!stats.isFile()) throw new Error("telemetry path must be a regular file");
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class TelemetryStore {
  readonly path: string;
  readonly maxEntries: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, maxEntries: number) {
    this.path = path;
    this.maxEntries = maxEntries;
  }

  record(record: TelemetryRecord): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await assertSafeRegularFile(this.path);
      const handle = await open(
        this.path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      const lines = await this.#readLines();
      if (lines.length > this.maxEntries) await this.#replace(`${lines.slice(-this.maxEntries).join("\n")}\n`);
    });
    return this.#queue;
  }

  async recent(limit = 20): Promise<TelemetryRecord[]> {
    await this.#queue;
    const records: TelemetryRecord[] = [];
    for (const line of await this.#readLines()) {
      try {
        const value: unknown = JSON.parse(line);
        if (isTelemetryRecord(value)) records.push(value);
      } catch {
        // Ignore a partial or externally corrupted line; never echo it.
      }
    }
    return records.slice(-Math.max(0, limit));
  }

  async #replace(content: string): Promise<void> {
    const tempPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
    } catch (error) {
      await handle.close();
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(tempPath, this.path);
    await chmod(this.path, 0o600);
  }

  async #readLines(): Promise<string[]> {
    if (!await assertSafeRegularFile(this.path)) return [];
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return (await handle.readFile("utf8")).split("\n").filter(Boolean);
    } finally {
      await handle.close();
    }
  }
}
