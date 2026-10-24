import type { WorkflowHandler } from "../host/world-host.ts";
import { record } from "../protocol.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthorityState } from "../authority/transitions.ts";

interface ReplayRun {
  readonly runId: string;
  readonly workflowId?: string;
}

interface ReplayPorts {
  readonly state: () => Promise<Pick<AuthorityState, "details">>;
  readonly run: (receipt: string) => Promise<ReplayRun | undefined>;
  readonly available: (runId: string, workflowId?: string) => Promise<boolean>;
  readonly submit: (command: Readonly<Record<string, unknown>>) => Promise<{
    readonly kind: "accepted" | "duplicate" | "failed" | "rejected";
  }>;
}

function seeded(value: unknown): ReplayRun | undefined {
  const input = record(record(value)?.["runInput"]);
  const runId = record(input?.["attributes"])?.["cloving.run"];
  const workflowId = input?.["workflowName"];
  return typeof runId === "string" && typeof workflowId === "string"
    ? { runId, workflowId }
    : undefined;
}

async function located(ports: ReplayPorts, receipt: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await ports.run(receipt);
    if (run !== undefined) return run;
    await delay(5);
  }
  return undefined;
}

async function observedReplay(
  ports: ReplayPorts,
  replay: {
    readonly runId: string;
    readonly receipt: string;
    readonly available: boolean;
  },
): Promise<boolean> {
  const { runId, receipt, available } = replay;
  const observation = (await ports.state()).details[runId]?.observation;
  const unavailable = observation?.reason === "pinned-workflow-unavailable";
  if (available !== unavailable) return true;
  const expectedObservation = observation?.sequence ?? 0;
  const outcome = await ports.submit({
    kind: "report-observation",
    runId,
    commandId: `pinned-workflow-${available ? "restored" : "unavailable"}:${receipt}:${String(expectedObservation)}`,
    condition: available ? "working" : "infrastructure-failure",
    reason: available ? "in-progress" : "pinned-workflow-unavailable",
    expectedObservation,
  });
  return outcome.kind === "accepted" || outcome.kind === "duplicate";
}

export function pinnedWorkflowHandler(
  handler: (request: Request, runId: string) => Promise<Response>,
  ports: ReplayPorts,
): WorkflowHandler {
  return async (request) => {
    const value: unknown = await request
      .clone()
      .json()
      .catch(() => undefined);
    const receipt = record(value)?.["runId"];
    if (typeof receipt !== "string")
      return new Response("invalid-workflow-message", { status: 400 });
    const run =
      (await ports.run(receipt)) ??
      seeded(value) ??
      (await located(ports, receipt));
    if (run === undefined)
      return new Response("unknown-world-run", { status: 503 });
    const available = await ports.available(run.runId, run.workflowId);
    if (
      !(await observedReplay(ports, { runId: run.runId, receipt, available }))
    )
      return new Response("workflow-observation-unavailable", { status: 503 });
    if (available) return handler(request, run.runId);
    return new Response("pinned-workflow-unavailable", { status: 503 });
  };
}
