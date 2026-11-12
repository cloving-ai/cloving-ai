import { record, type Fields, type Reply } from "../protocol.ts";
import { queueStateFields, readyFields } from "../queue-state.ts";
import { maximumQueueLanes } from "../queue-room.ts";
import { failed } from "./replies.ts";
import { queueRun, queueSpend } from "./queue-spend.ts";
import type { ServiceContext } from "./replies.ts";
import type { Registered } from "./registry.ts";

export function queuePort(context: ServiceContext, workflowId: string) {
  return context.queues === undefined
    ? context.queue
    : context.queues.get(workflowId);
}

export function currentLanes(
  context: ServiceContext,
  workflow: Registered | undefined,
): Registered | undefined {
  const lanes = queuePort(context, workflow?.workflowId ?? "")?.control()
    ?.lanes;
  return workflow?.manifest.queue === true && lanes !== undefined
    ? { ...workflow, admission: lanes }
    : workflow;
}

interface ActiveRun {
  readonly runId: string;
  readonly input: Fields;
}

export async function activeWorkflow(
  context: ServiceContext,
  workflowId: string,
): Promise<Fields[]> {
  const active = await activeRuns(context, workflowId);
  return active.map((run) => run.input);
}

export async function submissionTickets(
  context: ServiceContext,
  workflow: Registered,
) {
  const activeTickets = await activeWorkflow(context, workflow.workflowId);
  return {
    activeTickets,
    resolverTickets:
      workflow.manifest.queue === true
        ? await queueTickets(context)
        : activeTickets,
  };
}

async function queueTickets(context: ServiceContext): Promise<Fields[]> {
  const ids = context.registry.workflowIds.filter(
    (id) => context.registry.byId(id)?.manifest.queue === true,
  );
  return (
    await Promise.all(ids.map((id) => activeWorkflow(context, id)))
  ).flat();
}

async function activeRuns(
  context: ServiceContext,
  workflowId: string,
): Promise<ActiveRun[]> {
  const workflows = await context.authority.queries.workflowIds();
  const state = await context.authority.state();
  const runs = Object.values(state.runs).filter(
    (run) => !["completed", "failed", "cancelled"].includes(run.status),
  );
  const membership = await queueMembership(context, {
    workflowId,
    workflows,
    runs,
  });
  const active = await Promise.all(
    runs
      .filter((run) => membership.has(run.runId))
      .map(async (run) => ({
        runId: run.runId,
        input: await storedTicket(context, state.details[run.runId]?.input),
      })),
  );
  return active;
}

async function queueMembership(
  context: ServiceContext,
  scope: {
    readonly workflowId: string;
    readonly workflows: Readonly<Record<string, string>>;
    readonly runs: readonly { readonly runId: string }[];
  },
): Promise<ReadonlySet<string>> {
  const { workflowId, workflows, runs } = scope;
  const queuedIds = context.registry.workflowIds
    .filter(
      (id) =>
        context.registry.byId(id)?.manifest.queue === true &&
        (context.registry.byId(id)?.admission !== undefined ||
          queuePort(context, id)?.control()?.off !== undefined),
    )
    .toSorted();
  const historical =
    !queuedIds.includes(workflowId) &&
    (
      await Promise.all(
        runs
          .filter((run) => workflows[run.runId] === workflowId)
          .map((run) => queueRun(context, run.runId)),
      )
    ).includes(true);
  const legacy = queuedIds[0] === workflowId || historical;
  const matches = await Promise.all(
    runs.map(async (run) => {
      if (workflows[run.runId] === workflowId) return run.runId;
      if (
        !legacy ||
        (!historical && queuedIds.includes(workflows[run.runId] ?? ""))
      )
        return undefined;
      return (await queueRun(context, run.runId)) ? run.runId : undefined;
    }),
  );
  return new Set(matches.filter((id) => id !== undefined));
}

export async function repositoryQueueRefusal(
  context: ServiceContext,
  identity: Fields,
) {
  const state = await context.authority.state();
  const active = Object.values(state.runs).filter(
    (run) => !["completed", "failed", "cancelled"].includes(run.status),
  );
  const queued = await Promise.all(
    active.map((run) => queueRun(context, run.runId)),
  );
  return queued.filter(Boolean).length < maximumQueueLanes
    ? undefined
    : failed("queue-repository-full", {
        ...identity,
        detail: "16 of 16 repository queue lanes busy",
      });
}

export function laneCount(admission: "when-idle" | number): number {
  return admission === "when-idle" ? 1 : admission;
}

export async function queueOverview(context: ServiceContext): Promise<Fields> {
  const workflows = context.registry.workflowIds
    .toSorted()
    .map((id) => currentLanes(context, context.registry.byId(id)))
    .filter(
      (workflow): workflow is Registered =>
        workflow !== undefined &&
        (workflow.admission !== undefined ||
          queuePort(context, workflow.workflowId)?.control()?.off !==
            undefined),
    );
  const overviews = await Promise.all(
    workflows.map((workflow) => workflowOverview(context, workflow)),
  );
  const queues = overviews.map((overview) => overview["queue"]);
  if (queues.length === 0) {
    const off = context.queue?.control()?.off;
    return off === undefined ? { queues } : { queues, queueOff: { ...off } };
  }
  const off = context.queue?.control()?.off;
  return {
    queues,
    queue: queues[0],
    ...(off === undefined ? {} : { queueOff: { ...off } }),
  };
}

async function workflowOverview(
  context: ServiceContext,
  workflow: Registered,
): Promise<Fields> {
  const runs = await activeRuns(context, workflow.workflowId);
  const active = runs.map((run) => run.input);
  const activeTicketIds = active.flatMap((input) =>
    typeof input["ticketId"] === "string" ? [input["ticketId"]] : [],
  );
  const skipped = [
    ...activeTicketIds.map((ticketId) => ({
      ticketId,
      reason: "ticket-active",
    })),
    ...(workflow.resolver.skippedTickets?.() ?? []),
  ];
  const control = queuePort(context, workflow.workflowId)?.control();
  return {
    queue: {
      workflowId: workflow.workflowId,
      ...(await queueSpend(context)),
      lanes: laneCount(workflow.admission ?? 0),
      busy: active.length,
      busyRunIds: runs.map((run) => run.runId),
      skipped,
      ...(control === undefined
        ? {}
        : {
            ...queueStateFields(control, active.length),
            ...readyFields(
              control.ready,
              skipped.flatMap((ticket) =>
                typeof ticket["ticketId"] === "string"
                  ? [ticket["ticketId"]]
                  : [],
              ),
            ),
          }),
    },
  };
}

async function storedTicket(
  context: ServiceContext,
  digest: string | null | undefined,
): Promise<Fields> {
  const text = digest
    ? await context.authority.queries.document(digest)
    : undefined;
  const input = record(JSON.parse(text ?? "null")) ?? {};
  const ticket = record(record(input["input"])?.["ticket"]);
  return ticket === undefined
    ? input
    : { ...input, ticketId: ticket["id"], ticket: ticket["text"] };
}

export async function continuationLanesRefusal(
  context: ServiceContext,
  request: { readonly runId: string; readonly commandId: string },
): Promise<Reply | undefined> {
  const workflowId = (
    await context.authority.queries.workflowIds([request.runId])
  )[request.runId];
  const admission =
    workflowId === undefined
      ? undefined
      : currentLanes(context, context.registry.byId(workflowId))?.admission;
  if (workflowId === undefined || admission === undefined) return undefined;
  const lanes = laneCount(admission);
  const busy = (await activeWorkflow(context, workflowId)).length;
  if (busy < lanes) return undefined;
  return failed("continuation-lanes-full", {
    ...request,
    busy,
    lanes,
    detail: `${String(busy)} of ${String(lanes)} lanes are busy. Continue the run when a lane is free.`,
  });
}
