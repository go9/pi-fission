import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { createTelemetryRecord, TelemetryStore } from "../src/telemetry.ts";
import type { CanonicalProfile } from "../src/types.ts";
import { validConfig, writeConfig } from "../test-support/helpers.ts";

const models = Object.fromEntries(["pi-fast", "pi-code", "pi-reason", "pi-review", "pi-research", "pi-vision"].map((id) => [id, id])) as Record<CanonicalProfile, string>;

describe("telemetry privacy", () => {
  it("telemetry privacy sentinels cannot enter the redaction-by-construction schema", async () => {
    const prompt = "PROMPT_SENTINEL implement code SOURCE_SENTINEL";
    const credential = "CREDENTIAL_SENTINEL";
    const rawToolOutput = "TOOL_OUTPUT_SENTINEL";
    const classification = classify({ text: prompt });
    const route = recommend({ classification, config: validConfig(), resolvedModels: models, providerReady: true });
    route.reasonCodes.push(rawToolOutput);
    const record = createTelemetryRecord({
      classification,
      recommendation: route,
      activeModel: `model/${credential}`,
      usage: { inputTokens: 12, raw: rawToolOutput, accountId: "ACCOUNT_SENTINEL" },
      durationMs: 42,
      outcome: "success",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    const serialized = JSON.stringify(record);
    for (const sentinel of ["PROMPT_SENTINEL", "SOURCE_SENTINEL", credential, rawToolOutput, "ACCOUNT_SENTINEL"]) {
      assert.doesNotMatch(serialized, new RegExp(sentinel));
    }
    assert.deepEqual(Object.keys(record).sort(), [
      "activeModel", "confidence", "durationMs", "outcome", "phase", "reasonCodes", "recommendedProfile", "schemaVersion", "timestamp", "usage",
    ]);

    const { dir } = await writeConfig(validConfig());
    const path = join(dir, "privacy.jsonl");
    const store = new TelemetryStore(path, 2);
    await store.record(record);
    await store.record({ ...record, timestamp: "2026-01-02T03:04:06.000Z" });
    await store.record({ ...record, timestamp: "2026-01-02T03:04:07.000Z" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "history is bounded");
    assert.equal((await store.recent()).length, 2);
  });
});
