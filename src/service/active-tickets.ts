import { record, type Fields } from "../protocol.ts";
import type { ServiceContext } from "./replies.ts";

export async function activeWorkflow(
  context: ServiceContext,
  workflowId: string,
): Promise<Fields[]> {
  const workflows = await context.authority.queries.workflowIds();
  const state = await context.authority.state();
  const queued = context.registry.byId(workflowId)?.queue === true;
  const runs = Object.values(state.runs).filter(
    (run) => !["completed", "failed", "cancelled"].includes(run.status),
  );
  const active = await Promise.all(
    runs.map(async (run) => {
      if (
        workflows[run.runId] !== workflowId &&
        !(
          queued &&
          (workflows[run.runId] === "develop-issue" ||
            (await context.authority.queries.manifest(run.runId))?.queue ===
              true)
        )
      )
        return undefined;
      return storedTicket(context, state.details[run.runId]?.input);
    }),
  );
  return active.filter((input) => input !== undefined);
}

export async function queueOverview(context: ServiceContext): Promise<Fields> {
  const workflow = context.registry.workflowIds
    .map((id) => context.registry.byId(id))
    .find((workflow) => workflow?.admission !== undefined);
  if (workflow?.admission === undefined) return {};
  const active = await activeWorkflow(context, workflow.workflowId);
  return {
    queue: {
      lanes: workflow.admission === "when-idle" ? 1 : workflow.admission,
      busy: active.length,
      skipped: [
        ...active.flatMap((input) =>
          typeof input["ticketId"] === "string"
            ? [{ ticketId: input["ticketId"], reason: "ticket-active" }]
            : [],
        ),
        ...(workflow.resolver.skippedTickets?.() ?? []),
      ],
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
