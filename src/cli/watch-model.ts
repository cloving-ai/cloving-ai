import { notesOf } from "./watch-notes-view.ts";
import { shownLoopMarks, type ShownSchedules } from "./schedule-render.ts";
import { loopRows } from "./watch-loops.ts";
import { shownCommandWaits } from "./command-waits.ts";
import { runDecision } from "./watch-decision.ts";
import type { WorkflowStages } from "../workflow-declaration.ts";
import {
  workflowRefusals,
  type WorkflowRefusal,
} from "../workflow-refusals.ts";
import { isTicketStatus } from "../ticket-status.ts";
import { isPromotionId } from "../workflow-contracts.ts";
import { budgetsOf, priceFields, statusTurns } from "./watch-usage.ts";
import { priceOf, usageOf, attemptFields } from "../worker-usage.ts";
import { priceText } from "./usage-render.ts";
import type {
  WatchEvent,
  WatchFeedback,
  WatchItem,
  WatchModel,
  WatchRun,
  WatchTurn,
} from "./watch-render.ts";
import { boardsOf, currentStepOf, roundOf, stagesFor } from "./watch-board.ts";
import { completedOf, shownName } from "./watch-floor.ts";
import { todayStart } from "./watch-today.ts";
import { decisionOf, phasesOf } from "./watch-phases.ts";

import { pullOf, type GithubRecords } from "./watch-pull-request.ts";
export type { GithubRecords } from "./watch-pull-request.ts";
import { establishedIssue, type PrRepository } from "./watch-pr-identity.ts";

import { displayRun } from "./watch-paths.ts";
import { shownCommands } from "./command-effects.ts";
import type { DailyNumbers } from "../report-days.ts";
import { waitingTurn } from "./turn-waits.ts";

type Fields = Readonly<Record<string, unknown>>;

const textLimit = 600;
const activityLimit = 400;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stamp(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function texts(value: unknown): readonly string[] {
  return list(value).filter((item) => typeof item === "string");
}

function parsed(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return undefined;
  }
}

function cut(value: string): string {
  return value.length > textLimit ? `${value.slice(0, textLimit)}…` : value;
}

function summary(input: Fields): string {
  const named = ["command", "file_path", "pattern", "description"]
    .map((name) => text(input[name]))
    .find((value) => value !== "");
  return named ?? JSON.stringify(input);
}

function spoken(part: Fields): WatchItem[] {
  const words = text(part["text"]);
  return words.trim() === "" ? [] : [{ kind: "say", text: words }];
}

function said(part: Fields): WatchItem[] {
  if (part["type"] === "text") return spoken(part);
  if (part["type"] !== "tool_use") return [];
  const tool = `${text(part["name"])}: ${summary(record(part["input"]))}`;
  return [{ kind: "tool", text: tool }];
}

function failed(part: Fields): WatchItem[] {
  if (part["type"] !== "tool_result" || part["is_error"] !== true) return [];
  const content = part["content"];
  const shown = typeof content === "string" ? content : JSON.stringify(content);
  return [{ kind: "error", text: shown }];
}

function ended(line: Fields): WatchItem[] {
  const cost = priceOf(line["total_cost_usd"]);
  return [
    {
      kind: "result",
      text: text(line["result"]),
      ...(cost === null ? {} : { costUsd: cost }),
    },
  ];
}

function parts(line: Fields): readonly Fields[] {
  return list(record(line["message"])["content"]).map(record);
}

export function activityOf(line: string): WatchItem[] {
  const value = record(parsed(line));
  if (value["type"] === "assistant") return parts(value).flatMap(said);
  if (value["type"] === "user") return parts(value).flatMap(failed);
  return value["type"] === "result" ? ended(value) : [];
}

export function turnActivity(lines: readonly string[]): WatchItem[] {
  return lines.flatMap(activityOf).slice(-activityLimit - 1);
}

function concise(items: readonly WatchItem[]): WatchItem[] {
  return items.map((item, index) => {
    const before = items[index - 1];
    if (item.kind !== "result" || before?.kind !== "say") return item;
    if (!item.text.startsWith(before.text)) return item;
    const cost = item.text.slice(before.text.length);
    return { kind: "result", text: `Result of the worker${cost}` };
  });
}

function shortened(run: WatchRun): WatchRun {
  return {
    ...run,
    turns: run.turns.map((turn) => ({
      ...turn,
      activity: concise(
        turn.activity.map((item) => {
          const spent =
            item.kind === "result"
              ? ` (cost ${priceText(item.costUsd, turn.estimatedCostUsd)})`
              : "";
          return { kind: item.kind, text: `${cut(item.text)}${spent}` };
        }),
      ).slice(-activityLimit),
    })),
  };
}

export interface TurnRecords {
  readonly key: string;
  readonly started: unknown;
  readonly result: unknown;
  readonly activity: readonly WatchItem[];
  readonly activeAt?: string | null;
}

export function turnOf(records: TurnRecords): WatchTurn {
  const started = record(records.started);
  const operation = list(parsed(text(started["operationId"])));
  const result = record(records.result);
  const outcome = text(result["outcome"]);
  const report = record(parsed(text(result["result"])));
  const harness = text(started["harness"]) || text(report["harness"]);
  const wait = waitingTurn(text(started["operationId"]), records);
  return {
    ...attemptFields(report["attempts"]),
    ...(wait === undefined ? {} : { wait }),
    ...(harness === "" ? {} : { harness }),
    key: records.key,
    operationId: text(started["operationId"]),
    usage: usageOf(report["usage"]),
    runId: text(operation[2]),
    target: text(started["target"]),
    branch: text(started["branch"]),
    worktree: text(started["worktree"]),
    startedAt: text(started["startedAt"]),
    outcome:
      records.result === null || wait !== undefined ? "in work" : outcome,
    costUsd: priceOf(report["costUsd"]),
    estimatedCostUsd: priceOf(report["estimatedCostUsd"]),
    activity: records.activity
      .map((item) =>
        item.kind === "result"
          ? {
              kind: item.kind,
              text: item.text,
              ...priceFields(report["costUsd"]),
            }
          : item,
      )
      .slice(-activityLimit - 1),
    endedAt: stamp(result["endedAt"]),
    activeAt: records.activeAt ?? null,
    commits: texts(report["commits"]),
    files: texts(report["files"]),
    uncommitted: texts(report["uncommitted"]),
    summary: text(report["summary"]),
  };
}

export interface WatchInputs {
  readonly schedules?: ShownSchedules;
  readonly loopRuns?: readonly Fields[];
  readonly queue?: Fields;
  readonly queues?: readonly Fields[];
  readonly repository?: PrRepository | null;
  readonly workflows: readonly string[];
  readonly workflowRefusals?: readonly WorkflowRefusal[];
  readonly workflowStages?: WorkflowStages;
  readonly summaries?: readonly unknown[];
  readonly home: string;
  readonly client: string;
  readonly updatedAt: string;
  readonly service: string;
  readonly serviceVersion?: string;
  readonly restart?: Fields;
  readonly runs: readonly unknown[];
  readonly completionCandidates?: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly turns: readonly WatchTurn[];
  readonly githubRecords: readonly GithubRecords[];
  readonly today?: DailyNumbers;
}

function feedbackOf(value: unknown): WatchFeedback {
  const fields = record(value);
  return {
    decisionId: text(fields["decisionId"]),
    text: text(fields["text"]),
  };
}

function eventOf(value: unknown): WatchEvent {
  const fields = record(value);
  return {
    sequence: count(fields["sequence"]) ?? 0,
    recordedAt: text(fields["recordedAt"]),
    type: text(fields["type"]),
  };
}

function outcomeOf(
  value: unknown,
): Pick<WatchRun, "outcome" | "promotionId" | "ticketStatus" | "issueUpdate"> {
  const fields = record(value);
  const { promotionId, ticketStatus, issueUpdate } = fields;
  return {
    outcome: stamp(fields["kind"]),
    ...(isPromotionId(promotionId) ? { promotionId } : {}),
    ...(isTicketStatus(ticketStatus) ? { ticketStatus } : {}),
    ...(issueUpdate === "failed" ? { issueUpdate } : {}),
  };
}

function runLinksOf(status: Readonly<Record<string, unknown>>) {
  return {
    parentRunId: stamp(status["parentRunId"]),
    chainId: stamp(status["chainId"]) ?? text(status["runId"]),
    childRunIds: texts(status["childRunIds"]),
    awaitedRunId: stamp(status["awaitedRunId"]),
    ...(typeof status["continuedFrom"] === "string"
      ? { continuedFrom: status["continuedFrom"] }
      : {}),
    ...(typeof status["continuedBy"] === "string"
      ? { continuedBy: status["continuedBy"] }
      : {}),
  };
}

function revisionOf(status: Readonly<Record<string, unknown>>) {
  return Number.isSafeInteger(status["revision"])
    ? { revision: Number(status["revision"]) }
    : {};
}

function runOf(inputs: WatchInputs, value: unknown): WatchRun {
  const status = record(record(value)["status"]);
  const runId = text(status["runId"]);
  const workflowId = text(status["workflowId"]);
  const pull = pullOf(
    { records: inputs.githubRecords, repository: inputs.repository ?? null },
    runId,
  );
  const ticketId = text(status["ticketId"]) || null;
  const issue = establishedIssue(
    inputs.repository ?? null,
    status["issueIdentity"],
  );
  return {
    runId,
    workflowId,
    ...revisionOf(status),
    ...shownLoopMarks(status),
    ...runLinksOf(status),
    ...notesOf(status["notes"]),
    commandWaits: shownCommandWaits(status["commandWaits"]),
    ticketId,
    ...(issue === null ? {} : { issueIdentity: issue }),
    title: stamp(status["title"]),
    ...shownName(status, { ticketId, issue }),
    ...outcomeOf(status["outcome"]),
    latestAt: stamp(status["latestAt"]),
    ...budgetsOf(status),
    usage: usageOf(status["usage"]),
    currentStep: currentStepOf(list(record(value)["events"]), {
      pullRequest: pull.pullRequest,
      stages: stagesFor(inputs.workflowStages, workflowId),
    }),
    round: roundOf(list(record(value)["events"])),
    state: text(status["state"]),
    code: text(record(status["reason"])["code"]),
    detail: text(record(status["reason"])["detail"]),
    decisions: inputs.decisions
      .filter((decision) => record(decision)["runId"] === runId)
      .map((decision) =>
        runDecision(decision, { workflowId, client: inputs.client }),
      ),
    events: list(record(value)["events"]).map(eventOf),
    turns: statusTurns(inputs.turns, status),
    ...(status["commandEffects"] === undefined
      ? {}
      : { commandEffects: shownCommands(status["commandEffects"]) }),
    phases: phasesOf(list(record(value)["events"]), {
      pullRequest: pull.pullRequest,
      stages: stagesFor(inputs.workflowStages, workflowId),
    }),
    decision: decisionOf(list(record(value)["events"])),
    feedback: list(status["feedback"]).map(feedbackOf),
    ...pull,
  };
}

function began(run: WatchRun): string {
  return run.events[0]?.recordedAt ?? "";
}

export function watchModel(inputs: WatchInputs): WatchModel {
  const runs = inputs.runs.map((value) =>
    shortened(displayRun(runOf(inputs, value), inputs.home)),
  );
  const candidates = [
    ...runs,
    ...list(inputs.completionCandidates).map((value) => runOf(inputs, value)),
  ];
  const workflows = boardsOf(
    { ...inputs, completionCandidates: candidates },
    runs,
  );
  return {
    workflows,
    completed: completedOf(runs, todayStart(inputs.updatedAt)),
    ...(inputs.schedules === undefined
      ? {}
      : {
          schedules: inputs.schedules,
          loops: loopRows(inputs.schedules, inputs.loopRuns ?? []),
        }),
    ...(inputs.queue === undefined ? {} : { queue: inputs.queue }),
    ...(inputs.queues === undefined ? {} : { queues: inputs.queues }),
    ...(inputs.today === undefined ? {} : { today: inputs.today }),
    workflowRefusals: workflowRefusals(inputs.workflowRefusals),
    updatedAt: inputs.updatedAt,
    service: inputs.service,
    ...(inputs.serviceVersion === undefined
      ? {}
      : { serviceVersion: inputs.serviceVersion }),
    ...(inputs.restart === undefined ? {} : { restart: inputs.restart }),
    runs: runs.toSorted((first, second) =>
      began(first) < began(second) ? 1 : -1,
    ),
  };
}
