import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendRoutingEntry, describeRouting, formatRoutingLog, formatStats, readRoutingEntries, routingLogPath, sessionSummaries, widgetRows, type RoutingLogEntry } from "../src/routing-log.ts";

const baseEntry = (overrides: Partial<RoutingLogEntry> = {}): RoutingLogEntry => ({
  version: 1,
  ts: "2026-08-07T00:00:00.000Z",
  sessionId: "session-main",
  kind: "route",
  phase: "implement",
  profile: "code",
  fromModel: "existing/original",
  toModel: "fission-sidekick",
  switched: true,
  reason: "writing code",
  reasonCodes: ["phase.implement", "policy.preferred"],
  confidence: 0.92,
  ...overrides,
});

describe("routing log", () => {
  it("appends, reads, and formats entries without any prompt content", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fission-routing-")));
    const configPath = join(dir, "pi-fission.json");
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "session-main" }));
    await appendRoutingEntry(configPath, baseEntry({
      sessionId: "session-child-1",
      phase: "explore",
      profile: "fast",
      toModel: "fission-explore",
      reason: "exploring the codebase",
      reasonCodes: ["phase.explore"],
    }));
    const entries = await readRoutingEntries(configPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.sessionId, "session-child-1");
    const text = await readFile(routingLogPath(configPath), "utf8");
    assert.doesNotMatch(text, /prompt|secret|code content/i);
    const formatted = formatRoutingLog(entries);
    assert.match(formatted, /session-main/);
    assert.match(formatted, /switched to fission-sidekick because writing code/);
    assert.match(formatted, /session-child-1/);
    assert.match(formatted, /switched to fission-explore because exploring the codebase/);
    await rm(dir, { recursive: true, force: true });
  });

  it("skips malformed lines from concurrent writers", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fission-routing-")));
    const configPath = join(dir, "pi-fission.json");
    await appendRoutingEntry(configPath, baseEntry());
    const fs = await import("node:fs/promises");
    await fs.appendFile(routingLogPath(configPath), "{broken\n", "utf8");
    const entries = await readRoutingEntries(configPath);
    assert.equal(entries.length, 1);
    await rm(dir, { recursive: true, force: true });
  });

  it("summarizes sessions and renders widget rows without prompt content", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fission-summary-")));
    const configPath = join(dir, "pi-fission.json");
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "main", ts: "2026-08-07T10:00:00.000Z" }));
    await appendRoutingEntry(configPath, baseEntry({
      sessionId: "child",
      parentSessionId: "main",
      childAgent: "reviewer",
      ts: "2026-08-07T10:01:00.000Z",
      phase: "review",
      profile: "review",
      toModel: "fission-reviewer",
      reason: "reviewing the work",
    }));
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "stale", ts: "2026-08-01T00:00:00.000Z" }));
    const now = Date.parse("2026-08-07T10:02:00.000Z");
    const summaries = sessionSummaries(await readRoutingEntries(configPath), now);
    assert.equal(summaries.length, 2, "stale session is windowed out");
    const scoped = sessionSummaries(await readRoutingEntries(configPath), now, "main");
    assert.equal(scoped.length, 2, "scoped to main + child");
    assert.equal(scoped.some((s) => s.sessionId === "child"), true);
    assert.equal(scoped.some((s) => s.agent === "reviewer"), true);
    const collapsed = widgetRows(scoped, "main", false);
    assert.equal(collapsed[0], "fission: 2 agents routing · main fission-sidekick · ctrl+e for details");
    const expanded = widgetRows(scoped, "main", true);
    assert.ok(expanded.some((row) => /main · fission-sidekick · writing code/.test(row)));
    assert.ok(expanded.some((row) => /reviewer · fission-reviewer · reviewing the work/.test(row)));
    assert.doesNotMatch(expanded.join("\n"), /secret|prompt text/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("scopes summaries to the session and its subagents, excluding foreign sessions", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fission-scope-")));
    const configPath = join(dir, "pi-fission.json");
    const now = Date.parse("2026-08-07T10:05:00.000Z");
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "main", ts: "2026-08-07T10:00:00.000Z" }));
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "child", parentSessionId: "main", childAgent: "explorer", ts: "2026-08-07T10:01:00.000Z", phase: "explore", profile: "fast", toModel: "fission-explore", reason: "exploring the codebase" }));
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "cardhoard", ts: "2026-08-07T10:02:00.000Z" }));
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "grandchild", parentSessionId: "child", childAgent: "verify", ts: "2026-08-07T10:03:00.000Z", phase: "review", profile: "review", toModel: "fission-reviewer", reason: "reviewing the work" }));
    const scoped = sessionSummaries(await readRoutingEntries(configPath), now, "main");
    const ids = scoped.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ["child", "main"], "grandchild belongs to child, not main; foreign session excluded");
    assert.ok(scoped.some((s) => s.agent === "explorer"));
    await rm(dir, { recursive: true, force: true });
  });

  it("truncates the rendered history and says how much it dropped", () => {
    const entries = Array.from({ length: 14 }, (_, index) => baseEntry({
      sessionId: `session-${index}`,
      ts: `2026-08-07T10:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const rendered = formatRoutingLog(entries);
    const sessionLines = rendered.split("\n").filter((line) => line.startsWith("  session "));
    assert.equal(sessionLines.length, 10, "renders at most ten sessions");
    assert.ok(sessionLines[0]?.includes("session-13"), "most recent session first");
    assert.match(rendered, /\(4 older sessions not shown\)/, "truncation is stated, never silent");
  });

  it("maps human reasons per routing kind", () => {
    assert.equal(describeRouting("route", "explore", []), "exploring the codebase");
    assert.equal(describeRouting("route", "implement", []), "writing code");
    assert.equal(describeRouting("route", "review", []), "reviewing the work");
    assert.equal(describeRouting("manual", "implement", []), "user selected a model");
    assert.equal(describeRouting("retained", "implement", ["policy.low-confidence"]), "policy.low-confidence");
  });
});
