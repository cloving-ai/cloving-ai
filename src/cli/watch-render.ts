export interface WatchItem {
  readonly kind: string;
  readonly text: string;
}

export interface WatchTurn {
  readonly key: string;
  readonly runId: string;
  readonly target: string;
  readonly branch: string;
  readonly worktree: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activeAt: string | null;
  readonly outcome: string;
  readonly costUsd: number | null;
  readonly activity: readonly WatchItem[];
  readonly commits: readonly string[];
  readonly files: readonly string[];
  readonly uncommitted: readonly string[];
  readonly summary: string;
}

export interface WatchDecision {
  readonly decisionId: string;
  readonly type: string;
  readonly prompt: string;
  readonly approve: string;
  readonly deny: string;
}

export interface WatchEvent {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly type: string;
}

export interface WatchPhase {
  readonly name: string;
  readonly state: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface WatchRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly state: string;
  readonly code: string;
  readonly detail: string;
  readonly spent: number | null;
  readonly limit: number | null;
  readonly decisions: readonly WatchDecision[];
  readonly events: readonly WatchEvent[];
  readonly turns: readonly WatchTurn[];
  readonly phases: readonly WatchPhase[];
  readonly decision: string;
}

export interface WatchModel {
  readonly updatedAt: string;
  readonly host: string;
  readonly service: string;
  readonly runs: readonly WatchRun[];
}

export interface WatchTone {
  readonly tone: string;
  readonly icon: string;
  readonly label: string;
}

export interface Copying {
  readonly command: string;
  readonly label: string;
  readonly onCopy: (command: string) => void;
}

export function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function elapsed(from: string, to: string): string {
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (Number.isNaN(span)) return "";
  const seconds = Math.max(0, span);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${String(seconds)} s`;
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60)} s`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

export function clockTime(time: string): string {
  const moment = new Date(time);
  return Number.isNaN(moment.getTime()) ? "" : moment.toLocaleTimeString();
}

export function groupActivity(activity: readonly WatchItem[]): WatchItem[][] {
  const routine = (item: WatchItem | undefined): boolean =>
    item?.kind === "tool" || item?.kind === "error";
  return activity.reduce<WatchItem[][]>((groups, item) => {
    const last = groups.at(-1) ?? [];
    if (routine(item) && routine(last[0]))
      return [...groups.slice(0, -1), [...last, item]];
    return [...groups, [item]];
  }, []);
}

export function turnTime(turn: WatchTurn, now: string): string {
  if (turn.outcome === "in work") return elapsed(turn.startedAt, now);
  return turn.endedAt === null ? "" : elapsed(turn.startedAt, turn.endedAt);
}

export function toneOf(state: string): WatchTone {
  const tones: Readonly<Record<string, readonly [string, string, string]>> = {
    waiting_gate: ["attention", "!", "Needs your decision"],
    running: ["working", "●", "In work"],
    paused: ["attention", "Ⅱ", "Paused"],
    completed: ["good", "✓", "Completed"],
    failed: ["bad", "✕", "Failed"],
    cancelled: ["bad", "✕", "Dropped"],
  };
  const [tone, icon, label] = tones[state] ?? ["idle", "○", state];
  return { tone, icon, label };
}

export function runTone(run: WatchRun): WatchTone {
  if (run.state === "completed" && run.decision === "denied")
    return { tone: "idle", icon: "✕", label: "Denied" };
  return toneOf(run.state);
}

export function runName(run: WatchRun): string {
  return run.turns[0]?.target ?? run.runId.slice(0, 12);
}

export function waitingDetail(run: WatchRun, now: string): string {
  const opened = run.phases.find((phase) => phase.state === "active");
  const since = opened?.startedAt ?? null;
  const waited = since === null ? "" : ` for ${elapsed(since, now)}`;
  return `A decision waits for you${waited}. Examine the work, then approve or deny.`;
}

export function completedDetail(run: WatchRun): string {
  const [first] = run.events;
  const last = run.events.at(-1);
  const cost = run.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  const time =
    first === undefined || last === undefined
      ? ""
      : ` in ${elapsed(first.recordedAt, last.recordedAt)}`;
  const verdicts: Readonly<Record<string, string>> = {
    approved: "You approved the work. ",
    denied: "You denied the work. ",
  };
  return `${verdicts[run.decision] ?? ""}The run completed${time} · cost ${cost.toFixed(2)} USD.`;
}

export function phaseTime(phase: WatchPhase, now: string): string {
  if (phase.startedAt === null) return "";
  if (phase.endedAt === null)
    return phase.state === "active" ? elapsed(phase.startedAt, now) : "";
  return phase.startedAt === phase.endedAt
    ? clockTime(phase.startedAt)
    : elapsed(phase.startedAt, phase.endedAt);
}

export function selectedRun(
  model: WatchModel,
  selected: string,
): WatchRun | undefined {
  return model.runs.find((run) => run.runId === selected) ?? model.runs[0];
}

export function pageTitle(model: WatchModel, selected: string): string {
  const run = selectedRun(model, selected);
  if (run === undefined) return "Cloving";
  const waiting = model.runs.filter((item) => item.state === "waiting_gate");
  const count = waiting.length === 0 ? "" : `(${String(waiting.length)}) `;
  const { icon, label } = runTone(run);
  return `${count}${icon} ${label} · ${runName(run)} · Cloving`;
}
