import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { FusionConfig, OutcomeRecord, TuningProposal } from "./types.ts";

export type { FusionConfig, OutcomeRecord, TuningProposal };
import { defaultConfigPath } from "./config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Append a content-free outcome record for learning. */
export async function recordOutcome(config: FusionConfig, record: OutcomeRecord, configPath = defaultConfigPath()): Promise<void> {
  if (!config.tuning.enabled) return;
  const path = join(dirname(configPath), config.tuning.file);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    await lstat(path);
    await chmod(path, 0o600);
  } catch {
    // New file.
  }
  handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function loadOutcomes(config: FusionConfig, configPath = defaultConfigPath()): Promise<OutcomeRecord[]> {
  const path = join(dirname(configPath), config.tuning.file);
  const records: OutcomeRecord[] = [];
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const lines = (await handle.readFile("utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && value.schemaVersion === 1) records.push(value as unknown as OutcomeRecord);
      } catch {
        // Ignore corrupted lines.
      }
    }
  } catch {
    // Missing file means no outcomes yet.
  } finally {
    await handle?.close();
  }
  return records.slice(-Math.max(1, config.tuning.maxEntries));
}

/** Count evidence meeting the minimum sample for a proposal. */
export function evidenceSufficient(outcomes: OutcomeRecord[], minEvidence: number): boolean {
  return outcomes.length >= minEvidence;
}

/** Build a versioned tuning proposal from current outcomes. Never applies anything. */
export function buildTuningProposal(input: {
  config: FusionConfig;
  outcomes: OutcomeRecord[];
  description: string;
  kind: OutcomeRecord["failure"] extends never ? string : string;
  diff: Record<string, unknown>;
  expectedImpact: string;
  scope: "global" | "project";
  repo?: string;
}): TuningProposal | null {
  if (!evidenceSufficient(input.outcomes, input.config.tuning.minEvidence)) return null;
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    kind: input.kind as TuningProposal["kind"],
    scope: input.scope,
    repo: input.repo,
    description: input.description,
    diff: input.diff,
    expectedImpact: input.expectedImpact,
    evidenceSample: input.outcomes.length,
    applied: false,
    appliedAt: null,
    rollback: null,
    status: "proposed",
  };
}

function proposalPath(configPath: string): string {
  return join(dirname(configPath), "pi-fusion.tuning.proposals.json");
}

export async function loadProposals(configPath = defaultConfigPath()): Promise<TuningProposal[]> {
  try {
    const text = await readProposalFile(configPath);
    const raw: unknown = JSON.parse(text);
    if (Array.isArray(raw)) return raw.filter(isRecord) as unknown as TuningProposal[];
  } catch {
    // Missing file means no proposals.
  }
  return [];
}

async function readProposalFile(configPath: string): Promise<string> {
  const path = proposalPath(configPath);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function saveProposal(proposal: TuningProposal, configPath = defaultConfigPath()): Promise<void> {
  const proposals = await loadProposals(configPath);
  const path = proposalPath(configPath);
  await mkdir(dirname(path), { recursive: true });
  const index = proposals.findIndex((item) => item.id === proposal.id);
  if (index >= 0) proposals[index] = proposal;
  else proposals.push(proposal);
  // Atomic-ish write: temp then rename.
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(proposals, null, 2)}\n`, "utf8");
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, path);
  await chmod(path, 0o600);
}

/** Apply a proposal by persisting the diff for the future workflow, with rollback snapshot. */
export async function applyProposal(proposal: TuningProposal, configPath = defaultConfigPath()): Promise<TuningProposal> {
  const applied: TuningProposal = {
    ...proposal,
    status: "applied",
    applied: true,
    appliedAt: new Date().toISOString(),
    rollback: { ...proposal.diff },
  };
  await saveProposal(applied, configPath);
  return applied;
}

/** Roll an applied proposal back to its prior diff snapshot. */
export async function rollbackProposal(proposal: TuningProposal, configPath = defaultConfigPath()): Promise<TuningProposal> {
  const rolled: TuningProposal = {
    ...proposal,
    status: "rolled-back",
    applied: false,
    diff: proposal.rollback ? { ...proposal.rollback } : proposal.diff,
    rollback: null,
  };
  await saveProposal(rolled, configPath);
  return rolled;
}

export async function setProposalStatus(proposal: TuningProposal, status: TuningProposal["status"], configPath = defaultConfigPath()): Promise<TuningProposal> {
  const updated: TuningProposal = { ...proposal, status };
  await saveProposal(updated, configPath);
  return updated;
}

export async function writeProposals(proposals: TuningProposal[], configPath = defaultConfigPath()): Promise<void> {
  const path = proposalPath(configPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(proposals, null, 2)}\n`, "utf8");
  await chmod(path, 0o600);
}
