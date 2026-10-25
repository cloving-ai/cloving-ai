import { metadataOf, outcomeOf } from "./run-metadata.ts";
import { linksOf, type RunLinks } from "../authority/handoff-chain.ts";
import {
  runView,
  unresolvedEffects,
  type OperationSummary,
  type RunView,
  type StatusInput,
} from "../authority/status.ts";
import type {
  OperationRecord,
  OperationView,
  StoredState,
} from "../broker/actor/authority.ts";
import { record, type Fields, type Reply } from "../protocol.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  wholeNumber,
  type ServiceContext,
} from "./replies.ts";
import type { WorkerTotals } from "../worker-usage.ts";
import { usageTotals } from "./worker-totals.ts";
import { commandFields } from "./command-effects.ts";
import { feedbackOf } from "./decision-handler.ts";
import { queueOverview } from "./submission-handler.ts";
import { queueRunStatuses } from "./queue-runs.ts";

interface Snapshot {
  readonly links: Readonly<Record<string, RunLinks>>;
  readonly state: StoredState;
  readonly operations: readonly OperationRecord[];
  readonly sequences: Readonly<Record<string, number>>;
  readonly times: Readonly<Record<string, string>>;
  readonly workflowIds: Readonly<Record<string, string>>;
}

async function snapshot(context: ServiceContext): Promise<Snapshot> {
  const { authority } = context;
  const state = await authority.state();
  const sequences = await authority.queries.sequences();
  return {
    links: await authority.queries.runLinks(),
    state,
    operations: await authority.operations(),
    sequences: sequences.runs,
    times: sequences.times,
    workflowIds: await authority.queries.workflowIds(),
  };
}

function silent(
  context: ServiceContext,
  signs: readonly (string | undefined)[],
): boolean {
  const times = signs
    .filter((sign) => sign !== undefined)
    .map((sign) => Date.parse(sign));
  if (times.length === 0) return false;
  const elapsed = Date.parse(context.clock()) - Math.max(...times);
  return elapsed > context.livenessMilliseconds;
}

function summaries(
  snapshot: Snapshot,
  runId: string,
): readonly OperationSummary[] {
  return snapshot.operations
    .filter((operation) => operation.runId === runId)
    .map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      releasedSequence: operation.releasedSequence,
      outcomes: operation.deliveries.map((delivery) => delivery.outcome),
    }));
}

async function effectInput(
  context: ServiceContext,
  runId: string,
): Promise<
  Pick<StatusInput, "budget" | "effects" | "effectEvidence"> & {
    readonly commandOperations: readonly OperationView[];
  }
> {
  const { effects } = context.authority;
  const budget = await effects.budget(runId);
  const stored = await effects.operations(runId);
  return {
    commandOperations: stored.filter(
      (operation) => operation.capability === "command",
    ),
    budget: budget ? { limit: budget.limit, spent: budget.spent } : null,
    effects: stored.map((operation) => ({
      operationId: operation.operationId,
      status: operation.status,
      reason: operation.waitCause ?? operation.reason,
      leaseGeneration: operation.leaseGeneration,
      attempts: operation.attempts,
      limit: operation.recoveryLimit,
    })),
    effectEvidence: await effects.evidence(runId),
  };
}

type ShownRun = RunView &
  RunLinks & {
    readonly commandOperations: readonly OperationView[];
    readonly input: Fields | null;
    readonly workflowId: string;
    readonly latestAt: string | null;
    readonly unresolvedEffects: readonly string[];
    readonly feedback: readonly Fields[];
  };

async function viewOf(
  context: ServiceContext,
  scope: { readonly snapshot: Snapshot; readonly runId: string },
): Promise<ShownRun | undefined> {
  const { state, sequences, times } = scope.snapshot;
  const run = isIdentifier(scope.runId) ? state.runs[scope.runId] : undefined;
  if (run === undefined) return undefined;
  const details = state.details[run.runId];
  const effects = await effectInput(context, run.runId);
  const input = {
    ...effects,
    closure:
      run.status === "cancelled"
        ? await context.authority.effects.closure(run.runId)
        : null,
    run,
    details,
    gates: Object.values(state.gates)
      .filter((gate) => gate.runId === run.runId)
      .sort((left, right) => left.openedSequence - right.openedSequence),
    operations: summaries(scope.snapshot, run.runId),
    latestSequence: sequences[run.runId] ?? 0,
    silent: silent(context, [
      details?.observation?.recordedAt,
      times[run.runId],
    ]),
  };
  return {
    ...runView(input),
    commandOperations: effects.commandOperations,
    ...linksOf({ runId: run.runId, ...scope.snapshot.links[run.runId] }),
    input: await submittedInput(context, details?.submission),
    workflowId: scope.snapshot.workflowIds[run.runId] ?? run.workflow,
    latestAt: times[run.runId] ?? null,
    unresolvedEffects: unresolvedEffects(input),
    feedback: await feedbackOf(context, { state, runId: run.runId }),
  };
}

function summary(view: ShownRun): Fields {
  return {
    runId: view.runId,
    ...linksOf(view),
    input: view.input,
    workflowId: view.workflowId,
    state: view.state,
    condition: view.condition,
    revision: view.revision,
    latestSequence: view.latestSequence,
    latestAt: view.latestAt,
    pendingDecisions: view.pendingDecisions,
  };
}

function full(view: ShownRun & WorkerTotals): Fields {
  return {
    ...summary(view),
    reason: view.reason,
    evidence: view.evidence,
    lastConfirmedObservation: view.lastConfirmedObservation,
    recovery: view.recovery,
    claudeCostUsd: view.claudeCostUsd,
    estimatedCostUsd: view.estimatedCostUsd,
    usage: view.usage,
    workerTurns: view.workerTurns,
    budget: view.budget,
    effects: view.effects,
    nextAction: view.nextAction,
    nextActionAt: view.nextActionAt,
    humanInputCanHelp: view.humanInputCanHelp,
    feedback: view.feedback,
  };
}

async function submittedInput(
  context: ServiceContext,
  digest: string | null | undefined,
): Promise<Fields | null> {
  const document = digest
    ? await context.authority.queries.document(digest)
    : undefined;
  const request = record(JSON.parse(document ?? "null"));
  return record(request?.["submission"]) ?? null;
}

async function listed(
  context: ServiceContext,
  page: {
    readonly snapshot: Snapshot;
    readonly after: string;
    readonly limit: number;
  },
): Promise<Reply> {
  const identifiers = Object.keys(page.snapshot.state.runs)
    .sort()
    .filter((runId) => runId > page.after);
  const shown = identifiers.slice(0, page.limit);
  const views = [];
  for (const runId of shown)
    views.push(await viewOf(context, { snapshot: page.snapshot, runId }));
  const runs = views.filter((view) => view !== undefined).map(summary);
  return result("run-list", {
    ...(await queueOverview(context)),
    workflows: context.registry.workflowIds,
    workflowRefusals: context.workflowRefusals ?? [],
    ...(Object.keys(context.registry.workflowStages).length === 0
      ? {}
      : {
          workflowStages: context.registry.workflowStages,
        }),
    runs,
    next: identifiers.length > shown.length ? (shown.at(-1) ?? null) : null,
    worldReports: context.worldReports?.() ?? [],
  });
}

function listParameters(
  parameters: Fields,
): { readonly after: string; readonly limit: number } | undefined {
  const after: unknown = parameters["after"] ?? "";
  const limit: unknown = parameters["limit"] ?? 50;
  if (typeof after !== "string" || !wholeNumber(limit, 1) || limit > 500)
    return undefined;
  return { after, limit };
}

export async function status(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  if (parameters["runIds"] !== undefined)
    return queueRunStatuses(context, parameters["runIds"]);
  const { runId } = parameters;
  const page = listParameters(parameters);
  if (page === undefined)
    return invalidRequest("The status request is not valid.");
  const current = await snapshot(context);
  if (runId === undefined)
    return listed(context, { snapshot: current, ...page });
  const named = typeof runId === "string" ? runId : "";
  const view = await viewOf(context, { snapshot: current, runId: named });
  if (view === undefined)
    return failed("unknown-run", { detail: `No run has the ID ${named}.` });
  const totals = await usageTotals(context, view.runId);
  return result("run-status", {
    run: {
      ...full({ ...view, ...totals }),
      ...(await commandFields(context, view.commandOperations)),
      outcome: await outcomeOf(context, view),
      ...(await metadataOf(context, {
        workflowId: view.workflowId,
        digest: current.state.details[view.runId]?.input,
      })),
    },
  });
}

const kinds: Readonly<Record<string, string>> = {
  pause: "pause-run",
  resume: "resume-run",
  drop: "cancel-run",
};

async function reported(
  context: ServiceContext,
  outcome: {
    readonly command: string;
    readonly commandId: string;
    readonly runId: string;
    readonly replayed: boolean;
  },
): Promise<Reply> {
  const { command, commandId, runId } = outcome;
  const stored = await context.authority.queries.receipt(commandId);
  const current = await snapshot(context);
  const view = await viewOf(context, { snapshot: current, runId });
  if (stored === undefined || view === undefined)
    return failed("authority-unavailable", { commandId, runId });
  const operations = current.operations.filter(
    (operation) => operation.runId === runId,
  );
  return result("run-command", {
    command,
    runId,
    commandId,
    replayed: outcome.replayed,
    receipt: publicReceipt(stored),
    committed: {
      state: view.state,
      revision: view.revision,
      revokedIntents: operations.filter(
        (operation) => operation.releasedSequence === stored.sequence,
      ).length,
    },
    observed: {
      condition: view.condition,
      unresolvedEffects: view.unresolvedEffects,
    },
  });
}

export async function runCommand(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { command, runId, expectedRevision, commandId } = parameters;
  if (
    typeof command !== "string" ||
    !Object.hasOwn(kinds, command) ||
    !isIdentifier(runId) ||
    !isIdentifier(commandId) ||
    !wholeNumber(expectedRevision, 1)
  )
    return invalidRequest("The run command request is not valid.");
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: { kind: kinds[command], commandId, runId, expectedRevision },
  });
  if (!committed(receipt)) {
    const run = (await context.authority.state()).runs[runId];
    return rejection(receipt, {
      commandId,
      runId,
      currentRevision: run?.revision ?? null,
    });
  }
  return reported(context, {
    command,
    commandId,
    runId,
    replayed: receipt.kind === "duplicate",
  });
}
