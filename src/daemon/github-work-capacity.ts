import { setTimeout as delay } from "node:timers/promises";
import type { Calls } from "./github-calls.ts";
import type { WorkerPort, OperationWork } from "../service/worker-port.ts";
import type { Reported } from "./operation-journal.ts";
import { markedCalls } from "./working-runs.ts";
import { recordedWorkStage, releasedWorkStage } from "./github-work-stage.ts";

type Work = WorkerPort["operationWork"];
type Confirmation = "confirmed" | "released" | "pending";

function rejectedConfirmation(
  reason: string,
  action: OperationWork["action"],
): Confirmation {
  if (reason === "work-stage-released" && action === "enter") return "released";
  if (
    [
      "queue-working-capacity-exceeded",
      "run-work-held",
      "service-busy",
    ].includes(reason)
  )
    return "pending";
  throw new Error("github-operation-stopped");
}

function confirmation(
  receipt: Awaited<ReturnType<Work>> | undefined,
  stage: OperationWork,
): Confirmation {
  if (receipt === undefined) return "pending";
  if (["accepted", "duplicate"].includes(receipt.kind)) return "confirmed";
  return receipt.kind === "rejected"
    ? rejectedConfirmation(receipt.reason, stage.action)
    : "pending";
}

async function confirmed(
  work: Work,
  context: { readonly stage: OperationWork; readonly signal: AbortSignal },
): Promise<"confirmed" | "released"> {
  const { stage, signal } = context;
  for (;;) {
    const result = confirmation(
      await work(stage).catch(() => undefined),
      stage,
    );
    if (result !== "pending") return result;
    await delay(100, undefined, { signal });
  }
}

async function acquired(
  work: Work,
  context: {
    readonly intent: Reported;
    readonly folder: string | undefined;
    readonly signal: AbortSignal;
  },
): Promise<OperationWork> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stage = await recordedWorkStage(context.intent, context.folder);
    if (
      (await confirmed(work, { stage, signal: context.signal })) === "confirmed"
    )
      return stage;
    await releasedWorkStage(stage, context.folder);
  }
  throw new Error("github-operation-stopped");
}

export function capacityCalls(
  calls: Calls,
  stage: {
    readonly intent: Reported & { readonly method?: string };
    readonly signal: AbortSignal;
    readonly work?: Work | undefined;
    readonly folder?: string;
  },
): Calls {
  const { work, intent, signal } = stage;
  const owned =
    stage.folder === undefined ? calls : markedCalls(calls, stage.folder);
  if (work === undefined || intent.method !== "merge") return owned;
  const identity = {
    runId: intent.runId,
    operationId: intent.operationId,
    inputDigest: intent.inputDigest,
    leaseGeneration: intent.leaseGeneration,
  };
  return {
    ...owned,
    run: async (command, directory) => {
      signal.throwIfAborted();
      const entry = await acquired(work, {
        intent: identity,
        folder: stage.folder,
        signal,
      });
      try {
        signal.throwIfAborted();
        return await owned.run(command, directory);
      } finally {
        await confirmed(work, {
          stage: {
            ...entry,
            action: "leave",
            commandId: `${entry.stageId}:leave`,
          },
          signal,
        });
        await releasedWorkStage(entry, stage.folder);
      }
    },
  };
}
