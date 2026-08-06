import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classify } from "../src/classifier.ts";
import { recommend } from "../src/policy.ts";
import { createTelemetryRecord, TelemetryStore } from "../src/telemetry.ts";
import type { CanonicalProfile } from "../src/types.ts";
import { validConfig, writeConfig } from "../test-support/helpers.ts";

const models = Object.fromEntries(["pi-fast", "pi-code", "pi-reason", "pi-review", "pi-research", "pi-vision"].map((id) => [id, id])) as Record<CanonicalProfile, string>;

describe("telemetry privacy", () => {
  it("telemetry privacy sentinels and arbitrary lowercase deployment IDs cannot enter the allow-list schema", async () => {
    const prompt = "PROMPT_SENTINEL implement code SOURCE_SENTINEL";
    const credential = "CREDENTIAL_SENTINEL";
    const rawToolOutput = "TOOL_OUTPUT_SENTINEL";
    const privateDeployment = "tenant-a/private-deployment-42";
    const classification = classify({ text: prompt });
    const route = recommend({ classification, config: validConfig(), resolvedModels: models, providerReady: true });
    route.reasonCodes.push(rawToolOutput);
    const record = createTelemetryRecord({
      classification,
      recommendation: route,
      activeModelCategory: privateDeployment,
      usage: { inputTokens: 12, raw: rawToolOutput, accountId: "account-lowercase-private" },
      durationMs: 42,
      outcome: "success",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    const serialized = JSON.stringify(record);
    for (const sentinel of ["PROMPT_SENTINEL", "SOURCE_SENTINEL", credential, rawToolOutput, "account-lowercase-private", privateDeployment]) {
      assert.doesNotMatch(serialized, new RegExp(sentinel));
    }
    assert.equal(record.activeModelCategory, "unknown");
    assert.deepEqual(Object.keys(record).sort(), [
      "activeModelCategory", "confidence", "durationMs", "outcome", "phase", "reasonCodes", "recommendedProfile", "schemaVersion", "timestamp", "usage",
    ]);

    const { dir } = await writeConfig(validConfig());
    const path = join(dir, "privacy.jsonl");
    const store = new TelemetryStore(path, 2);
    await store.record(record);
    await store.record({ ...record, activeModelCategory: "external", timestamp: "2026-01-02T03:04:06.000Z" });
    await store.record({ ...record, activeModelCategory: "pi-code", timestamp: "2026-01-02T03:04:07.000Z" });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "history is bounded");
    assert.equal((await store.recent()).length, 2);
  });

  it("enforces 0600 on an existing telemetry file", async () => {
    const classification = classify({ text: "implement code" });
    const route = recommend({ classification, config: validConfig(), resolvedModels: models, providerReady: true });
    const record = createTelemetryRecord({ classification, recommendation: route, activeModelCategory: "external" });
    const { dir } = await writeConfig(validConfig());
    const path = join(dir, "existing.jsonl");
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);
    await new TelemetryStore(path, 10).record(record);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("rejects a symbolic-link telemetry target", async () => {
    const classification = classify({ text: "implement code" });
    const route = recommend({ classification, config: validConfig(), resolvedModels: models, providerReady: true });
    const record = createTelemetryRecord({ classification, recommendation: route, activeModelCategory: "external" });
    const { dir } = await writeConfig(validConfig());
    const target = join(dir, "target.jsonl");
    const link = join(dir, "telemetry-link.jsonl");
    await writeFile(target, "DO_NOT_TOUCH\n", "utf8");
    await symlink(target, link);
    await assert.rejects(new TelemetryStore(link, 10).record(record), /symbolic link/);
    assert.equal(await readFile(target, "utf8"), "DO_NOT_TOUCH\n");
  });
});
