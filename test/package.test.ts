import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import extension from "../extensions/pi-fusion.ts";

interface PackageManifest { pi?: { extensions?: string[] }; peerDependencies?: Record<string, string> }

describe("Pi package load shape", () => {
  it("exports one TypeScript extension entry point using official package metadata", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
    assert.deepEqual(manifest.pi?.extensions, ["./extensions/pi-fusion.ts"]);
    assert.equal(typeof extension, "function");
    assert.equal(manifest.peerDependencies?.["@earendil-works/pi-ai"], "*");
    assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  });
});
