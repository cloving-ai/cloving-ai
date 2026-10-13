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

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

export function renderSince(from: string, now: string): string {
  return `<span data-since="${escapeHtml(from)}">${elapsed(from, now)}</span>`;
}

export function renderClock(time: string): string {
  return `<span data-clock="${escapeHtml(time)}">${escapeHtml(time.slice(11, 19))}</span>`;
}

export function renderItem(item: WatchItem): string {
  const text = escapeHtml(item.text);
  const full = item.kind === "tool" ? ` title="${text}"` : "";
  return `<div class="item ${escapeHtml(item.kind)}"${full}>${text}</div>`;
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

export function renderGroup(
  items: readonly WatchItem[],
  fold: { readonly key: string; readonly open: boolean },
): string {
  const lines = items.map(renderItem).join("");
  if (items.length < 2) return lines;
  const errors = items.filter((item) => item.kind === "error").length;
  const failed =
    errors === 0
      ? ""
      : ` · <span class="bad">${counted(errors, "error")}</span>`;
  const last = escapeHtml(items.at(-1)?.text ?? "");
  return [
    `<details class="tools" data-key="${escapeHtml(fold.key)}"${fold.open ? " open" : ""}>`,
    `<summary>${counted(items.length - errors, "tool call")}${failed}<span class="last">${last}</span></summary>`,
    `${lines}</details>`,
  ].join("");
}

export function turnTime(turn: WatchTurn, now: string): string {
  if (turn.outcome === "in work") return renderSince(turn.startedAt, now);
  return turn.endedAt === null ? "" : elapsed(turn.startedAt, turn.endedAt);
}

export function renderTurn(turn: WatchTurn, now: string): string {
  const groups = groupActivity(turn.activity);
  const working = turn.outcome === "in work";
  const cost = turn.costUsd === null ? "" : `${turn.costUsd.toFixed(2)} USD`;
  const heading = [
    "Claude turn",
    escapeHtml(turn.outcome),
    turnTime(turn, now),
    cost,
  ];
  const log = groups.map((items, index) =>
    renderGroup(items, {
      key: `${turn.key}:${String(index)}`,
      open: working && index === groups.length - 1,
    }),
  );
  return [
    '<section class="turn">',
    `<h3>${heading.filter((part) => part !== "").join(" · ")}</h3>`,
    `<p class="meta">Branch ${escapeHtml(turn.branch)} · work tree ${escapeHtml(turn.worktree)}</p>`,
    `<div class="activity">${log.join("")}</div>`,
    "</section>",
  ].join("");
}

export function renderWork(turn: WatchTurn | undefined): string {
  if (turn === undefined) return "";
  const block = (lines: readonly string[]): string =>
    `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  const loose = turn.uncommitted.length;
  return [
    turn.commits.length === 0
      ? '<p class="bad">The worker made no commit.</p>'
      : `<p class="fact">Branch <code>${escapeHtml(turn.branch)}</code> · ${counted(turn.commits.length, "commit")}</p>${block(turn.commits)}${block(turn.files)}`,
    loose === 0
      ? '<p class="good">All the work is committed.</p>'
      : `<p class="bad">${counted(loose, "file")} ${loose === 1 ? "is" : "are"} not committed:</p>${block(turn.uncommitted)}`,
    `<details data-key="report" open><summary>Report of the worker</summary><div class="report">${escapeHtml(turn.summary)}</div></details>`,
  ].join("");
}

export function renderCommand(label: string, command: string): string {
  const shown = escapeHtml(command);
  return `<div class="command"><span class="label">${escapeHtml(label)}</span><code>${shown}</code><button type="button" data-copy="${shown}">Copy</button></div>`;
}

export function renderDecision(
  decision: WatchDecision,
  turn: WatchTurn | undefined,
): string {
  const open = turn === undefined ? " open" : "";
  return [
    '<section class="decision">',
    `<h3>Your decision · ${escapeHtml(decision.type)}</h3>`,
    renderWork(turn),
    `<details data-key="prompt"${open}><summary>Full text of the request</summary><pre>${escapeHtml(decision.prompt)}</pre></details>`,
    renderCommand("Approve", decision.approve),
    renderCommand("Deny", decision.deny),
    "</section>",
  ].join("");
}

export function renderEvents(events: readonly WatchEvent[]): string {
  const rows = events.map(
    (event) =>
      `<div class="event">${renderClock(event.recordedAt)} ${escapeHtml(event.type)}</div>`,
  );
  return `<details class="events" data-key="events"><summary>All events (${String(events.length)})</summary>${rows.join("")}</details>`;
}
