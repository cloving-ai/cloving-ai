import { record, type Fields } from "../protocol.ts";
import {
  loopReport,
  type ReportOutcome,
  type ReportCompletion,
  type ReportCost,
} from "../report.ts";
import { send } from "./client.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { readReportFlow } from "./report-flow.ts";
import { readReportGithub } from "./report-github.ts";

interface ReportEnvironment {
  readonly now?: number;
  readonly runtimeDirectory: string;
  readonly workingDirectory: string;
  readonly watchPr?: WatchPrSettings;
  readonly terminal: { readonly out: (text: string) => void };
}

function reportRecord(value: unknown, after: number) {
  const event = record(value) ?? {};
  const sequence = event["sequence"];
  const at = event["recordedAt"];
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= after ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error("invalid-report-cursor");
  return { event, sequence, at: Date.parse(at) };
}

interface DaemonSnapshot {
  after: number;
  latest: number | null;
  observedSince: number | null;
  readonly completions: Map<string, ReportCompletion>;
  readonly effects: Fields[];
  readonly flowEvents: Fields[];
}

function appendEvents(
  snapshot: DaemonSnapshot,
  values: readonly unknown[],
): void {
  for (const value of values) {
    const parsed = reportRecord(value, snapshot.after);
    if (snapshot.latest !== null && parsed.sequence > snapshot.latest) break;
    snapshot.after = parsed.sequence;
    if (snapshot.observedSince === null || parsed.at < snapshot.observedSince)
      snapshot.observedSince = parsed.at;
    if (
      ["effect.requested", "effect.reported"].includes(
        String(parsed.event["type"]),
      )
    )
      snapshot.effects.push({ ...parsed.event, at: parsed.at });
    if (
      ["run.started", "schedule.skipped"].includes(String(parsed.event["type"]))
    )
      snapshot.flowEvents.push(parsed.event);
    const completion = reportCompletion(parsed.event);
    if (completion === null) continue;
    if (snapshot.completions.has(completion.runId))
      throw new Error("duplicate-report-completion");
    snapshot.completions.set(completion.runId, completion);
  }
}

async function daemonReport(runtime: string) {
  const snapshot: DaemonSnapshot = {
    after: 0,
    latest: null,
    observedSince: null,
    completions: new Map(),
    effects: [],
    flowEvents: [],
  };
  for (;;) {
    const reply = await send(runtime, {
      operation: "events",
      parameters: { after: snapshot.after, limit: 1000 },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const latest = reply.result["latestSequence"];
    if (
      typeof latest !== "number" ||
      !Number.isSafeInteger(latest) ||
      latest < snapshot.after
    )
      throw new Error("invalid-report-snapshot");
    snapshot.latest ??= latest;
    const events = reply.result["events"];
    if (!Array.isArray(events)) throw new Error("invalid-report-events");
    appendEvents(snapshot, events);
    if (snapshot.after >= snapshot.latest)
      return {
        completions: [...snapshot.completions.values()],
        effects: snapshot.effects,
        flowEvents: snapshot.flowEvents,
        observedSince: snapshot.observedSince,
      };
    if (events.length < 1000) throw new Error("incomplete-report-snapshot");
  }
}

function settledSpending(run: Fields): boolean {
  const condition = run["condition"];
  const effects = run["effects"];
  return (
    ["completed", "failed", "cancelled"].includes(String(condition)) &&
    Array.isArray(effects) &&
    effects.every((value: unknown) =>
      ["completed", "failed", "stopped", "cancelled", "refused"].includes(
        String(record(value)?.["state"]),
      ),
    )
  );
}

async function runCost(runtime: string, runId: string): Promise<ReportCost> {
  const reply = await send(runtime, {
    operation: "status",
    parameters: { runId },
  });
  if (reply.kind === "error") return { runId, turns: null };
  const run = record(reply.result["run"]);
  if (run?.["runId"] !== runId) return { runId, turns: null };
  const turns = run["workerTurns"];
  const ticket = runTicket(run);
  if (!Array.isArray(turns) || !settledSpending(run))
    return { runId, ...ticket, turns: null };
  const parsed = turns.map((value: unknown) => {
    const turn = record(value);
    const operationId = turn?.["operationId"];
    const costUsd = turn?.["costUsd"];
    return typeof operationId === "string" &&
      (costUsd === null ||
        (typeof costUsd === "number" &&
          Number.isFinite(costUsd) &&
          costUsd >= 0))
      ? { operationId, costUsd }
      : null;
  });
  return {
    runId,
    ...ticket,
    turns: parsed.some((turn) => turn === null)
      ? null
      : parsed.filter((turn) => turn !== null),
  };
}

function textReport(report: Fields): string {
  const lines = [`Loop report ${JSON.stringify(report["window"])}`];
  for (const [name, value] of Object.entries(record(report["metrics"]) ?? {})) {
    const metric = record(value) ?? {};
    lines.push(
      `${name}: ${metric["status"] === "unavailable" ? "unavailable" : String(metric["value"])}`,
    );
    const baseline = record(metric["baseline"]) ?? {};
    lines.push(
      `  history: ${String(baseline["history"])}; median: ${String(baseline["median"])}; band: ${JSON.stringify(baseline["band"])}${metric["mark"] === "outside" ? "; outside" : ""}`,
    );
    lines.push(`  comparison value: ${String(metric["comparisonValue"])}`);
    lines.push(`  evidence: ${JSON.stringify(metric["evidence"])}`);
    lines.push(`  baseline evidence: ${JSON.stringify(baseline["evidence"])}`);
  }
  lines.push(`Run costs (USD): ${JSON.stringify(report["runCosts"])}`);
  lines.push(
    `Completed ticket costs (USD): ${JSON.stringify(report["completedTicketCosts"])}`,
  );
  lines.push(`Semantics: ${JSON.stringify(report["semantics"])}`);
  lines.push(`Sources: ${JSON.stringify(report["sources"])}`);
  lines.push(`Coverage: ${JSON.stringify(report["coverage"])}`);
  return lines.join("\n") + "\n";
}

export async function reportCommand(
  invocation: { readonly since: number; readonly json: boolean },
  environment: ReportEnvironment,
): Promise<number> {
  const now = environment.now ?? Date.now();
  const since = new Date(
    now - (invocation.since + 168) * 3_600_000,
  ).toISOString();
  const settings =
    environment.watchPr === undefined ? {} : { settings: environment.watchPr };
  const [daemonRead, githubRead] = await Promise.allSettled([
    daemonReport(environment.runtimeDirectory),
    readReportGithub({ since, ...settings }),
  ]);
  const daemon =
    daemonRead.status === "fulfilled"
      ? daemonRead.value
      : {
          completions: null,
          effects: null,
          flowEvents: null,
          observedSince: null,
        };
  const github =
    githubRead.status === "fulfilled" ? { github: githubRead.value } : {};
  const costs = await reportCosts(environment.runtimeDirectory, {
    completions: daemon.completions ?? [],
    start: Date.parse(since),
    end: now,
    issues: githubRead.status === "fulfilled" ? githubRead.value.issues : null,
  });
  const flow = await readReportFlow(environment.runtimeDirectory, {
    events: daemon.flowEvents,
    completions: daemon.completions,
  });
  const calculated = loopReport({
    flow,
    since: invocation.since,
    now,
    ...daemon,
    costs,
    ...github,
  });
  const report = {
    ...calculated,
    window: {
      ...calculated.window,
      start: new Date(calculated.window.start).toISOString(),
      end: new Date(now).toISOString(),
    },
    runCosts: calculated.runCosts.map((cost) => ({
      ...cost,
      completedAt: new Date(cost.completedAt).toISOString(),
    })),
  };
  environment.terminal.out(
    invocation.json ? `${JSON.stringify(report)}\n` : textReport(report),
  );
  return 0;
}

function outcomeOf(event: Fields): ReportOutcome | null {
  if (event["type"] === "run.failed") return "failed";
  if (event["type"] === "run.cancelled") return "cancelled";
  if (event["type"] !== "run.completed") return null;
  const payload = record(event["payload"]) ?? {};
  if (
    payload["outcome"] === "handoff_requested" &&
    payload["ticketStatus"] === "partial"
  )
    return "partial";
  const outcome = payload["outcome"];
  if (outcome === undefined || outcome === "handoff_requested")
    return "completed";
  return outcome === "blocked" ? "blocked" : null;
}

export function reportCompletion(event: Fields): ReportCompletion | null {
  const terminal = ["run.completed", "run.failed", "run.cancelled"].includes(
    String(event["type"]),
  );
  if (!terminal) return null;
  const outcome = outcomeOf(event);
  if (outcome === null) throw new Error("invalid-report-event");
  const runId = event["runId"];
  const sequence = event["sequence"];
  const at = event["recordedAt"];
  if (
    typeof runId !== "string" ||
    typeof sequence !== "number" ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error("invalid-report-event");
  return { runId, sequence, at: Date.parse(at), outcome };
}

function runTicket(run: Fields | undefined): Pick<ReportCost, "ticketId"> {
  const ticketId = run?.["ticketId"];
  return ticketId === null || (typeof ticketId === "string" && ticketId !== "")
    ? { ticketId }
    : {};
}

async function ticketIndex(
  runtime: string,
): Promise<Map<string, string | null>> {
  const index = new Map<string, string | null>();
  let after = "";
  for (;;) {
    const reply = await send(runtime, {
      operation: "status",
      parameters: { metadata: "tickets", after, limit: 500 },
    });
    if (reply.kind === "error") throw new Error(reply.error.code);
    const runs = reply.result["runs"];
    if (!Array.isArray(runs)) throw new Error("invalid-report-ticket-index");
    const latest = appendTicketIndex(index, { runs, after });
    const next = reply.result["next"];
    if (next === null) return index;
    if (typeof next !== "string" || next !== latest || next <= after)
      throw new Error("invalid-report-ticket-cursor");
    after = next;
  }
}

async function reportCosts(
  runtime: string,
  input: {
    readonly completions: readonly ReportCompletion[];
    readonly start: number;
    readonly end: number;
    readonly issues:
      readonly { readonly at: number; readonly evidence: Fields }[] | null;
  },
): Promise<ReportCost[]> {
  const ended = input.completions.filter((event) => event.at < input.end);
  const costs: ReportCost[] = [];
  for (const event of ended.filter((event) => event.at >= input.start))
    costs.push(await runCost(runtime, event.runId));
  const older = ended.filter((event) => event.at < input.start);
  const tickets = new Set(
    (input.issues ?? [])
      .filter((issue) => issue.at >= input.start && issue.at < input.end)
      .map((issue) => String(issue.evidence["issue"])),
  );
  if (older.length === 0 || tickets.size === 0) return costs;
  try {
    const index = await ticketIndex(runtime);
    for (const event of older) {
      const ticketId = index.get(event.runId);
      if (ticketId === undefined) continue;
      costs.push(
        ticketId !== null && tickets.has(ticketId)
          ? await runCost(runtime, event.runId)
          : { runId: event.runId, ticketId, turns: null },
      );
    }
  } catch {
    return costs;
  }
  return costs;
}

function appendTicketIndex(
  index: Map<string, string | null>,
  page: { readonly runs: readonly unknown[]; readonly after: string },
): string {
  let latest = page.after;
  for (const value of page.runs) {
    const row = record(value);
    const runId = row?.["runId"];
    const ticketId = row?.["ticketId"];
    if (
      typeof runId !== "string" ||
      runId <= latest ||
      !(ticketId === null || (typeof ticketId === "string" && ticketId !== ""))
    )
      throw new Error("invalid-report-ticket-index");
    index.set(runId, ticketId);
    latest = runId;
  }
  return latest;
}
