import type { AuthorityState } from "../authority/reducer.ts";
import {
  runView,
  unresolvedEffects,
  type OperationSummary,
  type RunView,
} from "../authority/status.ts";
import type { OperationRecord } from "../broker/actor/authority.ts";
import type { Fields, Reply } from "../protocol.ts";
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

interface Snapshot {
  readonly state: AuthorityState;
  readonly operations: readonly OperationRecord[];
  readonly sequences: Readonly<Record<string, number>>;
  readonly times: Readonly<Record<string, string>>;
}

async function snapshot(context: ServiceContext): Promise<Snapshot> {
  const { authority } = context;
  const sequences = await authority.queries.sequences();
  return {
    state: await authority.state(),
    operations: await authority.operations(),
    sequences: sequences.runs,
    times: sequences.times,
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

type ShownRun = RunView & {
  readonly workflowId: string;
  readonly unresolvedEffects: readonly string[];
};

function viewOf(
  context: ServiceContext,
  scope: { readonly snapshot: Snapshot; readonly runId: string },
): ShownRun | undefined {
  const { state, sequences, times } = scope.snapshot;
  const run = isIdentifier(scope.runId) ? state.runs[scope.runId] : undefined;
  if (run === undefined) return undefined;
  const details = state.details[run.runId];
  const input = {
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
    workflowId:
      context.registry.byPin(run.workflow)?.workflowId ?? run.workflow,
    unresolvedEffects: unresolvedEffects(input),
  };
}

function summary(view: ShownRun): Fields {
  return {
    runId: view.runId,
    workflowId: view.workflowId,
    state: view.state,
    condition: view.condition,
    revision: view.revision,
    latestSequence: view.latestSequence,
    pendingDecisions: view.pendingDecisions,
  };
}

function full(view: ShownRun): Fields {
  return {
    ...summary(view),
    reason: view.reason,
    evidence: view.evidence,
    lastConfirmedObservation: view.lastConfirmedObservation,
    recovery: view.recovery,
    nextAction: view.nextAction,
    nextActionAt: view.nextActionAt,
    humanInputCanHelp: view.humanInputCanHelp,
  };
}

function listed(
  context: ServiceContext,
  page: {
    readonly snapshot: Snapshot;
    readonly after: string;
    readonly limit: number;
  },
): Reply {
  const identifiers = Object.keys(page.snapshot.state.runs)
    .sort()
    .filter((runId) => runId > page.after);
  const shown = identifiers.slice(0, page.limit);
  const runs = shown
    .map((runId) => viewOf(context, { snapshot: page.snapshot, runId }))
    .filter((view) => view !== undefined)
    .map(summary);
  return result("run-list", {
    runs,
    next: identifiers.length > shown.length ? (shown.at(-1) ?? null) : null,
  });
}

export async function status(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { runId } = parameters;
  const after: unknown = parameters["after"] ?? "";
  const limit: unknown = parameters["limit"] ?? 50;
  if (typeof after !== "string" || !wholeNumber(limit, 1) || limit > 500)
    return invalidRequest("The status request is not valid.");
  const current = await snapshot(context);
  if (runId === undefined)
    return listed(context, { snapshot: current, after, limit });
  const named = typeof runId === "string" ? runId : "";
  const view = viewOf(context, { snapshot: current, runId: named });
  if (view === undefined)
    return failed("unknown-run", { detail: `No run has the ID ${named}.` });
  return result("run-status", { run: full(view) });
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
  const view = viewOf(context, { snapshot: current, runId });
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
