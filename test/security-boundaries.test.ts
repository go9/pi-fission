import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { commitChangedFiles } from "../src/extension.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-fusion-evidence-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fusion-test@example.invalid"]);
  git(repo, ["config", "user.name", "Fusion Test"]);
  await writeFile(join(repo, "file.txt"), "baseline\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-qm", "baseline"]);
  return repo;
}

describe("commit evidence integrity", () => {
  it("requires a changed-files commit and a clean final worktree", async () => {
    const repo = await repository();
    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    await writeFile(join(repo, "file.txt"), "committed\n");
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-qm", "change"]);
    assert.equal(await commitChangedFiles(repo, before, status), true);

    await writeFile(join(repo, "file.txt"), "later uncommitted write\n");
    assert.equal(await commitChangedFiles(repo, before, status), false, "later writes invalidate prior commit evidence");
  });

  it("rejects a dirty baseline even when porcelain status text later looks identical", async () => {
    const repo = await repository();
    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(repo, "file.txt"), "dirty before node\n");
    const dirty = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-qm", "commit dirty baseline"]);
    await writeFile(join(repo, "file.txt"), "dirty after commit\n");
    assert.equal(git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), dirty);
    assert.equal(await commitChangedFiles(repo, before, dirty), false);
  });

  it("rejects an empty amend that only changes the commit identity", async () => {
    const repo = await repository();
    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    git(repo, ["commit", "--amend", "-m", "amended", "--no-gpg-sign"]);
    assert.notEqual(git(repo, ["rev-parse", "HEAD"]).trim(), before);
    assert.equal(await commitChangedFiles(repo, before, status), false);
  });
});
