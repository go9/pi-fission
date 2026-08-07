import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowState } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface FlickerProjectResolution {
  ok: boolean;
  projectSlug: string | null;
  error?: string;
}

/** Resolve whether this repository is linked to a Flicker project. */
export async function resolveFlickerProject(repo: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<FlickerProjectResolution> {
  try {
    const { stdout } = await execFileAsync("flicker", ["project", "show", "--json"], { cwd: repo, env: options.env ?? process.env });
    const parsed = JSON.parse(stdout);
    const slug = typeof parsed?.slug === "string" ? parsed.slug : typeof parsed?.project_slug === "string" ? parsed.project_slug : null;
    return { ok: true, projectSlug: slug };
  } catch (error) {
    return { ok: false, projectSlug: null, error: (error as Error).message.slice(0, 200) };
  }
}

export interface TicketCreation {
  ok: boolean;
  ticketId: string | null;
  error?: string;
}

/** Create a Flicker ticket during planning (the plan itself), never after mutation. */
export async function createPlanningTicket(repo: string, title: string, body: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<TicketCreation> {
  try {
    const { stdout } = await execFileAsync("flicker", ["ticket", "create", title, "--body", body, "--json"], { cwd: repo, env: options.env ?? process.env });
    const parsed = JSON.parse(stdout);
    const id = typeof parsed?.id === "number" ? String(parsed.id) : typeof parsed?.id === "string" ? parsed.id : null;
    return { ok: id !== null, ticketId: id };
  } catch (error) {
    return { ok: false, ticketId: null, error: (error as Error).message.slice(0, 200) };
  }
}

/** Write a Flicker planning/evidence document for the workflow. */
export async function writeFlickerDocument(ticketId: string, kind: string, title: string, body: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("flicker", ["ticket", "document", "write", ticketId, kind, "--title", title, "--body", body, "--json"], { cwd: process.cwd(), env: options.env ?? process.env });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }
}

/** Advance the Flicker ticket status to match workflow state. */
export async function syncFlickerStatus(ticketId: string, status: WorkflowState["status"], options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; error?: string }> {
  const transition: Record<WorkflowState["status"], string> = {
    planning: "start",
    "awaiting-approval": "start",
    running: "start",
    paused: "start",
    blocked: "start",
    recovered: "start",
    complete: "complete",
    cancelled: "defer",
  };
  const command = transition[status] ?? "start";
  try {
    await execFileAsync("flicker", ["ticket", command, ticketId, "--json"], { cwd: process.cwd(), env: options.env ?? process.env });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }
}
