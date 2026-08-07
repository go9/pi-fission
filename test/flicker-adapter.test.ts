import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { findPlanningTicket, readFlickerTicketStatus, resolveFlickerProject, syncFlickerStatus, writeFlickerDocument } from "../src/flicker-adapter.ts";

async function fakeFlicker(status = "backlog") {
  const dir = await mkdtemp(join(tmpdir(), "pi-fusion-flicker-"));
  const log = join(dir, "calls.log");
  const executable = join(dir, "flicker");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_FLICKER_LOG"
if [ "$1 $2" = "project show" ]; then
  printf '%s\\n' '{"project":{"id":23,"slug":"flicker"}}'
elif [ "$1 $2" = "ticket show" ]; then
  printf '%s\\n' '{"id":1501,"status":"${status}"}'
elif [ "$1 $2" = "ticket list" ]; then
  printf '%s\\n' '[{"id":1501,"body_md":"Pi Fusion workflow: wf-1"}]'
else
  printf '%s\\n' '{"ok":true}'
fi
`, "utf8");
  await chmod(executable, 0o755);
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_FLICKER_LOG: log } };
}

describe("Flicker adapter lifecycle", () => {
  it("resolves the nested project.slug returned by the current CLI", async () => {
    const fake = await fakeFlicker();
    assert.deepEqual(await resolveFlickerProject(fake.dir, { env: fake.env }), { ok: true, projectSlug: "flicker" });
  });

  it("finds an orphaned planning ticket by durable workflow marker", async () => {
    const fake = await fakeFlicker();
    assert.deepEqual(await findPlanningTicket(fake.dir, "wf-1", { env: fake.env }), { ok: true, ticketId: "1501" });
    assert.deepEqual(await readFlickerTicketStatus("1501", { env: fake.env }), { ok: true, status: "backlog" });
  });

  it("selects and starts a backlog ticket but never completes it for local workflow completion", async () => {
    const fake = await fakeFlicker("backlog");
    assert.deepEqual(await syncFlickerStatus("1501", "complete", { env: fake.env }), { ok: true });
    const calls = await readFile(fake.log, "utf8");
    assert.match(calls, /ticket show 1501 --json/);
    assert.match(calls, /ticket select-for-dev 1501 --json/);
    assert.match(calls, /ticket start 1501 --json/);
    assert.doesNotMatch(calls, /ticket complete/);
  });

  it("writes durable workflow documents through the public CLI", async () => {
    const fake = await fakeFlicker("in_progress");
    assert.deepEqual(await writeFlickerDocument("1501", "task_contract", "Pi Fusion task contract", "## Goal\n\nTest", { env: fake.env }), { ok: true });
    assert.match(await readFile(fake.log, "utf8"), /ticket document write 1501 task_contract --title Pi Fusion task contract --body/);
  });

  it("defers an active ticket only when the workflow is cancelled", async () => {
    const fake = await fakeFlicker("in_progress");
    assert.deepEqual(await syncFlickerStatus("1501", "cancelled", { env: fake.env }), { ok: true });
    assert.match(await readFile(fake.log, "utf8"), /ticket defer 1501 --json/);
  });
});
