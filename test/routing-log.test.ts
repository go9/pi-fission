import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { appendRoutingEntry, describeRouting, formatAgents, formatRoutingLog, readRoutingEntries, routingLogPath, sessionSummaries, widgetRows, type RoutingLogEntry } from "../src/routing-log.ts";

const baseEntry = (overrides: Partial<RoutingLogEntry> = {}): RoutingLogEntry => ({
  version: 1,
  ts: "2026-08-07T00:00:00.000Z",
  sessionId: "session-main",
  kind: "route",
  phase: "implement",
  profile: "code",
  fromModel: "existing/original",
  toModel: "fusion-sidekick",
  switched: true,
  reason: "writing code",
  reasonCodes: ["phase.implement", "policy.preferred"],
  confidence: 0.92,
  ...overrides,
});

describe("routing log", () => {
  it("appends, reads, and formats entries without any prompt content", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fusion-routing-")));
    const configPath = join(dir, "pi-fusion.json");
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "session-main" }));
    await appendRoutingEntry(configPath, baseEntry({
      sessionId: "session-child-1",
      phase: "explore",
      profile: "fast",
      toModel: "fusion-explore",
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
    assert.match(formatted, /switched to fusion-sidekick because writing code/);
    assert.match(formatted, /session-child-1/);
    assert.match(formatted, /switched to fusion-explore because exploring the codebase/);
    await rm(dir, { recursive: true, force: true });
  });

  it("skips malformed lines from concurrent writers", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fusion-routing-")));
    const configPath = join(dir, "pi-fusion.json");
    await appendRoutingEntry(configPath, baseEntry());
    const fs = await import("node:fs/promises");
    await fs.appendFile(routingLogPath(configPath), "{broken\n", "utf8");
    const entries = await readRoutingEntries(configPath);
    assert.equal(entries.length, 1);
    await rm(dir, { recursive: true, force: true });
  });

  it("summarizes sessions and renders widget rows without prompt content", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), "fusion-summary-")));
    const configPath = join(dir, "pi-fusion.json");
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "main", ts: "2026-08-07T10:00:00.000Z" }));
    await appendRoutingEntry(configPath, baseEntry({
      sessionId: "child",
      sessionName: "reviewer",
      ts: "2026-08-07T10:01:00.000Z",
      phase: "review",
      profile: "review",
      toModel: "fusion-reviewer",
      reason: "reviewing the work",
    }));
    await appendRoutingEntry(configPath, baseEntry({ sessionId: "stale", ts: "2026-08-01T00:00:00.000Z" }));
    const summaries = sessionSummaries(await readRoutingEntries(configPath), Date.parse("2026-08-07T10:02:00.000Z"));
    assert.equal(summaries.length, 2, "stale session is windowed out");
    const collapsed = widgetRows(summaries, "main", false);
    assert.equal(collapsed[0], "fusion: 2 agents routing · ctrl+alt+f for details");
    const expanded = widgetRows(summaries, "main", true);
    assert.ok(expanded.some((row) => /main\s+fusion-sidekick · writing code/.test(row)));
    assert.ok(expanded.some((row) => /reviewer\s+fusion-reviewer · reviewing the work/.test(row)));
    assert.doesNotMatch(expanded.join("\n"), /secret|prompt text/i);
    assert.match(formatAgents(summaries, "main"), /reviewer — fusion-reviewer · reviewing the work/);
    await rm(dir, { recursive: true, force: true });
  });

  it("maps human reasons per routing kind", () => {
    assert.equal(describeRouting("route", "explore", []), "exploring the codebase");
    assert.equal(describeRouting("route", "implement", []), "writing code");
    assert.equal(describeRouting("route", "review", []), "reviewing the work");
    assert.equal(describeRouting("manual", "implement", []), "user selected a model");
    assert.equal(describeRouting("retained", "implement", ["policy.low-confidence"]), "policy.low-confidence");
  });
});
