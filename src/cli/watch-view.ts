import {
  counted,
  elapsed,
  escapeHtml,
  renderClock,
  renderDecision,
  renderEvents,
  renderSince,
  renderTurn,
  type WatchModel,
  type WatchPhase,
  type WatchRun,
  type WatchTurn,
} from "./watch-render.ts";

export interface Tone {
  readonly tone: string;
  readonly icon: string;
  readonly label: string;
}

export function toneOf(state: string): Tone {
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

export function runTone(run: WatchRun): Tone {
  if (run.state === "completed" && run.decision === "denied")
    return { tone: "idle", icon: "✕", label: "Denied" };
  return toneOf(run.state);
}

export function runName(run: WatchRun): string {
  return run.turns[0]?.target ?? run.runId.slice(0, 12);
}

export function workingDetail(turn: WatchTurn, now: string): string {
  const calls = turn.activity.filter((item) => item.kind === "tool").length;
  const quiet =
    turn.activeAt === null
      ? ""
      : ` · last output ${renderSince(turn.activeAt, now)} ago`;
  const last = turn.activity.at(-1)?.text ?? "The worker starts.";
  return `Claude works for ${renderSince(turn.startedAt, now)} · ${counted(calls, "tool call")}${quiet}<span class="now">${escapeHtml(last)}</span>`;
}

export function waitingDetail(run: WatchRun, now: string): string {
  const opened = run.phases.find((phase) => phase.state === "active");
  const since = opened?.startedAt ?? null;
  const waited = since === null ? "" : ` for ${renderSince(since, now)}`;
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

export function bannerDetail(run: WatchRun, now: string): string {
  const turn = run.turns.at(-1);
  if (run.state === "running" && turn?.outcome === "in work")
    return workingDetail(turn, now);
  if (run.state === "waiting_gate") return waitingDetail(run, now);
  if (run.state === "completed") return completedDetail(run);
  return `${escapeHtml(run.code)}: ${escapeHtml(run.detail)}`;
}

export function renderBanner(run: WatchRun, now: string): string {
  const { tone, icon, label } = runTone(run);
  return [
    `<section class="banner ${tone}"><span class="icon">${icon}</span>`,
    `<div><h2>${escapeHtml(label)} <span class="name">${escapeHtml(runName(run))}</span></h2>`,
    `<p>${bannerDetail(run, now)}</p></div></section>`,
  ].join("");
}

export function phaseTime(phase: WatchPhase, now: string): string {
  if (phase.startedAt === null) return "";
  if (phase.endedAt === null)
    return phase.state === "active" ? renderSince(phase.startedAt, now) : "";
  return phase.startedAt === phase.endedAt
    ? renderClock(phase.startedAt)
    : elapsed(phase.startedAt, phase.endedAt);
}

export function renderPhases(
  phases: readonly WatchPhase[],
  now: string,
): string {
  const marks: Readonly<Record<string, string>> = {
    done: "✓",
    active: "●",
    failed: "✕",
  };
  const steps = phases.map(
    (phase) =>
      `<li class="phase ${escapeHtml(phase.state)}"><span class="mark">${marks[phase.state] ?? "○"}</span><span class="name">${escapeHtml(phase.name)}</span><span class="time">${phaseTime(phase, now)}</span></li>`,
  );
  return `<ol class="phases">${steps.join("")}</ol>`;
}

export function renderRun(run: WatchRun, now: string): string {
  const reviewed = run.turns.at(-1);
  const budget =
    run.spent === null || run.limit === null
      ? ""
      : ` · ${String(run.spent)} of ${String(run.limit)} effect units`;
  const turns =
    run.turns.length === 0
      ? '<p class="meta">No Claude turn for this run.</p>'
      : run.turns.map((turn) => renderTurn(turn, now)).join("");
  return [
    renderBanner(run, now),
    renderPhases(run.phases, now),
    run.decisions
      .map((decision) => renderDecision(decision, reviewed))
      .join(""),
    turns,
    renderEvents(run.events),
    `<p class="meta foot">${escapeHtml(run.workflowId)} · ${escapeHtml(run.runId)}${budget}<br>${escapeHtml(run.code)}: ${escapeHtml(run.detail)}</p>`,
  ].join("");
}

export function renderRuns(
  runs: readonly WatchRun[],
  selected: string,
): string {
  return runs
    .map((run) => {
      const { tone, icon, label } = runTone(run);
      const marked = run.runId === selected ? " selected" : "";
      return `<a class="run ${tone}${marked}" href="#${escapeHtml(run.runId)}"><span class="icon">${icon}</span> ${escapeHtml(runName(run))} · ${escapeHtml(label)}</a>`;
    })
    .join("");
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

export function renderPage(model: WatchModel, selected: string): string {
  const down =
    model.service === "up"
      ? ""
      : '<p class="down">The Cloving service does not answer. The page shows the last known records.</p>';
  const run = selectedRun(model, selected);
  if (run === undefined)
    return `${down}<p class="meta">No run yet. Submit one with <code>cloving run</code>.</p>`;
  return `${down}<nav>${renderRuns(model.runs, run.runId)}</nav>${renderRun(run, model.updatedAt)}`;
}
