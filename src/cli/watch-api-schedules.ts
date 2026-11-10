import {
  closed,
  integer,
  invalidQuery,
  json,
  listOf,
  nullableText,
  problem,
  reference,
  text,
} from "./watch-api-schema.ts";

export const schedulesPath = {
  get: {
    operationId: "listSchedules",
    tags: ["schedules"],
    summary:
      "Give the loops: each schedule with its rule, state, next run, last run and failures in a row.",
    responses: {
      "200": json(
        "The loops of the service.",
        closed({ schedules: listOf(reference("Schedule")) }),
      ),
      "400": invalidQuery,
      "503": problem("The Cloving service or its scheduler does not answer."),
    },
  },
};

export const scheduleSchemas = {
  Schedule: closed({
    workflowId: text,
    rule: text,
    state: { type: "string", enum: ["active", "paused", "stopped"] },
    nextAt: nullableText,
    failuresInRow: integer,
    lastRun: { oneOf: [reference("LoopRun"), { type: "null" }] },
  }),
  LoopRun: closed({
    runId: text,
    state: text,
    outcome: nullableText,
    endedAt: nullableText,
  }),
};
