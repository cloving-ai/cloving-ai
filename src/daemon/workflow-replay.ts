import type { WorkflowHandler } from "../host/world-host.ts";
import { record } from "../protocol.ts";
import { setTimeout as delay } from "node:timers/promises";

interface ReplayRun {
  readonly runId: string;
  readonly workflowId?: string;
}

interface ReplayPorts {
  readonly run: (receipt: string) => Promise<ReplayRun | undefined>;
  readonly available: (runId: string, workflowId?: string) => Promise<boolean>;
  readonly submit: (
    command: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
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

export function pinnedWorkflowHandler(
  handler: WorkflowHandler,
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
    if (await ports.available(run.runId, run.workflowId))
      return handler(request);
    await ports.submit({
      kind: "report-observation",
      runId: run.runId,
      commandId: `pinned-workflow-unavailable:${receipt}`,
      condition: "infrastructure-failure",
      reason: "pinned-workflow-unavailable",
    });
    return new Response("pinned-workflow-unavailable", { status: 503 });
  };
}
