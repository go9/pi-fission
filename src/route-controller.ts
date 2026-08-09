import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelIdentity {
  provider: string;
  id: string;
}

type ActivePiModel = NonNullable<ExtensionContext["model"]>;
type PiThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

/** What the session was using before we routed it, so we can put it back. */
export interface RestorePoint {
  model: ActivePiModel | null;
  thinkingLevel: PiThinkingLevel | null;
}

/**
 * Where this session is in the route/restore cycle. Expressed as a union because the five
 * booleans it replaces could describe states that cannot happen — "changed the model but
 * has nothing to restore", "restoring while not routed" — and nothing rejected them.
 */
export type RoutePhase =
  | { kind: "idle" }
  | { kind: "routed"; restore: RestorePoint; changedModel: boolean }
  | { kind: "restoring"; restore: RestorePoint; changedModel: boolean };

/** What the extension must do about a model-selection event the host just delivered. */
export type ModelSelectDecision =
  /** Ours, or ambient host activity: track the model and leave routing alone. */
  | "adopt"
  /** Arrived mid-restore: replay it once the restore finishes. */
  | "queue"
  /** A real user choice: pause automatic routing. */
  | "override";

/** A thinking-level transition one of our own model switches caused. */
interface ThinkingEcho {
  model: ModelIdentity;
  previousLevel: PiThinkingLevel;
  level: PiThinkingLevel;
}

export interface RouteState {
  phase: RoutePhase;
  activeModel: ModelIdentity | null;
  /**
   * Model selections we caused and expect the host to echo back. A list with no clock:
   * an expectation is retired by the first matching event, and otherwise lives until the
   * next prompt. The previous implementation gave up after 3000ms of wall time and then
   * read its own slow restore echo as a user override.
   */
  expectedSelections: ModelIdentity[];
  /** User selections that arrived mid-restore, replayed once it finishes. */
  queuedSelections: ActivePiModel[];
  /** Automatic routing is paused because the user picked a model. */
  manual: boolean;
  /** A real prompt has begun; selections before that are host startup defaults. */
  promptSeen: boolean;
  /** Thinking level the user chose during a route, honored when we restore. */
  userThinkingLevel: PiThinkingLevel | null;
  /** An explicit setThinkingLevel of ours, awaiting its echo. */
  expectedThinkingLevel: PiThinkingLevel | null;
  /** Thinking transitions our model switches caused, awaiting their echoes. */
  expectedThinkingEchoes: ThinkingEcho[];
  /** Set while one of our own setModel calls is in flight. */
  selectionInFlight: boolean;
  /** Thinking level when the in-flight selection began, and whether we saw its echo. */
  thinkingAtSelectionStart: PiThinkingLevel | null;
  thinkingEchoObserved: boolean;
}

export function createRouteState(): RouteState {
  return {
    phase: { kind: "idle" },
    activeModel: null,
    expectedSelections: [],
    queuedSelections: [],
    manual: false,
    promptSeen: false,
    userThinkingLevel: null,
    expectedThinkingLevel: null,
    expectedThinkingEchoes: [],
    selectionInFlight: false,
    thinkingAtSelectionStart: null,
    thinkingEchoObserved: false,
  };
}

function sameModel(left: ModelIdentity, right: ModelIdentity): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/** Record that we are about to select `model`, so its echo is not read as a user choice. */
export function expectSelection(state: RouteState, model: ModelIdentity): void {
  state.expectedSelections.push({ provider: model.provider, id: model.id });
}

/** Retire one expectation matching `model`. True when this event was ours. */
export function claimSelection(state: RouteState, model: ModelIdentity): boolean {
  const index = state.expectedSelections.findIndex((expected) => sameModel(expected, model));
  if (index < 0) return false;
  state.expectedSelections.splice(index, 1);
  return true;
}

/**
 * Classify a model-selection event. Pure apart from retiring the expectation it matches,
 * which is what makes the answer stable: whether an event is ours is a fact about what
 * caused it, never about how quickly the host got around to telling us.
 */
export function decideModelSelect(
  state: RouteState,
  event: { model: ActivePiModel; source?: string },
): ModelSelectDecision {
  if (claimSelection(state, event.model)) return "adopt";
  if (state.phase.kind === "restoring") return "queue";
  // The host re-applying a model it already had is never a user decision.
  if (event.source === "restore") return "adopt";
  if (event.source === "cycle" || state.promptSeen) return "override";
  // Before the first prompt: a startup default or an idle provider fallback.
  return "adopt";
}

/**
 * Absorb a thinking-level event, recording the level to restore when the user chose it.
 * Returns nothing because the caller has no decision to make: every outcome is bookkeeping.
 */
export function observeThinkingSelect(
  state: RouteState,
  event: { previousLevel: PiThinkingLevel; level: PiThinkingLevel },
): void {
  if (state.expectedThinkingLevel === event.level) {
    state.expectedThinkingLevel = null;
    return;
  }
  // The host clamping the level while our own model switch is still in flight.
  if (state.selectionInFlight
    && state.thinkingAtSelectionStart === event.previousLevel
    && !state.thinkingEchoObserved) {
    state.thinkingEchoObserved = true;
    return;
  }
  const index = state.expectedThinkingEchoes.findIndex((echo) =>
    state.activeModel !== null
    && sameModel(state.activeModel, echo.model)
    && echo.previousLevel === event.previousLevel
    && echo.level === event.level);
  if (index >= 0) {
    state.expectedThinkingEchoes.splice(index, 1);
    return;
  }
  // Nothing of ours explains it, and a route is in progress: the user chose this level.
  if (state.phase.kind !== "idle" || state.selectionInFlight) state.userThinkingLevel = event.level;
}

/** Note a thinking transition caused by one of our model switches. */
export function expectThinkingEcho(state: RouteState, echo: ThinkingEcho): void {
  state.expectedThinkingEchoes.push(echo);
}

/**
 * Start a prompt. Expectations are bounded here rather than by a timer: anything the host
 * still owed us from the previous turn is stale once a new turn begins.
 */
export function beginPrompt(state: RouteState): void {
  state.promptSeen = true;
  state.expectedSelections = [];
}

/** Enter the routed phase; the restore point is what we put back when the turn settles. */
export function beginRoute(state: RouteState, restore: RestorePoint, changedModel: boolean): void {
  state.phase = { kind: "routed", restore, changedModel };
}

/** Leave any route without restoring, e.g. the group selection failed or the user took over. */
export function endRoute(state: RouteState): void {
  state.phase = { kind: "idle" };
  state.queuedSelections = [];
  state.userThinkingLevel = null;
  state.expectedThinkingLevel = null;
  state.expectedThinkingEchoes = [];
  state.selectionInFlight = false;
  state.thinkingAtSelectionStart = null;
  state.thinkingEchoObserved = false;
}

/**
 * Start a fresh session. The extension is loaded once per Pi process but `session_start`
 * fires again for every new/resumed/forked session, so a pause the user asked for in one
 * session -- or a half-finished route from one that was replaced mid-turn -- must not carry
 * into the next. Leaving `manual` set here disabled automatic routing for the rest of the
 * process with nothing on screen to explain it.
 */
export function resetSession(state: RouteState): void {
  Object.assign(state, createRouteState());
}

/** Take the next user selection seen during a restore, if any. */
export function takeQueuedSelection(state: RouteState): ActivePiModel | null {
  return state.queuedSelections.shift() ?? null;
}
