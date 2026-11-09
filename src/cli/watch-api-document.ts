import type { RunStatus } from "../authority/transitions.ts";

export const runStates = [
  "queued",
  "running",
  "waiting_gate",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export const runLimit = {
  type: "integer",
  minimum: 1,
  maximum: 200,
  default: 50,
} as const;

const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const integer = { type: "integer" };
const nullableNumber = { type: ["number", "null"] };
const flag = { type: "boolean" };

function reference(name: string): { readonly $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function closed(properties: Readonly<Record<string, unknown>>) {
  return {
    type: "object",
    required: Object.keys(properties),
    properties,
    additionalProperties: false,
  };
}

function listOf(items: unknown) {
  return { type: "array", items };
}

function json(description: string, schema: unknown) {
  return { description, content: { "application/json": { schema } } };
}

function problem(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: reference("Problem") } },
  };
}

const invalidQuery = problem(
  "A query parameter is unknown, repeated or has an invalid value.",
);
const serviceUnavailable = problem("The Cloving service does not answer.");
const schedulesUnavailable = problem(
  "The Cloving service or its scheduler does not answer.",
);
const unknownRun = problem("The service has no run with this ID.");

const documentSchema = closed({
  openapi: { const: "3.1.1" },
  info: closed({ title: text, version: text }),
  servers: listOf(closed({ url: text })),
  tags: listOf(closed({ name: text, description: text })),
  paths: { type: "object" },
  components: { type: "object" },
});

const indexSchema = closed({
  version: { const: 1 },
  openapi: text,
  endpoints: listOf(
    closed({ method: { const: "GET" }, path: text, operationId: text }),
  ),
});

const runParameters = [
  {
    name: "workflowId",
    in: "query",
    description: "Give only the runs of this workflow.",
    schema: text,
  },
  {
    name: "state",
    in: "query",
    description: "Give only the runs in this state.",
    schema: { type: "string", enum: runStates },
  },
  {
    name: "limit",
    in: "query",
    description: "The maximum number of runs on the page.",
    schema: runLimit,
  },
  {
    name: "cursor",
    in: "query",
    description: "The nextCursor value of the previous page.",
    schema: text,
  },
];

const runId = {
  name: "runId",
  in: "path",
  required: true,
  description: "The ID of the run.",
  schema: text,
};

const after = {
  name: "after",
  in: "query",
  description: "Give only the events with a higher sequence.",
  schema: { type: "integer", minimum: 0, default: 0 },
};

const runSummary = {
  runId: text,
  workflowId: text,
  ticketId: nullableText,
  title: nullableText,
  state: { type: "string", enum: runStates },
  outcome: nullableText,
  currentStep: closed({ name: text, startedAt: nullableText }),
  latestAt: nullableText,
  pullRequest: {
    oneOf: [closed({ number: integer, url: text }), { type: "null" }],
  },
  estimatedCostUsd: nullableNumber,
};

export const watchApiDocument = {
  openapi: "3.1.1",
  info: { title: "Cloving watch API", version: "1.0.0" },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "api", description: "The index and the contract of the API." },
    { name: "service", description: "The state of the Cloving service." },
    { name: "workflows", description: "The workflows of the service." },
    { name: "schedules", description: "The loops of the service." },
    { name: "runs", description: "The runs of the watch page." },
    { name: "stream", description: "The change signals of the runs." },
  ],
  paths: {
    "/": {
      get: {
        operationId: "getApiIndex",
        tags: ["api"],
        summary: "Give the version and the endpoints of the API.",
        responses: {
          "200": json("The index of the API.", indexSchema),
          "400": invalidQuery,
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        tags: ["api"],
        summary: "Give this OpenAPI document.",
        responses: {
          "200": json("The OpenAPI document of the API.", documentSchema),
          "400": invalidQuery,
        },
      },
    },
    "/service": {
      get: {
        operationId: "getService",
        tags: ["service"],
        summary: "Tell if the Cloving service answers.",
        responses: {
          "200": json("The state of the service.", reference("Service")),
          "400": invalidQuery,
        },
      },
    },
    "/workflows": {
      get: {
        operationId: "listWorkflows",
        tags: ["workflows"],
        summary: "Give the workflows of the service and their card fields.",
        responses: {
          "200": json(
            "The workflows of the service.",
            closed({ workflows: listOf(reference("Workflow")) }),
          ),
          "400": invalidQuery,
          "503": serviceUnavailable,
        },
      },
    },
    "/schedules": {
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
          "503": schedulesUnavailable,
        },
      },
    },
    "/runs": {
      get: {
        operationId: "listRuns",
        tags: ["runs"],
        summary:
          "Give the active runs and the runs with an event in the last 7 days, newest first.",
        parameters: runParameters,
        responses: {
          "200": json("One page of runs.", reference("RunPage")),
          "400": invalidQuery,
          "503": serviceUnavailable,
        },
      },
    },
    "/runs/{runId}": {
      get: {
        operationId: "getRun",
        tags: ["runs"],
        summary:
          "Give one run with its phases, open decisions, reviews and agent turns, also when the run is older than 7 days.",
        parameters: [runId],
        responses: {
          "200": json("The run.", closed({ run: reference("RunDetail") })),
          "400": invalidQuery,
          "404": unknownRun,
          "503": serviceUnavailable,
        },
      },
    },
    "/runs/{runId}/events": {
      get: {
        operationId: "listRunEvents",
        tags: ["runs"],
        summary:
          "Give the events of one run after a sequence, the lowest sequence first.",
        parameters: [runId, after],
        responses: {
          "200": json(
            "The events of the run.",
            closed({ events: listOf(reference("Event")) }),
          ),
          "400": invalidQuery,
          "404": unknownRun,
          "503": serviceUnavailable,
        },
      },
    },
    "/stream": {
      get: {
        operationId: "streamChanges",
        tags: ["stream"],
        summary:
          'Send the event change with the data {"updatedAt":"<time>"} at the connection and at each change of a run.',
        responses: {
          "200": {
            description: "Server-Sent Events.",
            content: { "text/event-stream": { schema: text } },
          },
          "400": invalidQuery,
        },
      },
    },
  },
  components: {
    schemas: {
      Service: closed({ up: flag, updatedAt: text }),
      Workflow: closed({
        workflowId: text,
        activeCount: integer,
        waitingCount: integer,
        latestAt: nullableText,
        inputs: listOf(reference("CardField")),
      }),
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
      CardField: closed({
        name: text,
        label: text,
        multiline: flag,
        optional: flag,
      }),
      RunSummary: closed(runSummary),
      RunPage: closed({
        runs: listOf(reference("RunSummary")),
        nextCursor: nullableText,
      }),
      RunDetail: closed({
        ...runSummary,
        code: text,
        detail: text,
        round: integer,
        spent: nullableNumber,
        limit: nullableNumber,
        decisions: listOf(reference("Decision")),
        phases: listOf(reference("Phase")),
        reviews: listOf(reference("Review")),
        mergeCommit: nullableText,
        turns: listOf(reference("Turn")),
      }),
      Decision: closed({ decisionId: text, type: text, prompt: text }),
      Phase: closed({
        name: text,
        state: text,
        startedAt: nullableText,
        endedAt: nullableText,
      }),
      Review: closed({
        round: integer,
        commit: text,
        score: { type: "number" },
      }),
      Turn: closed({
        key: text,
        harness: nullableText,
        startedAt: text,
        endedAt: nullableText,
        outcome: text,
        estimatedCostUsd: nullableNumber,
        summary: text,
      }),
      Event: closed({ sequence: integer, type: text, recordedAt: text }),
      Problem: closed({
        type: text,
        title: text,
        status: integer,
        detail: text,
        code: text,
      }),
    },
  },
};
