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
    const slug = typeof parsed?.slug === "string"
      ? parsed.slug
      : typeof parsed?.project_slug === "string"
        ? parsed.project_slug
        : typeof parsed?.project?.slug === "string"
          ? parsed.project.slug
          : null;
    return slug
      ? { ok: true, projectSlug: slug }
      : { ok: false, projectSlug: null, error: "Flicker project response did not contain a slug" };
  } catch (error) {
    return { ok: false, projectSlug: null, error: (error as Error).message.slice(0, 200) };
  }
}

export interface TicketCreation {
  ok: boolean;
  ticketId: string | null;
  error?: string;
}

/** Recover a ticket created before a local crash by its durable workflow marker. */
export async function findPlanningTicket(repo: string, workflowId: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<TicketCreation> {
  try {
    const { stdout } = await execFileAsync("flicker", ["ticket", "list", "--json"], { cwd: repo, env: options.env ?? process.env, maxBuffer: 20_000_000 });
    const parsed = JSON.parse(stdout);
    const tickets = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickets) ? parsed.tickets : [];
    const marker = `Pi Fusion workflow: ${workflowId}`;
    const matches = tickets.filter((ticket: unknown) => typeof (ticket as { body_md?: unknown })?.body_md === "string" && (ticket as { body_md: string }).body_md.includes(marker));
    if (matches.length > 1) return { ok: false, ticketId: null, error: "Multiple Flicker tickets match the workflow marker" };
    const match = matches[0];
    const id = typeof match?.id === "number" ? String(match.id) : typeof match?.id === "string" ? match.id : null;
    return { ok: true, ticketId: id };
  } catch (error) {
    return { ok: false, ticketId: null, error: (error as Error).message.slice(0, 200) };
  }
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

export async function readFlickerTicketStatus(ticketId: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; status: string | null; error?: string }> {
  try {
    const { stdout } = await execFileAsync("flicker", ["ticket", "show", ticketId, "--json"], { env: options.env ?? process.env });
    const status = JSON.parse(stdout)?.status;
    return typeof status === "string" ? { ok: true, status } : { ok: false, status: null, error: "Flicker ticket response did not contain a status" };
  } catch (error) {
    return { ok: false, status: null, error: (error as Error).message.slice(0, 200) };
  }
}

/**
 * Reconcile a workflow with Flicker's real lifecycle. Local workflow completion
 * means tested release readiness, not merge completion, so it deliberately
 * leaves the ticket in_progress. Only the release stage may call ticket complete.
 */
export async function syncFlickerStatus(ticketId: string, status: WorkflowState["status"], options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; error?: string }> {
  const env = options.env ?? process.env;
  const run = (command: string) => execFileAsync("flicker", ["ticket", command, ticketId, "--json"], { cwd: process.cwd(), env });
  try {
    const { stdout } = await execFileAsync("flicker", ["ticket", "show", ticketId, "--json"], { cwd: process.cwd(), env });
    const current = JSON.parse(stdout)?.status;
    if (typeof current !== "string") return { ok: false, error: "Flicker ticket response did not contain a status" };

    if (status === "cancelled") {
      if (current === "selected_for_dev" || current === "in_progress") await run("defer");
      return { ok: true };
    }
    if (current === "done") return { ok: false, error: "Flicker ticket is already done; refusing automatic reopen" };
    if (current === "backlog") {
      await run("select-for-dev");
      await run("start");
    } else if (current === "selected_for_dev") {
      await run("start");
    }
    // in_progress is already correct for running, paused, blocked, recovered,
    // and locally complete/release-ready workflows.
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }
}
