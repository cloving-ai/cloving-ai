import { send } from "../cli/client.ts";
import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import {
  decisionNotification,
  outcomeNotification,
  scheduleStopNotifications,
  type NotifyEvent,
} from "./notify-message.ts";

async function request(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Fields> {
  const reply = await send(runtimeDirectory, request);
  if (reply.kind === "error") throw new Error(reply.error.code);
  return reply.result;
}

function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) throw new Error("invalid-notify-list");
  return value.map((item: unknown) => {
    const row = record(item);
    if (row === undefined) throw new Error("invalid-notify-row");
    return row;
  });
}

export type OutcomeCache = Map<
  string,
  {
    readonly latestSequence: number;
    readonly event: NotifyEvent | undefined;
  }
>;

async function scheduleNotifications(
  runtimeDirectory: string,
): Promise<readonly NotifyEvent[]> {
  const reply = await send(runtimeDirectory, {
    operation: "schedule",
    parameters: { action: "list" },
  });
  if (reply.kind === "error") {
    if (reply.error.code === "schedules-unavailable") return [];
    throw new Error(reply.error.code);
  }
  return rows(reply.result["schedules"]).flatMap(scheduleStopNotifications);
}

async function observedOutcome(
  summary: Fields,
  source: { readonly runtimeDirectory: string; readonly cache: OutcomeCache },
): Promise<NotifyEvent | undefined> {
  const { runtimeDirectory, cache } = source;
  const latestSequence = summary["latestSequence"];
  if (typeof latestSequence !== "number")
    throw new Error("invalid-notify-sequence");
  const runId = String(summary["runId"]);
  const previous = cache.get(runId);
  if (previous !== undefined && previous.latestSequence === latestSequence)
    return previous.event;
  const status = await request(runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  const run = record(status["run"]);
  if (run === undefined) throw new Error("invalid-notify-status");
  const event = outcomeNotification(run);
  cache.set(runId, { latestSequence, event });
  return event;
}

export async function notificationEvents(
  runtimeDirectory: string,
  cache: OutcomeCache,
): Promise<readonly NotifyEvent[]> {
  const found: NotifyEvent[] = [];
  const runs = new Map<string, Fields>();
  let after: string | null = "";
  do {
    const page = await request(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    for (const summary of rows(page["runs"])) {
      runs.set(String(summary["runId"]), summary);
      const outcome = await observedOutcome(summary, {
        runtimeDirectory,
        cache,
      });
      if (outcome !== undefined) found.push(outcome);
    }
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-notify-page");
    after = next;
  } while (after !== null);
  const questions = await request(runtimeDirectory, {
    operation: "questions",
    parameters: {},
  });
  for (const decision of rows(questions["decisions"])) {
    const run = runs.get(String(decision["runId"]));
    if (run !== undefined) found.push(decisionNotification(run, decision));
  }
  return [...found, ...(await scheduleNotifications(runtimeDirectory))];
}
