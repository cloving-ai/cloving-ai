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
  readonly outcome: string;
  readonly costUsd: number | null;
  readonly activity: readonly WatchItem[];
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
}

export interface WatchModel {
  readonly updatedAt: string;
  readonly host: string;
  readonly service: string;
  readonly runs: readonly WatchRun[];
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderItem(item: WatchItem): string {
  return `<div class="item ${escapeHtml(item.kind)}">${escapeHtml(item.text)}</div>`;
}

export function renderTurn(turn: WatchTurn): string {
  const cost = turn.costUsd === null ? "" : ` · ${turn.costUsd.toFixed(2)} USD`;
  return [
    '<section class="turn">',
    `<h3>Claude turn · ${escapeHtml(turn.outcome)}${cost}</h3>`,
    `<p class="meta">Branch ${escapeHtml(turn.branch)} · work tree ${escapeHtml(turn.worktree)} · started ${escapeHtml(turn.startedAt)}</p>`,
    `<div class="activity">${turn.activity.map(renderItem).join("")}</div>`,
    "</section>",
  ].join("");
}

export function renderDecision(decision: WatchDecision): string {
  return [
    '<section class="decision">',
    `<h3>Decision pending · ${escapeHtml(decision.type)}</h3>`,
    `<pre>${escapeHtml(decision.prompt)}</pre>`,
    `<p>Approve:</p><pre class="command">${escapeHtml(decision.approve)}</pre>`,
    `<p>Deny:</p><pre class="command">${escapeHtml(decision.deny)}</pre>`,
    "</section>",
  ].join("");
}

export function renderEvents(events: readonly WatchEvent[]): string {
  const rows = events.map(
    (event) =>
      `<div class="event">${escapeHtml(event.recordedAt.slice(11, 19))} ${escapeHtml(event.type)}</div>`,
  );
  return `<section class="events"><h3>Events</h3>${rows.join("")}</section>`;
}

export function renderRun(run: WatchRun): string {
  const budget =
    run.spent === null || run.limit === null
      ? ""
      : `<p class="meta">${String(run.spent)} of ${String(run.limit)} effect units</p>`;
  const turns =
    run.turns.length === 0
      ? '<p class="meta">No Claude turn for this run.</p>'
      : run.turns.map(renderTurn).join("");
  return [
    `<h2>${escapeHtml(run.workflowId)} · <span class="state ${escapeHtml(run.state)}">${escapeHtml(run.state)}</span></h2>`,
    `<p class="meta">${escapeHtml(run.runId)}</p>`,
    `<p>${escapeHtml(run.code)}: ${escapeHtml(run.detail)}</p>`,
    budget,
    renderEvents(run.events),
    turns,
    run.decisions.map(renderDecision).join(""),
  ].join("");
}

export function renderRuns(
  runs: readonly WatchRun[],
  selected: string,
): string {
  return runs
    .map((run) => {
      const name = run.turns[0]?.target ?? run.runId.slice(0, 12);
      const marked = run.runId === selected ? "run selected" : "run";
      return `<a class="${marked}" href="#${escapeHtml(run.runId)}">${escapeHtml(name)} · ${escapeHtml(run.state)}</a>`;
    })
    .join("");
}

export function renderPage(model: WatchModel, selected: string): string {
  const down =
    model.service === "up"
      ? ""
      : '<p class="down">The Cloving service does not answer. The page shows the last known records.</p>';
  const run =
    model.runs.find((item) => item.runId === selected) ?? model.runs[0];
  if (run === undefined) return `${down}<p>No run yet.</p>`;
  return `${down}<nav>${renderRuns(model.runs, run.runId)}</nav>${renderRun(run)}`;
}
